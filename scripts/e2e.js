#!/usr/bin/env node
// 端到端：真实模型抽取 → 门禁 → 入库 → 自然问句检索。
// 密钥只从环境变量读。
// 用法：DEEPSEEK_API_KEY=... node scripts/e2e.js
import { readFileSync } from 'node:fs'

import { openDb } from '../src/db.js'
import { appendEvent, currentClaims, ingestClaim } from '../src/store.js'
import { buildPrompt, parseCandidates } from '../src/extract-llm.js'
import { assemble, render } from '../src/potential.js'

const KEY = process.env.DEEPSEEK_API_KEY
if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

const SLOTS = [
  'user.pet.name', 'user.pet.trait', 'user.job', 'user.city', 'user.sleep',
  'user.coffee', 'user.tea', 'user.fear', 'user.hate', 'user.hand',
  'user.birthday', 'user.mother', 'user.friend', 'user.dream', 'user.window',
  'user.habit', 'user.body', 'user.ex',
]

// 评测问句：真实用户会怎么问（不含槽位名）
const PROBES = {
  'user.pet.name': '我那只猫叫什么来着',
  'user.job': '我是做什么工作的',
  'user.city': '我住在哪个城市',
  'user.sleep': '我一般几点睡',
  'user.coffee': '我咖啡是怎么喝的',
  'user.friend': '我那个朋友叫什么',
  'user.birthday': '我生日是哪天',
  'user.fear': '我最怕的是什么',
  'user.hand': '我手腕怎么样了',
  'user.habit': '我画画的时候要开着什么',
}

async function callModel(prompt, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(45000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      return j.choices[0].message.content
    } catch (e) {
      if (i === retries) throw e
    }
  }
}

async function main() {
  const gt = JSON.parse(
    readFileSync(new URL('../../data/ground_truth.json', import.meta.url), 'utf8')
  )
  const db = openDb(':memory:')
  let clock = 0
  const ins = db.prepare('INSERT INTO event(ts, kind, actor, payload) VALUES (?,?,?,?)')

  const stat = { tried: 0, ok: 0, fail: 0, cands: 0, inserted: 0, rejected: 0, deferred: 0 }

  for (const f of gt.facts) {
    const text = f.quote
    stat.tried++
    let raw
    try {
      raw = await callModel(buildPrompt(text, SLOTS))
    } catch {
      stat.fail++
      continue
    }
    stat.ok++
    clock += 1000
    const eid = Number(ins.run(clock * 1000, 'turn.user', 'user', text).lastInsertRowid)
    for (const c of parseCandidates(raw, text, SLOTS)) {
      stat.cands++
      const rc = ingestClaim(db, {
        slot: c.slot, value: c.value, quote: c.quote,
        evidence: [eid], validFrom: clock, kind: c.kind,
        sourceText: text, confidence: 0.85, sourcePriority: 90,
      }, clock)
      stat[rc] = (stat[rc] ?? 0) + 1
    }
  }

  const live = currentClaims(db)
  console.log('=== 抽取与入库 ===')
  console.log(`调用 ${stat.tried} 次 | 成功 ${stat.ok} | 失败 ${stat.fail}`)
  console.log(`候选 ${stat.cands} | inserted ${stat.inserted} | rejected ${stat.rejected} | deferred ${stat.deferred}`)
  console.log(`当前主张 ${live.length} 条`)

  console.log('\n=== 检索闭环（自然问句 → 能否取回）===')
  let hit = 0, total = 0
  for (const [slot, q] of Object.entries(PROBES)) {
    const want = live.find((c) => c.slot === slot)
    if (!want) {
      console.log(`  [无此槽位] ${q}`)
      continue
    }
    total++
    const pack = assemble(db, q, clock, 200)
    const got = pack.find((it) => it.slot === slot)
    const rank = pack.findIndex((it) => it.slot === slot) + 1
    if (got) {
      const ok = got.value === want.value
      if (ok) hit++
      console.log(`  ${ok ? '✓' : '✗'} 问「${q}」→ 第${rank}位 ${got.slot}=${got.value}`)
    } else {
      console.log(`  ✗ 问「${q}」→ 未召回（库里有 ${slot}=${want.value}）`)
    }
  }
  console.log(`\n召回 ${hit}/${total}`)

  console.log('\n=== 一次完整注入块 ===')
  console.log(render(assemble(db, '我那只猫叫什么来着', clock, 200)))
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
