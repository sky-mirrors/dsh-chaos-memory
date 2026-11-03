// 写入闸门测试：体积 / 编码 / 凭据。
import test from 'node:test'
import assert from 'node:assert/strict'

import { openDb } from '../src/db.js'
import { appendEvent, ingestClaim, currentClaims } from '../src/store.js'

function cand(o) {
  return { kind: 'fact', confidence: 0.9, sourcePriority: 100, validFrom: 0, ...o }
}

function seed(db, text) {
  const e = appendEvent(db, 1, 'turn.user', 'user', text)
  return e
}

test('G1 超长原文被拒', () => {
  const db = openDb(':memory:')
  const long = '猫'.repeat(9000)
  const e = seed(db, long)
  const rc = ingestClaim(db, cand({ slot: 'user.x', value: '猫', quote: long, evidence: [e], validFrom: 1, sourceText: long }), 1)
  assert.equal(rc, 'rejected')
})

test('G2 含 U+FFFD 替换字符被拒', () => {
  const db = openDb(':memory:')
  const text = '我养了一只猫叫团子\ufffd'
  const e = seed(db, text)
  const rc = ingestClaim(db, cand({ slot: 'user.pet.name', value: '团子', quote: text, evidence: [e], validFrom: 1, sourceText: text }), 1)
  assert.equal(rc, 'rejected')
})

test('G3 含控制字符被拒', () => {
  const db = openDb(':memory:')
  const text = '我养了一只猫叫团子\u0007'
  const e = seed(db, text)
  const rc = ingestClaim(db, cand({ slot: 'user.pet.name', value: '团子', quote: text, evidence: [e], validFrom: 1, sourceText: text }), 1)
  assert.equal(rc, 'rejected')
})

test('G4 连续 3 行完全相同被拒（结巴退化）', () => {
  const db = openDb(':memory:')
  const text = '团子\n团子\n团子'
  const e = seed(db, text)
  const rc = ingestClaim(db, cand({ slot: 'user.pet.name', value: '团子', quote: text, evidence: [e], validFrom: 1, sourceText: text }), 1)
  assert.equal(rc, 'rejected')
})

test('G5 命中凭据模式被拒（sk-）', () => {
  const db = openDb(':memory:')
  const text = '我的 key 是 sk-abcdefghijklmnopqrstuvwx 别告诉别人'
  const e = seed(db, text)
  const rc = ingestClaim(db, cand({ slot: 'user.key', value: 'sk-abcdefghijklmnopqrstuvwx', quote: text, evidence: [e], validFrom: 1, sourceText: text }), 1)
  assert.equal(rc, 'rejected')
})

test('G6 命中私钥头被拒', () => {
  const db = openDb(':memory:')
  const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----'
  const e = seed(db, text)
  const rc = ingestClaim(db, cand({ slot: 'user.key', value: 'PRIVATE KEY', quote: text, evidence: [e], validFrom: 1, sourceText: text }), 1)
  assert.equal(rc, 'rejected')
})

test('G7 正常文本通过', () => {
  const db = openDb(':memory:')
  const text = '我养了一只猫叫团子'
  const e = seed(db, text)
  const rc = ingestClaim(db, cand({ slot: 'user.pet.name', value: '团子', quote: text, evidence: [e], validFrom: 1, sourceText: text }), 1)
  assert.equal(rc, 'inserted')
  assert.equal(currentClaims(db).length, 1)
})
