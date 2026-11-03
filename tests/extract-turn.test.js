// 跨轮抽取：unanswered（问题是否被回答）+ unspoken（可识别的未说出口）
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractTurn, isAnswered } from '../src/extract.js'

test('U1 提问但回答敷衍 → unanswered', () => {
  const out = extractTurn('你觉得我该不该接这个稿', '嗯')
  const hit = out.find((c) => c.kind === 'question')
  assert.ok(hit, '应识别为未回答')
  assert.ok(hit.slot.startsWith('unanswered.'))
})

test('U2 提问且回答相关 → 不产出 unanswered', () => {
  const out = extractTurn('你觉得我该不该接这个稿', '接吧，你最近状态不错，稿子也不难')
  assert.equal(out.find((c) => c.kind === 'question'), undefined)
})

test('U3 回答明确回避 → 仍是 unanswered', () => {
  const out = extractTurn('我们以后会怎么样', '我不知道')
  assert.ok(out.find((c) => c.kind === 'question'))
})

test('U4 非提问 → 不产出 question', () => {
  const out = extractTurn('我今天画了六个小时', '辛苦了，先起来走走')
  assert.equal(out.find((c) => c.kind === 'question'), undefined)
})

test('U5 isAnswered 直接判定', () => {
  assert.equal(isAnswered('团子'), true)
  assert.equal(isAnswered('嗯'), false)
  assert.equal(isAnswered(''), false)
  assert.equal(isAnswered('我不知道'), false)
})

test('SP1 表达未说出口 → unspoken', () => {
  const out = extractTurn('有件事不知道该不该说', '你说吧')
  const hit = out.find((c) => c.kind === 'unspoken')
  assert.ok(hit, '应识别 unspoken')
  assert.ok(hit.slot.startsWith('unspoken.'))
})

test('SP2 普通句不产出 unspoken', () => {
  const out = extractTurn('今天好累', '那就歇着')
  assert.equal(out.find((c) => c.kind === 'unspoken'), undefined)
})

test('SP3 同时提问与未说出口时都能识别', () => {
  const out = extractTurn('有件事不知道该不该说，你会不会觉得我烦', '不会')
  assert.ok(out.find((c) => c.kind === 'unspoken'))
})
