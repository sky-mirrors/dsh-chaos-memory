#!/usr/bin/env node
// 用真实聊天记录驱动 Chaos：逐条抽取 → 过门禁 → 入库，并统计各环节数据。
// 用法：node scripts/ingest.js <dialogue.jsonl> <db路径> [最大条数]
import { readFileSync } from 'node:fs'

import { openDb } from '../src/db.js'
import { appendEvent, currentClaims, ingestClaim } from '../src/store.js'
import { extract } from '../src/extract.js'

const [, , src, dbPath, limitArg] = process.argv
if (!src || !dbPath) {
  console.error('用法: node scripts/ingest.js <dialogue.jsonl> <db> [最大条数]')
  process.exit(1)
}
const limit = limitArg ? Number(limitArg) : Infinity

const db = openDb(dbPath)
const lines = readFileSync(src, 'utf8').split('\n').filter(Boolean)

const stat = {
  lines: 0, user: 0, candidates: 0,
  inserted: 0, superseded: 0, corroborated: 0,
  deferred: 0, duplicate: 0, rejected: 0,
}
let clock = 0

const ins = db.prepare(
  `INSERT INTO event(ts, kind, actor, payload) VALUES (?,?,?,?)`
)

for (const line of lines) {
  if (stat.lines >= limit) break
  stat.lines++
  const m = JSON.parse(line)
  if (m.from !== 'user') continue
  stat.user++

  const tsMs = Date.parse(m.ts)
  clock = Math.max(clock, Math.floor(tsMs / 1000))
  const eid = Number(ins.run(tsMs, 'turn.user', 'user', m.text).lastInsertRowid)

  for (const c of extract(m.text)) {
    stat.candidates++
    const rc = ingestClaim(
      db,
      {
        slot: c.slot, value: c.value, quote: c.quote,
        evidence: [eid], validFrom: clock, kind: c.kind,
        sourceText: m.text,
        confidence: 0.9, sourcePriority: 100,
      },
      clock
    )
    stat[rc] = (stat[rc] ?? 0) + 1
    if (rc !== 'inserted') {
      console.log(`  [${rc}] ${c.slot} = ${c.value}`)
    }
  }
}

const live = currentClaims(db)
console.log('=== 灌入统计 ===')
console.log(`读取消息 ${stat.lines} 条（其中 user ${stat.user} 条）`)
console.log(`抽取候选 ${stat.candidates} 条`)
console.log(`入库明细 inserted=${stat.inserted} superseded=${stat.superseded} `
  + `corroborated=${stat.corroborated} deferred=${stat.deferred} `
  + `duplicate=${stat.duplicate} rejected=${stat.rejected}`)
console.log(`当前视图 ${live.length} 条主张`)
console.log('=== 当前主张 ===')
for (const c of live.slice(0, 40)) {
  console.log(`  ${c.slot.padEnd(22)} ${String(c.value).slice(0, 24)}  `
    + `conf=${c.confidence.toFixed(2)} corr=${c.corroboration}`)
}
const slots = new Map()
for (const c of live) slots.set(c.slot, (slots.get(c.slot) ?? 0) + 1)
const dup = [...slots.entries()].filter(([, n]) => n > 1)
if (dup.length) console.log('!!! 同槽位多 active：', dup)
else console.log('同槽位唯一性：OK（无重复 active）')
