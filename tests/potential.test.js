// Chaos 检索与装配测试：BM25 / 线程派生 / Φ / 确定性 / 持久化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openDb } from '../src/db.js'
import { appendEvent, ingestClaim, currentClaims } from '../src/store.js'
import { bm25Ranked } from '../src/retrieval.js'
import { assemble, deriveThreads, phiFromR } from '../src/potential.js'

function cand(o) {
  return { kind: 'fact', confidence: 0.9, sourcePriority: 100, validFrom: 0, extractor: 'test', ...o }
}

test('P1 BM25 把相关文档排第一', () => {
  const docs = [
    'user.pet.name 团子 我养了一只猫叫团子',
    'user.city 杭州 我在杭州住了六年',
    'user.coffee 美式不加糖 我只喝美式不加糖',
  ]
  assert.equal(bm25Ranked('我那只猫叫什么', docs)[0], 0)
  assert.equal(bm25Ranked('我住在哪个城市', docs)[0], 1)
  assert.equal(bm25Ranked('我咖啡怎么喝', docs)[0], 2)
})

test('P2 承诺线程派生且压力随时间上升', () => {
  const db = openDb(':memory:')
  const e = appendEvent(db, 10, 'turn.user', 'user', '说好了陪你看店铺')
  ingestClaim(db, cand({ slot: 'promise.bookstore', value: '陪你看店铺', quote: '说好了陪你看店铺', evidence: [e], kind: 'commitment', validFrom: 10 }), 10)

  const early = deriveThreads(db, 20)['promise.bookstore']
  const late = deriveThreads(db, 300)['promise.bookstore']
  assert.equal(early.kind, 'promise')
  assert.ok(late.pressure > early.pressure)
  assert.ok(late.pressure <= 1)
})

test('P3 保真度低则 Φ 低', () => {
  const c1 = { slot: 'a', value: 'v', quote: 'q', tx_from: 10, id: 'c1', fidelity_ai: 1 }
  const c2 = { slot: 'a', value: 'v', quote: 'q', tx_from: 10, id: 'c1', fidelity_ai: 0.2 }
  assert.ok(phiFromR(0.5, c1, 100, {}) > phiFromR(0.5, c2, 100, {}))
})

test('P4 装配确定性：同输入两次结果相同', () => {
  const db = openDb(':memory:')
  const e1 = appendEvent(db, 10, 'turn.user', 'user', '我只喝美式不加糖')
  const e2 = appendEvent(db, 12, 'turn.user', 'user', '我在杭州住了六年')
  ingestClaim(db, cand({ slot: 'user.coffee', value: '美式不加糖', quote: '我只喝美式不加糖', evidence: [e1], validFrom: 10 }), 10)
  ingestClaim(db, cand({ slot: 'user.city', value: '杭州', quote: '我在杭州住了六年', evidence: [e2], validFrom: 12 }), 12)

  const a = assemble(db, '我咖啡怎么喝', 100, 200)
  const b = assemble(db, '我咖啡怎么喝', 100, 200)
  assert.deepEqual(a, b)
  assert.equal(a[0].slot, 'user.coffee')
})

test('P5 持久化：关闭重开数据仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-'))
  const path = join(dir, 'chaos.db')
  try {
    const db1 = openDb(path)
    const e = appendEvent(db1, 10, 'turn.user', 'user', '我只喝美式不加糖')
    ingestClaim(db1, cand({ slot: 'user.coffee', value: '美式不加糖', quote: '我只喝美式不加糖', evidence: [e], validFrom: 10 }), 10)
    db1.close()

    const db2 = openDb(path)
    assert.equal(currentClaims(db2).length, 1)
    db2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P8 已注入过的条目降权，把位置让给还没露过面的', () => {
  const db = openDb(':memory:')
  const src = '说好了陪你看店，我养了一只猫叫团子'
  const eid = appendEvent(db, 1, 'turn.user', 'user', src)
  ingestClaim(
    db,
    cand({ slot: 'promise.shop', value: '陪你看店', quote: '说好了陪你看店', kind: 'commitment', evidence: [eid], validFrom: 1, sourceText: src }),
    1
  )
  ingestClaim(
    db,
    cand({ slot: 'user.pet.name', value: '团子', quote: '叫团子', evidence: [eid], validFrom: 1, sourceText: src }),
    1
  )

  const first = assemble(db, '', 10, 200)
  assert.equal(first.length, 2, '两条短记忆都该装得下')

  const second = assemble(db, '', 10, 200, new Map([[first[0].id, 1]]))
  assert.notEqual(second[0].id, first[0].id, '已注入过的那条要让位')
})

test('P9 assemble 把注入的每条主张写进 assembly_log', () => {
  const db = openDb(':memory:')
  const src = '我养了一只猫叫团子'
  const e = appendEvent(db, 10, 'turn.user', 'user', src)
  ingestClaim(db, cand({ slot: 'user.pet.name', value: '团子', quote: src, evidence: [e], validFrom: 10, sourceText: src }), 10)

  const out = assemble(db, '', 20, 200)
  assert.equal(out.length, 1)

  const rows = db.prepare('SELECT * FROM assembly_log').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].claim_id, out[0].id)
  assert.equal(rows[0].reason, 'emergence')
  assert.equal(Number(rows[0].turn_id), 20)
  assert.match(rows[0].packet_hash, /^[0-9a-f]{12}$/)

  assemble(db, '我那只猫叫什么', 21, 200)
  const hit = db.prepare('SELECT reason FROM assembly_log WHERE turn_id=21').get()
  assert.equal(hit.reason, 'retrieval')
})
