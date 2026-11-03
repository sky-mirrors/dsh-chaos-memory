// 周期共振 β·C / 关系张力 δ·T / 三类线程
import test from 'node:test'
import assert from 'node:assert/strict'

import { openDb } from '../src/db.js'
import { appendEvent, ingestClaim } from '../src/store.js'
import {
  cycleMatch, deriveThreads, phiFromR, relationalTension,
} from '../src/potential.js'

const DAY = 86400
const T_ANNIV = Math.floor(new Date(2026, 2, 17, 21, 0).getTime() / 1000)   // 3/17
const T_SAME_MONTH = Math.floor(new Date(2026, 2, 5, 15, 0).getTime() / 1000)
const T_OTHER = Math.floor(new Date(2026, 7, 9, 10, 0).getTime() / 1000)

test('C1 同月同日（周年）→ 满分', () => {
  assert.equal(cycleMatch(T_ANNIV, T_ANNIV + 2 * 3600), 1)
})

test('C2 同月不同日 → 次高', () => {
  assert.ok(cycleMatch(T_ANNIV, T_SAME_MONTH) >= 0.5)
  assert.ok(cycleMatch(T_ANNIV, T_SAME_MONTH) < 1)
})

test('C3 既不同月也不同日 → 低或零', () => {
  assert.ok(cycleMatch(T_ANNIV, T_OTHER) <= 0.4)
})

test('C4 时间戳缺失时不影响（返回 0）', () => {
  assert.equal(cycleMatch(0, T_ANNIV), 0)
  assert.equal(cycleMatch(T_ANNIV, 0), 0)
})

test('T1 无 grievance 时张力为 0', () => {
  assert.equal(relationalTension({ slot: 'user.x', tx_from: T_ANNIV }, {}), 0)
})

test('T2 有未闭合 grievance 时张力非零', () => {
  const threads = { 'grievance.abc': { kind: 'grievance', pressure: 0.8, state: 'open' } }
  const t = relationalTension({ slot: 'user.x', tx_from: T_ANNIV }, threads)
  assert.ok(t > 0)
  assert.ok(t <= 1)
})

test('T3 张力提升 Φ', () => {
  const claim = {
    slot: 'user.x', value: 'v', quote: 'q',
    tx_from: T_ANNIV, valid_from: T_ANNIV, id: 'c1', fidelity_ai: 1,
  }
  const calm = phiFromR(0, claim, T_ANNIV, {})
  const tense = phiFromR(0, claim, T_ANNIV, {
    'grievance.abc': { kind: 'grievance', pressure: 0.9, state: 'open' },
  })
  assert.ok(tense > calm)
})

test('TH1 grievance / unanswered 线程可从 claim 派生', () => {
  const db = openDb(':memory:')
  const e1 = appendEvent(db, 1, 'turn.user', 'user', '算了，不想说了')
  const e2 = appendEvent(db, 2, 'turn.user', 'user', '你还记得我生日吗')
  ingestClaim(db, {
    slot: 'grievance.h1', value: '算了，不想说了', quote: '算了，不想说了',
    evidence: [e1], validFrom: T_ANNIV, kind: 'grievance',
    sourceText: '算了，不想说了', confidence: 0.8, sourcePriority: 80,
  }, T_ANNIV)
  ingestClaim(db, {
    slot: 'unanswered.q1', value: '你还记得我生日吗', quote: '你还记得我生日吗',
    evidence: [e2], validFrom: T_ANNIV + 10, kind: 'question',
    sourceText: '你还记得我生日吗', confidence: 0.7, sourcePriority: 80,
  }, T_ANNIV + 10)

  const th = deriveThreads(db, T_ANNIV + 3600)
  assert.equal(th['grievance.h1'].kind, 'grievance')
  assert.equal(th['unanswered.q1'].kind, 'unanswered')
  assert.ok(th['grievance.h1'].pressure > 0)
})

test('TH2 三类线程互不混淆', () => {
  const db = openDb(':memory:')
  const e = appendEvent(db, 1, 'turn.user', 'user', '说好了陪你看店铺')
  ingestClaim(db, {
    slot: 'promise.x', value: '陪你看店铺', quote: '说好了陪你看店铺',
    evidence: [e], validFrom: T_ANNIV, kind: 'commitment',
    sourceText: '说好了陪你看店铺', confidence: 0.8, sourcePriority: 80,
  }, T_ANNIV)
  const th = deriveThreads(db, T_ANNIV + 100)
  assert.equal(th['promise.x'].kind, 'promise')
})
