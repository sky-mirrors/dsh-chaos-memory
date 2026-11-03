#!/usr/bin/env node
// 系统性验证：规模性能 / 注入预算 / 势能涌现 / 确定性 / 双时态。
// 不调用任何外部 API，全部本地可复现。
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openDb } from '../src/db.js'
import { appendEvent, currentClaims, ingestClaim, statusSummary } from '../src/store.js'
import { extract } from '../src/extract.js'
import { assemble } from '../src/potential.js'
import { decayFidelity, divergence, negotiable, negotiationLine } from '../src/fidelity.js'

const dbPath = join(tmpdir(), `chaos-verify-${Date.now()}.db`)
const db = openDb(dbPath)

// ---------- 1. 规模与入库 ----------
const t0 = Date.now()
const lines = readFileSync(new URL('../../data/dialogue.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean)
const ins = db.prepare('INSERT INTO event(ts, kind, actor, payload) VALUES (?,?,?,?)')
let clock = 0
let candidates = 0
const codes = {}
const pending = []

// 事件批量入库走一个事务；主张写入必须留到事务外——ingestClaim 自带
// BEGIN IMMEDIATE，套在外层事务里会 "cannot start a transaction within a transaction"。
db.exec('BEGIN')
for (const line of lines) {
  const m = JSON.parse(line)
  if (m.from !== 'user') continue
  const ms = Date.parse(m.ts)
  clock = Math.max(clock, Math.floor(ms / 1000))
  const eid = Number(ins.run(ms, 'turn.user', 'user', m.text).lastInsertRowid)
  for (const c of extract(m.text)) pending.push({ c, eid, sourceText: m.text })
}
db.exec('COMMIT')

for (const { c, eid, sourceText } of pending) {
  candidates++
  const rc = ingestClaim(db, {
    slot: c.slot, value: c.value, quote: c.quote,
    evidence: [eid], validFrom: clock, kind: c.kind,
    sourceText, confidence: 0.9, sourcePriority: 100,
  }, clock)
  codes[rc] = (codes[rc] ?? 0) + 1
}
const ingestMs = Date.now() - t0
const live = currentClaims(db)

console.log('=== 1. 规模与入库 ===')
console.log(`消息 ${lines.length} 条（user ${Math.floor(lines.length / 2)} 条）`)
console.log(`入库耗时 ${ingestMs} ms | 候选 ${candidates} 条 | ${JSON.stringify(codes)}`)
console.log(`当前主张 ${live.length} 条`)

// ---------- 2. 检索延迟 ----------
const queries = ['我那只猫叫什么', '今天好累', '我一般几点睡', '在干嘛', '我咖啡怎么喝的',
  '你还记得我生日吗', '外面下雨了', '我那个朋友叫什么', '睡不着', '我想开一家书店']
const lat = []
for (let i = 0; i < 200; i++) {
  const q = queries[i % queries.length]
  const t = process.hrtime.bigint()
  assemble(db, q, clock, 200)
  lat.push(Number(process.hrtime.bigint() - t) / 1e6)
}
lat.sort((a, b) => a - b)
const pick = (p) => lat[Math.floor(lat.length * p)].toFixed(2)
console.log('\n=== 2. 检索延迟（200 次 assemble）===')
console.log(`P50 ${pick(0.5)} ms | P95 ${pick(0.95)} ms | Max ${lat[lat.length - 1].toFixed(2)} ms`)

// ---------- 3. 注入预算 ----------
let over = 0
let maxLen = 0
for (const q of queries) {
  const pack = assemble(db, q, clock, 200)
  const cost = pack.reduce((s, it) => s + it.slot.length + it.value.length + 3, 0)
  maxLen = Math.max(maxLen, cost)
  if (cost > 200) over++
}
console.log('\n=== 3. 注入预算（budget=200 字符）===')
console.log(`实测最大占用 ${maxLen} 字符 | 超限次数 ${over}/10`)

// ---------- 4. 势能涌现 ----------
console.log('\n=== 4. 势能涌现（闲聊 query 下承诺是否优先）===')
const lastTurn = clock
for (const q of ['今天好累', '嗯', '有点无聊']) {
  const pack = assemble(db, q, lastTurn, 200)
  const top = pack[0]
  console.log(`  问「${q}」→ 首位 ${top ? `${top.slot} = ${String(top.value).slice(0, 22)}` : '(空)'}`
    + `  ${top && top.slot.startsWith('promise.') ? '← 承诺优先' : ''}`)
}
const promCount = live.filter((c) => c.kind === 'commitment').length
console.log(`  库中承诺 ${promCount} 条`)

// ---------- 5. 确定性 ----------
const a1 = JSON.stringify(assemble(db, '我那只猫叫什么', lastTurn, 200))
const a2 = JSON.stringify(assemble(db, '我那只猫叫什么', lastTurn, 200))
const a3 = JSON.stringify(assemble(db, '我那只猫叫什么', lastTurn, 200))
console.log('\n=== 5. 确定性 ===')
console.log(`同一输入三次结果一致: ${a1 === a2 && a2 === a3 ? 'YES' : 'NO'}`)

// ---------- 6. 双时态与保真度 ----------
const s = statusSummary(db)
console.log('\n=== 6. 双时态与保真度 ===')
console.log(`主张状态分布 ${JSON.stringify(s.byState)}`)
const superseded = db.prepare(
  "SELECT slot, value, tx_to, superseded_by FROM claim WHERE tx_to IS NOT NULL"
).all()
console.log(`已关闭 tx_to 的旧值 ${superseded.length} 条`)
for (const r of superseded.slice(0, 4)) {
  console.log(`  ${r.slot}: ${r.value} → 被 ${r.superseded_by} 取代`)
}
decayFidelity(db, lastTurn, 100, 0.3)
const neg = negotiable(db, 0.2)
console.log(`衰减后保真度背离超阈值 ${neg.length} 条`)
if (neg.length) console.log(`  例：${negotiationLine(neg[0])}`)

db.close()
rmSync(dbPath, { force: true })
