// Chaos 存储层不变量测试：双时态 / 引文门 / 值支撑门 / 合并代数 / 保真度。
import test from 'node:test'
import assert from 'node:assert/strict'

import { openDb } from '../src/db.js'
import { appendEvent, applyCorrection, currentClaims, ingestClaim } from '../src/store.js'

function cand(o) {
  return {
    kind: 'fact',
    confidence: 0.9,
    sourcePriority: 100,
    validFrom: 0,
    extractor: 'test',
    ...o,
  }
}

test('C1 伪造引文被拒', () => {
  const db = openDb(':memory:')
  const e = appendEvent(db, 10, 'turn.user', 'user', '我养了一只猫叫团子')
  const rc = ingestClaim(
    db,
    cand({ slot: 'user.pet.name', value: '团子', quote: '我养了一只狗叫团子', evidence: [e], validFrom: 10 }),
    10
  )
  assert.equal(rc, 'rejected')
  assert.equal(currentClaims(db).length, 0)
})

test('C2 值不在引文中被拒（wrong 拦截）', () => {
  const db = openDb(':memory:')
  const e = appendEvent(db, 10, 'turn.user', 'user', '我养了一只猫叫团子')
  const rc = ingestClaim(
    db,
    cand({ slot: 'user.pet.name', value: '小白', quote: '我养了一只猫叫团子', evidence: [e], validFrom: 10 }),
    10
  )
  assert.equal(rc, 'rejected')
})

test('C3 合法写入', () => {
  const db = openDb(':memory:')
  const e = appendEvent(db, 10, 'turn.user', 'user', '我只喝美式不加糖')
  const rc = ingestClaim(
    db,
    cand({ slot: 'user.coffee', value: '美式不加糖', quote: '我只喝美式不加糖', evidence: [e], validFrom: 10 }),
    10
  )
  assert.equal(rc, 'inserted')
  assert.equal(currentClaims(db).length, 1)
  const c = currentClaims(db)[0]
  assert.equal(c.fidelity_user, 1)
  assert.equal(c.fidelity_ai, 1)
})

test('C4 改口 supersede，旧值 tx_to 置位，当前视图只剩新值', () => {
  const db = openDb(':memory:')
  const e1 = appendEvent(db, 10, 'turn.user', 'user', '我只喝美式不加糖')
  const e2 = appendEvent(db, 20, 'turn.user', 'user', '其实我现在改成喝拿铁了')
  ingestClaim(db, cand({ slot: 'user.coffee', value: '美式不加糖', quote: '我只喝美式不加糖', evidence: [e1], sourcePriority: 60, confidence: 0.7, validFrom: 10 }), 10)
  const rc = ingestClaim(db, cand({ slot: 'user.coffee', value: '拿铁', quote: '其实我现在改成喝拿铁了', evidence: [e2], validFrom: 20 }), 20)

  assert.equal(rc, 'superseded')
  const cur = currentClaims(db)
  assert.equal(cur.length, 1)
  assert.equal(cur[0].value, '拿铁')
  const old = db.prepare("SELECT tx_to, superseded_by FROM claim WHERE value='美式不加糖'").get()
  assert.notEqual(old.tx_to, null)
  assert.notEqual(old.superseded_by, null)
})

test('C5 平局进 deferred，不进当前视图', () => {
  const db = openDb(':memory:')
  const e1 = appendEvent(db, 10, 'turn.user', 'user', '我住北京')
  const e2 = appendEvent(db, 11, 'turn.user', 'user', '我住上海')
  ingestClaim(db, cand({ slot: 'user.city', value: '北京', quote: '我住北京', evidence: [e1], validFrom: 0 }), 10)
  const rc = ingestClaim(db, cand({ slot: 'user.city', value: '上海', quote: '我住上海', evidence: [e2], validFrom: 0 }), 10)
  assert.equal(rc, 'deferred')
  assert.equal(currentClaims(db).length, 1)
  assert.equal(currentClaims(db)[0].value, '北京')
})

test('C6 不同事件的同值陈述构成互证', () => {
  const db = openDb(':memory:')
  const e1 = appendEvent(db, 10, 'turn.user', 'user', '我养了一只猫叫团子')
  const e2 = appendEvent(db, 20, 'turn.user', 'user', '团子今天特别黏人')
  ingestClaim(db, cand({ slot: 'user.pet.name', value: '团子', quote: '我养了一只猫叫团子', evidence: [e1], confidence: 0.7 }), 10)
  const rc = ingestClaim(db, cand({ slot: 'user.pet.name', value: '团子', quote: '团子今天特别黏人', evidence: [e2], confidence: 0.7 }), 20)
  assert.equal(rc, 'corroborated')
  const row = db.prepare("SELECT confidence, corroboration FROM claim WHERE slot='user.pet.name'").get()
  assert.equal(row.corroboration, 1)
  assert.ok(row.confidence > 0.7)
})

test('C7 用户纠正只降 AI 侧保真度', () => {
  const db = openDb(':memory:')
  const e = appendEvent(db, 10, 'turn.user', 'user', '我只喝美式不加糖')
  ingestClaim(db, cand({ slot: 'user.coffee', value: '美式不加糖', quote: '我只喝美式不加糖', evidence: [e], validFrom: 10 }), 10)
  const id = currentClaims(db)[0].id
  applyCorrection(db, id, 0.25)
  const c = currentClaims(db)[0]
  assert.equal(c.fidelity_user, 1)
  assert.ok(c.fidelity_ai < 1)
})
