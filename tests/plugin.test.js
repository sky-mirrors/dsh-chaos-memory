// DeepSeek Harness 插件契约测试：Cordis 导出 + 工具注册 + 端到端。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openDb } from '../src/db.js'

const origCwd = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'chaos-dsh-'))
process.chdir(dir)

const mod = await import('../index.js')

function fakeCtx(llm = undefined) {
  const registered = []
  const listeners = new Map()
  const execOf = (id = 's-tool', cwd = dir) => ({ agent: { session: { id, header: { cwd } } } })
  return {
    ctx: {
      // 真实宿主会给每个 execute 传 exec（含 agent.session）；默认补齐，测试里可显式覆盖。
      tools: {
        register: (t) =>
          registered.push({ ...t, execute: (args, exec = execOf()) => t.execute(args, exec) }),
      },
      on: (name, fn) => {
        listeners.set(name, fn)
      },
      llm,
      logger: { warn: () => {} },
    },
    registered,
    listeners,
    execOf,
  }
}

// session/event 的姿态取自 dsh-session / dsh-session-title：seq + data.source.kind + text 块。
const userEvent = (seq, text, kind = 'user') => ({
  seq,
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
})

// assistant/message 的 shape 取自 dsh-session types.d.ts:331（message: AssistantMessage）。
const assistantEvent = (seq, text) => ({
  seq,
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
  },
})

// 会话的模型路由来自 session.requestHeader().config（dsh-session-title 就是这么拿的）。
const sessionWithRoute = (id, route = { provider: 'deepseek', model: 'deepseek-chat' }, cwd = dir) => ({
  id,
  header: { cwd },
  requestHeader: () => ({ config: route }),
})

// 没有路由的会话：自动通道只跑规则版（用来单独观察 clock / event 行为）。
const sessionNoRoute = (id, cwd = dir) => ({
  id,
  header: { cwd },
  requestHeader: () => undefined,
})

// 宿主 LLM 的替身：只吐一条完整文本块，形状与 StreamChunk 一致。
function hostLlm(reply, opts = {}) {
  const calls = { n: 0 }
  return {
    calls,
    prepareCall: async (config) => {
      calls.n++
      return {
        config,
        async *stream() {
          if (opts.fail) throw new Error('host llm down')
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
          yield { type: 'finish', finish: { kind: 'stop' } }
        },
      }
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50))

test.after(() => {
  process.chdir(origCwd)
  rmSync(dir, { recursive: true, force: true })
})

test('K1 Cordis 插件导出：name / inject / apply', () => {
  assert.equal(mod.name, 'chaos')
  assert.deepEqual(mod.inject, ['tools', 'sessions', 'llm'])
  assert.equal(typeof mod.apply, 'function')
})

test('K2 apply(ctx) 注册 5 个工具', () => {
  const { ctx, registered } = fakeCtx()
  const dispose = mod.apply(ctx)
  assert.equal(registered.length, 5)
  assert.deepEqual(
    registered.map((t) => t.name),
    ['chaos_write', 'chaos_recall', 'chaos_status', 'chaos_correct', 'chaos_retract']
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

const assembleInto = async (listeners, session = undefined, assembly = { contexts: [] }) =>
  listeners.get('system-prompt/assemble')(
    assembly,
    session === undefined ? {} : { agent: { session } },
    async () => assembly
  )

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

test('K19 预算窗口内到顶后暂停注入，窗口到期恢复（不永久失忆）', async () => {
  const own = mkdtempSync(join(tmpdir(), 'chaos-budget-'))
  const { ctx, listeners, registered, execOf } = fakeCtx()
  const dispose = mod.apply(ctx)
  const session = sessionNoRoute('s-budget', own)

  // 写满预算：7 条/轮的注入量下，600 字符在几轮内就会用掉。
  for (let i = 0; i < 12; i++) {
    const text = `测试记忆第${i}号的原文内容`
    await registered[0].execute(
      { slot: `test.mem.${i}`, value: text, quote: text, source_text: text },
      execOf('s-budget', own)
    )
  }

  const names = []
  for (let i = 0; i < 30; i++) {
    const out = await assembleInto(listeners, session)
    names.push(out.contexts[0]?.name ?? 'none')
  }

  assert.ok(names.includes('chaos:memory'), '必须至少注入过一次')
  const firstGap = names.indexOf('chaos:gap')
  assert.ok(firstGap >= 0, '预算到顶后应给出缺口提示')
  assert.ok(names.slice(firstGap + 1).includes('chaos:memory'), '窗口到期后必须恢复注入')

  dispose()
  rmSync(own, { recursive: true, force: true })
})

// ---------- LLM 抽取：走宿主的 ctx.llm（宿主的 key），异步不阻塞 ----------

test('K13 自动通道用宿主 LLM 抽取语义项', async () => {
  const text = '有件事压在心里很久了'
  const llm = hostLlm(JSON.stringify([{ kind: 'unspoken', quote: text }]))
  const { ctx, registered, listeners } = fakeCtx(llm)
  const dispose = mod.apply(ctx)

  listeners.get('session/event')(sessionWithRoute('s-llm'), userEvent(601, text))
  await settle()

  assert.equal(llm.calls.n, 1, '必须走宿主 LLM 一次')
  const r = await registered[1].execute({ query: '压在心里' })
  assert.match(r, /压在心里/)
  dispose()
})

test('K14 会话还拿不到模型路由时不调 LLM，规则版照常写入', async () => {
  const llm = hostLlm('[]')
  const { ctx, registered, listeners } = fakeCtx(llm)
  const dispose = mod.apply(ctx)

  listeners.get('session/event')(
    { id: 's-noroute', requestHeader: () => undefined },
    userEvent(701, '我养了一只猫叫团子')
  )
  await settle()

  assert.equal(llm.calls.n, 0, '没有路由就不该发请求')
  const r = await registered[1].execute({ query: '我那只猫叫什么' })
  assert.match(r, /团子/)
  dispose()
})

test('K15 宿主 LLM 失败不影响规则版结果，也不抛到会话', async () => {
  const llm = hostLlm('', { fail: true })
  const { ctx, registered, listeners } = fakeCtx(llm)
  const dispose = mod.apply(ctx)

  assert.doesNotThrow(() => {
    listeners.get('session/event')(sessionWithRoute('s-fail'), userEvent(801, '我养了一只猫叫团子'))
  })
  await settle()

  assert.equal(llm.calls.n, 1)
  const r = await registered[1].execute({ query: '我那只猫叫什么' })
  assert.match(r, /团子/)
  dispose()
})

// ---------- 库路径：跟会话 cwd 走，不跟进程启动目录走 ----------

test('K16 不同 cwd 的会话各自开库，互不可见', async () => {
  const a = mkdtempSync(join(tmpdir(), 'chaos-cwd-a-'))
  const b = mkdtempSync(join(tmpdir(), 'chaos-cwd-b-'))
  const { ctx, registered, execOf } = fakeCtx()
  const dispose = mod.apply(ctx)
  const write = registered[0]
  const recall = registered[1]

  await write.execute(
    {
      slot: 'user.pet.name',
      value: '团子',
      quote: '我养了一只猫叫团子',
      source_text: '我养了一只猫叫团子',
    },
    execOf('s-a', a)
  )

  const inB = await recall.execute({ query: '我那只猫叫什么' }, execOf('s-b', b))
  assert.match(inB, /没有可注入的记忆/)

  const inA = await recall.execute({ query: '我那只猫叫什么' }, execOf('s-a', a))
  assert.match(inA, /团子/)

  dispose()
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

// ---------- 同一句只记一条 event；turn 时间轴按库分开 ----------

test('K17 自动写入后模型再调 chaos_write，同一句不重复记 event', async () => {
  // 独立目录：共享库里有别的用例写过的同一句，会让本轮变成「跨轮互证」而不是重复。
  const own = mkdtempSync(join(tmpdir(), 'chaos-ev-'))
  const text = '我养了一只猫叫团子，它一打雷就往床底下钻'
  const { ctx, registered, listeners, execOf } = fakeCtx()
  const dispose = mod.apply(ctx)
  const session = sessionNoRoute('s-ev', own)

  listeners.get('session/event')(session, userEvent(900, text))
  const rc = await registered[0].execute(
    { slot: 'user.pet.name', value: '团子', quote: '叫团子', source_text: text },
    execOf('s-ev', own)
  )
  assert.match(rc, /duplicate/)

  const db = openDb(join(own, '.rivet', 'chaos', 'chaos.db'))
  const n = db.prepare('SELECT COUNT(*) AS n FROM event WHERE payload=?').get(text).n
  db.close()
  assert.equal(Number(n), 1, '同一轮同一句只能有一条 event')

  dispose()
  rmSync(own, { recursive: true, force: true })
})

test('K18 turn 时间轴按库分开：别的会话的高 seq 不污染这边', async () => {
  const a = mkdtempSync(join(tmpdir(), 'chaos-clock-a-'))
  const b = mkdtempSync(join(tmpdir(), 'chaos-clock-b-'))
  const { ctx, listeners } = fakeCtx()
  const dispose = mod.apply(ctx)
  const onEvent = listeners.get('session/event')

  onEvent(sessionNoRoute('s-a', a), userEvent(100, '我养了一只猫叫团子'))
  onEvent(sessionNoRoute('s-b', b), userEvent(5, '我生日是三月十七'))

  const dbB = openDb(join(b, '.rivet', 'chaos', 'chaos.db'))
  const row = dbB.prepare('SELECT valid_from FROM claim').get()
  dbB.close()
  assert.equal(Number(row.valid_from), 5, 'B 库的 turn 必须是自己的 5，不是 A 的 100')

  dispose()
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

test('K20 进程重启后 turn 时钟从库内最新轮次续上，改口不被判成更旧', async () => {
  const own = mkdtempSync(join(tmpdir(), 'chaos-restart-'))

  // 第一个进程：第 100 轮说住在杭州
  const first = fakeCtx()
  const dispose1 = mod.apply(first.ctx)
  first.listeners.get('session/event')(sessionNoRoute('s-old', own), userEvent(100, '我在杭州住了三年'))
  dispose1()

  // 第二个进程：同一个 cwd / 同一个库，新会话 seq 从 1 起
  const second = fakeCtx()
  const dispose2 = mod.apply(second.ctx)
  second.listeners.get('session/event')(sessionNoRoute('s-new', own), userEvent(1, '下个月我要搬去成都了'))
  const recalled = await second.registered[1].execute({ query: '我现在住哪' }, second.execOf('s-new', own))
  dispose2()

  const db = openDb(join(own, '.rivet', 'chaos', 'chaos.db'))
  const rows = db.prepare("SELECT value, state, tx_to FROM claim WHERE slot='user.city' ORDER BY valid_from, id").all()
  db.close()
  rmSync(own, { recursive: true, force: true })

  assert.match(recalled, /成都/)
  const active = rows.filter((r) => r.tx_to == null && r.state === 'active')
  assert.equal(active.length, 1, '同一槽位只能有一条活动主张')
  assert.equal(active[0].value, '成都', '重启后的新说法必须压过旧值')
})

// ---------- 未答问题：用户提问 + AI 没答上 ----------

test('K21 用户提问且 AI 没答上时，用 assistant/message 补记一条未答问题', async () => {
  const own = mkdtempSync(join(tmpdir(), 'chaos-unans-'))
  const { ctx, registered, listeners, execOf } = fakeCtx()
  const dispose = mod.apply(ctx)
  const session = sessionNoRoute('s-unans', own)
  const onEvent = listeners.get('session/event')

  onEvent(session, userEvent(1, '你觉得我该不该接这个稿'))
  const before = await registered[2].execute({}, execOf('s-unans', own))
  assert.match(before, /主张 0 条/, 'AI 还没回之前不能先落一条问题')

  onEvent(session, assistantEvent(2, '嗯'))
  const after = await registered[2].execute({}, execOf('s-unans', own))
  assert.match(after, /主张 1 条/)

  const recall = await registered[1].execute({ query: '该不该接这个稿' }, execOf('s-unans', own))
  assert.match(recall, /该不该接这个稿/)

  dispose()
  rmSync(own, { recursive: true, force: true })
})

test('K22 AI 答上了就不记未答问题', async () => {
  const own = mkdtempSync(join(tmpdir(), 'chaos-ans-'))
  const { ctx, registered, listeners, execOf } = fakeCtx()
  const dispose = mod.apply(ctx)
  const session = sessionNoRoute('s-ans', own)
  const onEvent = listeners.get('session/event')

  onEvent(session, userEvent(1, '你觉得我该不该接这个稿'))
  onEvent(session, assistantEvent(2, '接吧，你最近状态不错，稿子也不难'))

  const status = await registered[2].execute({}, execOf('s-ans', own))
  assert.match(status, /主张 0 条/)

  dispose()
  rmSync(own, { recursive: true, force: true })
})

// ---------- 作废：抽错或承诺已兑现 ----------

test('K23 chaos_retract 作废记忆：不再被检索，状态记为 retracted', async () => {
  const own = mkdtempSync(join(tmpdir(), 'chaos-retract-'))
  const { ctx, registered, listeners, execOf } = fakeCtx()
  const dispose = mod.apply(ctx)
  const session = sessionNoRoute('s-retract', own)
  listeners.get('session/event')(session, userEvent(1, '我养了一只猫叫团子'))

  const db = openDb(join(own, '.rivet', 'chaos', 'chaos.db'))
  const id = db.prepare("SELECT id FROM claim WHERE slot='user.pet.name'").get().id
  db.close()

  const rc = await registered[4].execute({ id }, execOf('s-retract', own))
  assert.match(rc, /已作废/)

  const status = await registered[2].execute({}, execOf('s-retract', own))
  assert.match(status, /retracted/)

  const recall = await registered[1].execute({ query: '我那只猫叫什么' }, execOf('s-retract', own))
  assert.match(recall, /没有可注入的记忆/)

  dispose()
  rmSync(own, { recursive: true, force: true })
})

// ---------- 抽取触发点：路由在 request/header 才出现 ----------

const requestHeaderEvent = (seq, route) => ({
  seq,
  type: 'request/header',
  data: { header: { config: route }, reason: 'initial' },
})

test('K24 用户消息时没有路由，request/header 之后补跑 LLM 抽取', async () => {
  const own = mkdtempSync(join(tmpdir(), 'chaos-late-route-'))
  const llm = hostLlm(JSON.stringify([
    { slot: 'user.tea', value: '乌龙', quote: '我最近改喝乌龙了' },
  ]))
  const { ctx, registered, listeners, execOf } = fakeCtx(llm)
  const dispose = mod.apply(ctx)
  const session = sessionNoRoute('s-late', own)
  const onEvent = listeners.get('session/event')

  onEvent(session, userEvent(1, '我最近改喝乌龙了'))
  await settle()
  assert.equal(llm.calls.n, 0, '没有路由时不能先发抽取请求')

  onEvent(session, requestHeaderEvent(2, { provider: 'deepseek', model: 'deepseek-chat' }))
  await settle()
  assert.equal(llm.calls.n, 1, 'request/header 到达后必须补跑一次抽取')

  const recall = await registered[1].execute({ query: '我喝什么茶' }, execOf('s-late', own))
  assert.match(recall, /乌龙/)

  dispose()
  rmSync(own, { recursive: true, force: true })
})

test('K25 用户消息时已有路由：立即抽取，request/header 不重复触发', async () => {
  const own = mkdtempSync(join(tmpdir(), 'chaos-early-route-'))
  const llm = hostLlm(JSON.stringify([
    { slot: 'user.tea', value: '乌龙', quote: '我最近改喝乌龙了' },
  ]))
  const { ctx, listeners } = fakeCtx(llm)
  const dispose = mod.apply(ctx)
  const session = sessionWithRoute('s-early', undefined, own)
  const onEvent = listeners.get('session/event')

  onEvent(session, userEvent(1, '我最近改喝乌龙了'))
  await settle()
  assert.equal(llm.calls.n, 1)

  onEvent(session, requestHeaderEvent(2, { provider: 'deepseek', model: 'deepseek-chat' }))
  await settle()
  assert.equal(llm.calls.n, 1, '已经抽过的不该在 request/header 再抽一次')

  dispose()
  rmSync(own, { recursive: true, force: true })
})
