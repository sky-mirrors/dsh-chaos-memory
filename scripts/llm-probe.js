#!/usr/bin/env node
// 真实模型抽取探针：用 deepseek-flash 跑一轮，统计空返回率、格式遵守率、抽取准召。
// 密钥只从环境变量读，不落盘、不进代码。
// 用法：DEEPSEEK_API_KEY=... node scripts/llm-probe.js [样本数]
import { readFileSync } from 'node:fs'

import { buildPrompt, parseCandidates } from '../src/extract-llm.js'

const KEY = process.env.DEEPSEEK_API_KEY
if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY 环境变量')
  process.exit(1)
}

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
const SLOTS = [
  'user.pet.name', 'user.pet.trait', 'user.job', 'user.city', 'user.sleep',
  'user.coffee', 'user.tea', 'user.fear', 'user.hate', 'user.hand',
  'user.birthday', 'user.mother', 'user.friend', 'user.dream', 'user.window',
  'user.habit', 'user.body', 'user.ex',
]

async function callModel(prompt) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  return j.choices[0].message.content
}

function loadSamples(n) {
  const rows = readFileSync(new URL('../../data/dialogue.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).slice(0, 20000)
    .map((l) => JSON.parse(l))
    .filter((m) => m.from === 'user')

  const gt = JSON.parse(
    readFileSync(new URL('../../data/ground_truth.json', import.meta.url), 'utf8')
  )
  // 正样本：ground_truth 里的原句
  const positives = gt.facts.map((f) => f.quote)
  // 负样本：不含事实原句的闲聊
  const posSet = new Set(positives)
  const negatives = rows
    .map((m) => m.text)
    .filter((t) => !posSet.has(t) && t.length > 3)
    .slice(0, n)

  return { positives, negatives }
}

function looksWrapped(raw) {
  return /^\s*```/.test(raw)
}

async function main() {
  const n = Number(process.argv[2] ?? 10)
  const { positives, negatives } = loadSamples(n)

  const stat = {
    total: 0, httpFail: 0, parseFail: 0, wrapped: 0,
    posHit: 0, posTotal: 0, negHit: 0, negTotal: 0, candidates: 0,
  }
  const detail = []

  const run = async (text, expectHit) => {
    stat.total++
    let raw
    try {
      raw = await callModel(buildPrompt(text, SLOTS))
    } catch (e) {
      stat.httpFail++
      detail.push({ text, err: String(e).slice(0, 80) })
      return
    }
    if (looksWrapped(raw)) stat.wrapped++
    let cands
    try {
      cands = parseCandidates(raw, text, SLOTS)
    } catch {
      stat.parseFail++
      return
    }
    if (cands.length === 0 && raw.trim() !== '[]') stat.parseFail++
    stat.candidates += cands.length
    if (expectHit) {
      stat.posTotal++
      if (cands.length > 0) stat.posHit++
    } else {
      stat.negTotal++
      if (cands.length > 0) stat.negHit++
    }
    detail.push({
      text: text.slice(0, 30),
      raw: raw.slice(0, 60),
      got: cands.map((c) => `${c.slot}=${c.value}`),
    })
  }

  for (const t of positives) await run(t, true)
  for (const t of negatives) await run(t, false)

  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a')
  console.log(`模型 ${MODEL} | 样本 ${stat.total}`)
  console.log(`HTTP 失败 ${stat.httpFail} | 解析失败 ${stat.parseFail} | markdown 包裹 ${stat.wrapped}`)
  console.log(`正样本命中 ${stat.posHit}/${stat.posTotal} (${pct(stat.posHit, stat.posTotal)})`)
  console.log(`负样本误抽 ${stat.negHit}/${stat.negTotal} (${pct(stat.negHit, stat.negTotal)})`)
  console.log(`候选总数 ${stat.candidates}`)
  console.log('--- 明细前 8 条 ---')
  for (const d of detail.slice(0, 8)) {
    console.log(`原文: ${d.text}`)
    if (d.err) console.log(`  错误: ${d.err}`)
    else {
      console.log(`  原始: ${String(d.raw).replace(/\n/g, ' ')}`)
      console.log(`  抽取: ${d.got.join(' | ') || '(空)'}`)
    }
  }
}

main().then(() => process.exit(0))
