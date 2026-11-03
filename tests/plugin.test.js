// DeepSeek Harness 插件契约测试：Cordis 导出 + 工具注册 + 端到端。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const origCwd = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'chaos-dsh-'))
process.chdir(dir)

const mod = await import('../index.js')

function fakeCtx() {
  const registered = []
  const listeners = new Map()
  return {
    ctx: {
      tools: { register: (t) => registered.push(t) },
      on: (name, fn) => {
        listeners.set(name, fn)
      },
    },
    registered,
    listeners,
  }
}

// session/event 的姿态取自 dsh-session / dsh-session-title：seq + data.source.kind + text 块。
const userEvent = (seq, text, kind = 'user') => ({
  seq,
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
})

test.after(() => {
  process.chdir(origCwd)
  rmSync(dir, { recursive: true, force: true })
})

test('K1 Cordis 插件导出：name / inject / apply', () => {
  assert.equal(mod.name, 'chaos')
  assert.deepEqual(mod.inject, ['tools', 'sessions'])
  assert.equal(typeof mod.apply, 'function')
})

test('K2 apply(ctx) 注册 4 个工具', () => {
  const { ctx, registered } = fakeCtx()
  const dispose = mod.apply(ctx)
  assert.equal(registered.length, 4)
  assert.deepEqual(
    registered.map((t) => t.name),
    ['chaos_write', 'chaos_recall', 'chaos_status', 'chaos_correct']
  )
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('K3 工具定义符合 defineTool 契约', () => {
  const { ctx, registered } = fakeCtx()
  const dispose = mod.apply(ctx)
  for (const t of registered) {
    assert.equal(typeof t.name, 'string')
    assert.equal(typeof t.description, 'string')
    assert.equal(typeof t.execute, 'function')
  }
  dispose()
})

test('K4 端到端：写入后能被检索到', async () => {
  const { ctx, registered } = fakeCtx()
  const dispose = mod.apply(ctx)
  const write = registered[0]
  const recall = registered[1]

  const r1 = await write.execute({
    slot: 'user.pet.name',
    value: '团子',
    quote: '我养了一只猫叫团子',
    source_text: '我养了一只猫叫团子',
    turn: 1,
  })
  assert.match(r1, /inserted/)

  const r2 = await recall.execute({ query: '我那只猫叫什么' })
  assert.match(r2, /团子/)
  assert.match(r2, /<chaos>/)
  dispose()
})

test('K5 伪造引文被拒（事件层存的是原文，不是候选自带引文）', async () => {
  const { ctx, registered } = fakeCtx()
  const dispose = mod.apply(ctx)
  const r = await registered[0].execute({
    slot: 'user.pet.species',
    value: '狗',
    quote: '我养的是狗',
    source_text: '我养了一只猫叫团子',
    turn: 2,
  })
  assert.match(r, /rejected/)
  dispose()
})

test('K6 status 可用', async () => {
  const { ctx, registered } = fakeCtx()
  const dispose = mod.apply(ctx)
  const r = await registered[2].execute({})
  assert.match(r, /主张 \d+ 条/)
  dispose()
})

// ---------- 自动写入通道：不依赖模型主动调 chaos_write ----------

test('K7 用户消息到达即自动抽取入库', async () => {
  const { ctx, registered, listeners } = fakeCtx()
  const dispose = mod.apply(ctx)
  const onEvent = listeners.get('session/event')
  assert.equal(typeof onEvent, 'function', '必须订阅 session/event')

  onEvent({ id: 's-auto' }, userEvent(101, '我养了一只猫叫团子，它一打雷就往床底下钻'))

  const r = await registered[1].execute({ query: '我那只猫叫什么' })
  assert.match(r, /团子/)
  dispose()
})

test('K8 同一条用户消息重复投递只写一次', async () => {
  const { ctx, registered, listeners } = fakeCtx()
  const dispose = mod.apply(ctx)
  const onEvent = listeners.get('session/event')
  const status = registered[2]

  const before = await status.execute({})
  onEvent({ id: 's-dup' }, userEvent(201, '我生日是三月十七'))
  onEvent({ id: 's-dup' }, userEvent(201, '我生日是三月十七'))
  const after = await status.execute({})

  const count = (s) => Number(/主张 (\d+) 条/.exec(s)[1])
  assert.equal(count(after) - count(before), 1)
  dispose()
})

test('K9 非用户来源的消息不触发自动写入', async () => {
  const { ctx, registered, listeners } = fakeCtx()
  const dispose = mod.apply(ctx)
  const status = registered[2]

  const before = await status.execute({})
  listeners.get('session/event')({ id: 's-src' }, userEvent(301, '我养了一只猫叫团子', 'assistant'))
  const after = await status.execute({})

  const count = (s) => Number(/主张 (\d+) 条/.exec(s)[1])
  assert.equal(count(after), count(before))
  dispose()
})

test('K10 没有文本块的消息不写空事件', async () => {
  const { ctx, registered, listeners } = fakeCtx()
  const dispose = mod.apply(ctx)
  const status = registered[2]

  const before = await status.execute({})
  listeners.get('session/event')({ id: 's-empty' }, {
    seq: 401,
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'image', url: 'x' }] },
  })
  const after = await status.execute({})
  assert.equal(after, before)
  dispose()
})

// ---------- 自动注入通道：不依赖模型主动调 chaos_recall ----------

const assembleInto = async (listeners, assembly = { contexts: [] }) =>
  listeners.get('system-prompt/assemble')(assembly, {}, async () => assembly)

test('K11 系统提示装配时自动注入记忆块', async () => {
  const { ctx, listeners } = fakeCtx()
  const dispose = mod.apply(ctx)
  listeners.get('session/event')({ id: 's-prompt' }, userEvent(501, '我养了一只猫叫团子'))

  const out = await assembleInto(listeners)
  const entry = out.contexts.find((c) => c.name === 'chaos:memory')
  assert.ok(entry, '必须注入 chaos 记忆块')
  assert.match(entry.text, /团子/)
  assert.equal(entry.interpolate, false)
  dispose()
})

test('K12 没有可注入内容时不产生空块', async () => {
  // 空库要在自己的 cwd 里验：共享目录里的 db 已被前面的用例写过。
  const empty = mkdtempSync(join(tmpdir(), 'chaos-empty-'))
  const keep = process.cwd()
  process.chdir(empty)

  const { ctx, listeners } = fakeCtx()
  const dispose = mod.apply(ctx)
  const out = await assembleInto(listeners)
  dispose()

  process.chdir(keep)
  rmSync(empty, { recursive: true, force: true })
  assert.equal(out.contexts.length, 0)
})
