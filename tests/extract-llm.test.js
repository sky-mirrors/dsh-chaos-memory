// LLM 抽取器测试：重点不是"能不能调模型"，而是"模型胡说时能不能拦住"。
import test from 'node:test'
import assert from 'node:assert/strict'

import { openDb } from '../src/db.js'
import { appendEvent, currentClaims, ingestClaim } from '../src/store.js'
import { buildPrompt, extractLLM, parseCandidates } from '../src/extract-llm.js'

const TEXT = '我养了一只猫，叫团子，它一打雷就往床底下钻'
const SLOTS = ['user.pet.name', 'user.pet.trait', 'user.job']

test('L1 prompt 包含原文与可用槽位', () => {
  const p = buildPrompt(TEXT, SLOTS)
  assert.ok(p.includes(TEXT))
  assert.ok(p.includes('user.pet.name'))
})

test('L2 解析合法输出', () => {
  const raw = JSON.stringify([
    { slot: 'user.pet.name', value: '团子', quote: '叫团子' },
    { slot: 'user.pet.trait', value: '往床底下钻', quote: '它一打雷就往床底下钻' },
  ])
  const got = parseCandidates(raw, TEXT, SLOTS)
  assert.equal(got.length, 2)
  assert.equal(got[0].slot, 'user.pet.name')
})

test('L3 引文不在原文中 → 丢弃（防伪造）', () => {
  const raw = JSON.stringify([
    { slot: 'user.pet.name', value: '小白', quote: '我叫它小白' },
  ])
  assert.deepEqual(parseCandidates(raw, TEXT, SLOTS), [])
})

test('L4 value 不被 quote 支撑 → 丢弃（防失真）', () => {
  const raw = JSON.stringify([
    { slot: 'user.pet.name', value: '华盛顿', quote: '我养了一只猫，叫团子' },
  ])
  assert.deepEqual(parseCandidates(raw, TEXT, SLOTS), [])
})

test('L5 slot 不在白名单 → 丢弃（防瞎编槽位）', () => {
  const raw = JSON.stringify([
    { slot: 'user.bank.password', value: '团子', quote: '叫团子' },
  ])
  assert.deepEqual(parseCandidates(raw, TEXT, SLOTS), [])
})

test('L6 非 JSON / 空输出不崩', () => {
  assert.deepEqual(parseCandidates('模型今天不想说话', TEXT, SLOTS), [])
  assert.deepEqual(parseCandidates('', TEXT, SLOTS), [])
  assert.deepEqual(parseCandidates('[]', TEXT, SLOTS), [])
})

test('L7 端到端：stub 模型产出能通过门禁入库', async () => {
  const stub = async () =>
    JSON.stringify([{ slot: 'user.pet.name', value: '团子', quote: '叫团子' }])

  const cands = await extractLLM(TEXT, { callModel: stub, slots: SLOTS })
  assert.equal(cands.length, 1)

  const db = openDb(':memory:')
  const eid = appendEvent(db, 1, 'turn.user', 'user', TEXT)
  const rc = ingestClaim(
    db,
    {
      slot: cands[0].slot,
      value: cands[0].value,
      quote: cands[0].quote,
      evidence: [eid],
      validFrom: 1,
      sourceText: TEXT,
      confidence: 0.8,
      sourcePriority: 70,
    },
    1
  )
  assert.equal(rc, 'inserted')
  assert.equal(currentClaims(db).length, 1)
})

test('L8 模型返回伪造成分时，端到端仍被拦住', async () => {
  const stub = async () =>
    JSON.stringify([
      { slot: 'user.pet.name', value: '小白', quote: '我叫它小白' },
      { slot: 'user.job', value: '银行家', quote: '我养了一只猫' },
    ])
  const cands = await extractLLM(TEXT, { callModel: stub, slots: SLOTS })
  assert.deepEqual(cands, [])
})

// ---------- unspoken 判断项 ----------
const UNSPOKEN_TEXT = '有件事不知道该不该说，你会不会觉得我烦'

test('L9 prompt 要求单独判断 unspoken', () => {
  assert.ok(buildPrompt(UNSPOKEN_TEXT, SLOTS).includes('unspoken'))
})

test('L10 unspoken 项：槽位与值由本地派生，模型给什么都不采信', () => {
  const raw = JSON.stringify([
    { kind: 'unspoken', quote: '不知道该不该说', slot: 'user.bank.password', value: '账密' },
  ])
  const got = parseCandidates(raw, UNSPOKEN_TEXT, SLOTS)
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'unspoken')
  assert.ok(got[0].slot.startsWith('unspoken.'))
  assert.equal(got[0].value, UNSPOKEN_TEXT)
  assert.equal(got[0].quote, UNSPOKEN_TEXT)
})

test('L11 unspoken 的 quote 不在原文中 → 丢弃', () => {
  const raw = JSON.stringify([{ kind: 'unspoken', quote: '我不太确定这话该不该讲' }])
  assert.deepEqual(parseCandidates(raw, UNSPOKEN_TEXT, SLOTS), [])
})

test('L12 同一轮多个 unspoken 项 → 只留一条', () => {
  const raw = JSON.stringify([
    { kind: 'unspoken', quote: '有件事' },
    { kind: 'unspoken', quote: '不知道该不该说' },
  ])
  const got = parseCandidates(raw, UNSPOKEN_TEXT, SLOTS)
  assert.equal(got.filter((c) => c.kind === 'unspoken').length, 1)
})

test('L13 端到端：unspoken 候选能过三道门入库', async () => {
  const stub = async () => JSON.stringify([{ kind: 'unspoken', quote: '不知道该不该说' }])
  const cands = await extractLLM(UNSPOKEN_TEXT, { callModel: stub, slots: SLOTS })
  assert.equal(cands.length, 1)

  const db = openDb(':memory:')
  const eid = appendEvent(db, 1, 'turn.user', 'user', UNSPOKEN_TEXT)
  const rc = ingestClaim(
    db,
    {
      slot: cands[0].slot,
      value: cands[0].value,
      quote: cands[0].quote,
      evidence: [eid],
      validFrom: 1,
      kind: cands[0].kind,
      sourceText: UNSPOKEN_TEXT,
      confidence: 0.8,
      sourcePriority: 70,
    },
    1
  )
  assert.equal(rc, 'inserted')
  assert.equal(currentClaims(db)[0].kind, 'unspoken')
})
