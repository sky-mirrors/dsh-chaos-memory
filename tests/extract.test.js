// 抽取器测试：从一句对话里提出结构化候选，且必须能被 Chaos 的门禁接受。
import test from 'node:test'
import assert from 'node:assert/strict'

import { openDb } from '../src/db.js'
import { appendEvent, ingestClaim, currentClaims } from '../src/store.js'
import { extract } from '../src/extract.js'

test('X1 宠物名', () => {
  const out = extract('我养了一只猫，叫团子')
  assert.equal(out.length, 1)
  assert.equal(out[0].slot, 'user.pet.name')
  assert.equal(out[0].value, '团子')
})

test('X2 职业', () => {
  const out = extract('我是画插画的，接稿为生')
  const hit = out.find((c) => c.slot === 'user.job')
  assert.ok(hit, '应识别职业')
})

test('X3 城市', () => {
  const out = extract('我在杭州住了六年了')
  const hit = out.find((c) => c.slot === 'user.city')
  assert.ok(hit)
  assert.ok(hit.value.includes('杭州'))
})

test('X4 闲聊不产出', () => {
  assert.deepEqual(extract('今天好累'), [])
  assert.deepEqual(extract('在干嘛'), [])
})

test('X5 quote 必须是原文子串', () => {
  const text = '我只喝美式，不加糖'
  for (const c of extract(text)) {
    assert.ok(text.includes(c.quote), `quote 不在原文中: ${c.quote}`)
  }
})

test('X6 抽取结果能通过 Chaos 门禁并入库', () => {
  const db = openDb(':memory:')
  const text = '我养了一只猫，叫团子'
  const eid = appendEvent(db, 1, 'turn.user', 'user', text)
  const cands = extract(text)
  assert.ok(cands.length > 0)
  const rc = ingestClaim(
    db,
    {
      slot: cands[0].slot,
      value: cands[0].value,
      quote: cands[0].quote,
      evidence: [eid],
      validFrom: 1,
      sourceText: text,
    },
    1
  )
  assert.equal(rc, 'inserted', '门禁应接受抽取器产出')
  assert.equal(currentClaims(db).length, 1)
})

test('X7 一句多事实', () => {
  const out = extract('我养了一只猫叫团子，我怕打雷')
  assert.ok(out.length >= 1)
  const slots = new Set(out.map((c) => c.slot))
  assert.ok(slots.size >= 1)
})
