#!/usr/bin/env node
// unspoken 检测器：训练集 + 留出集两份结果。
// 训练集是本轮调正则时看过的；留出集没有任何一条参与调参，才说明泛化。
// 默认规则版（零成本兜底）；--llm 走 LLM 抽取器的判断项（每条一次模型调用）。
import { extractTurn } from '../src/extract.js'
import { extractLLM } from '../src/extract-llm.js'

const SETS = {
  训练集: {
    pos: [
      '有件事不知道该不该说', '不知道该不该跟你讲这件事', '有件事想告诉你，但是……算了吧',
      '我想说但怕你多想', '有些话到嘴边又咽下去了', '其实我一直没敢说',
      '有句话我憋了很久', '我想说点什么，但是不知道从哪开始', '算了，没什么，本来想说的',
      '有件事我一直没说', '要不要跟你说呢，我犹豫了很久', '我想说，可是又觉得没必要',
    ],
    neg: [
      '有件事我要说清楚', '我想说，其实我很喜欢你', '算了，我说吧', '没什么不能说的',
      '我直说吧，今天辞职了', '有件事想告诉你，就是我今天辞职了', '我问你一个问题',
      '我想说声谢谢', '不知道你怎么想', '有件事不知道该不该问', '说说你的想法', '我没什么想说的',
    ],
  },
  留出集: {
    pos: [
      '我不太确定这话该不该讲', '一直没跟你提这件事', '有些话我一直咽着',
      '想问你个事，又怕你介意', '算了不说了，说了也没用', '有件事压在心里很久了',
      '我想跟你说点什么，又咽回去了', '你问吧，其实我有点不敢答', '这话说出来你会不会生气',
      '有件事，我犹豫要不要告诉你',
    ],
    neg: [
      '我不太确定这话该不该讲，但我还是说吧', '一直没跟你提这件事，今天说了',
      '我想问你个事', '说了也没用，但我还是要说', '压在心里很久，今天终于说了',
      '有件事我提一下', '我不太确定这话对不对', '我一直觉得这件事没问题',
      '有些话说开了挺好', '我想跟你说声谢谢',
    ],
  },
}

const useLLM = process.argv.includes('--llm')
const KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

// fact 槽位白名单与生产一致——判断项混在生产 prompt 里测，才是真实分布。
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

async function hit(text) {
  if (!useLLM) return extractTurn(text, '嗯').some((c) => c.kind === 'unspoken')
  const cands = await extractLLM(text, { callModel, slots: SLOTS })
  return cands.some((c) => c.kind === 'unspoken')
}

async function evaluate(name, { pos, neg }) {
  const posRes = []
  for (const t of pos) posRes.push([t, await hit(t)])
  const negRes = []
  for (const t of neg) negRes.push([t, await hit(t)])

  let tp = 0, fn = 0, fp = 0, tn = 0
  for (const [, h] of posRes) h ? tp++ : fn++
  for (const [, h] of negRes) h ? fp++ : tn++
  const p = tp + fp ? tp / (tp + fp) : 0
  const r = tp + fn ? tp / (tp + fn) : 0
  const f1 = p + r ? (2 * p * r) / (p + r) : 0
  console.log(`\n=== ${name}（正 ${pos.length} / 负 ${neg.length}）===`)
  console.log(`TP=${tp} FN=${fn} FP=${fp} TN=${tn}`)
  console.log(`精确率 ${(p * 100).toFixed(1)}%  召回率 ${(r * 100).toFixed(1)}%  F1 ${(f1 * 100).toFixed(1)}%`)
  for (const [t, h] of posRes) console.log(`  正 ${h ? '✓' : '✗漏'}  ${t}`)
  for (const [t, h] of negRes) console.log(`  负 ${h ? '✗误' : '✓'}  ${t}`)
  return { p, r, f1 }
}

if (useLLM && !KEY) {
  console.error('缺少 DEEPSEEK_API_KEY 环境变量——--llm 模式无法运行（规则版不需要密钥）')
  process.exit(1)
}

console.log(useLLM ? `模式：LLM ${MODEL}（每条一次调用）` : '模式：规则版（零成本）')
for (const [name, set] of Object.entries(SETS)) await evaluate(name, set)

console.log('\n训练集参与过正则调参，100% 是拟合结果；留出集才反映真实泛化能力。')
