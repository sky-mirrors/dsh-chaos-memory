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
  return {
    ctx: { tools: { register: (t) => registered.push(t) } },
    registered,
  }
}

test.after(() => {
  process.chdir(origCwd)
  rmSync(dir, { recursive: true, force: true })
})

test('K1 Cordis 插件导出：name / inject / apply', () => {
  assert.equal(mod.name, 'chaos')
  assert.deepEqual(mod.inject, ['tools'])
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
