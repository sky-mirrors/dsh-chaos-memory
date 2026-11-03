// Chaos —— DeepSeek Harness 插件入口（Cordis 契约）。
// 契约来源：docs/cookbook/adding-a-tool.md；依赖 @deepseek-ai/dsh-tools 的 defineTool。
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import { openDb } from './src/db.js'
import {
  applyCorrection,
  ensureEvent,
  ingestClaim,
  latestTurn,
  statusSummary,
} from './src/store.js'
import { assemble, render } from './src/potential.js'
import { negotiable, negotiationLine } from './src/fidelity.js'
import { SLOTS, extract, extractUnspoken } from './src/extract.js'
import { buildPrompt, parseCandidates } from './src/extract-llm.js'
import { SESSION_BUDGET, SESSION_WINDOW } from './src/constants.js'

export const name = 'chaos'
export const inject = ['tools', 'sessions', 'llm']

const text = (s) => [{ type: 'text', text: s }]

export function apply(ctx) {
  const dbs = new Map()
  // turn 时间轴属于库，不属于插件进程：每个库一份 clock，会话之间不共用一个计数。
  const clocks = new Map()

  // 库跟着会话的工作目录走，不跟着进程启动目录走。
  // SessionHeader.cwd 是可选字段（dsh-session/lib/types/types.d.ts:70），拿不到时退回进程 cwd。
  const cwdOf = (session) => session?.header?.cwd ?? process.cwd()
  const dbPathOf = (session) => join(cwdOf(session), '.rivet', 'chaos', 'chaos.db')
  const getDb = (session) => {
    const path = dbPathOf(session)
    let db = dbs.get(path)
    if (!db) {
      db = openDb(path)
      dbs.set(path, db)
    }
    return db
  }
  // 进程重启时内存里的 clock 归零，但库里的 turn 还在。首次访问从 latestTurn 续上——
  // 否则新会话的 seq=1 会被当成「比库里的历史更早」，改口会被判成 deferred。
  const clockOf = (session) => {
    const path = dbPathOf(session)
    let t = clocks.get(path)
    if (t === undefined) {
      t = latestTurn(getDb(session))
      clocks.set(path, t)
    }
    return t
  }
  const bumpClock = (session, t) => {
    const path = dbPathOf(session)
    if (t > (clocks.get(path) ?? 0)) clocks.set(path, t)
  }

  // LLM 抽取：用宿主的 ctx.llm（宿主的 key），异步跑、不阻塞会话。
  // 路由取自 session.requestHeader().config——与 dsh-session-title 同一取法；
  // 会话第一次请求前还没有路由，那一轮就只用规则版。
  // 失败只降级到规则版结果：模型是外部输入，不可用不能让这一轮的记忆丢失。
  const extractWithHost = async (session, text, eid, t) => {
    const route = session.requestHeader()?.config
    if (!route) return
    const signal = AbortSignal.timeout(20000)
    const call = await ctx.llm.prepareCall(route, signal)
    const assembler = new BlockAssembler()
    const messages = [createUserMessage({
      content: [{ type: 'text', text: buildPrompt(text, SLOTS) }],
      source: { kind: 'user' },
    })]
    for await (const chunk of call.stream({
      ...call.config,
      messages,
      sessionId: session.id,
      purpose: 'chaos-extract',
      temperature: 0,
      maxTokens: 800,
      signal,
    })) {
      assembler.push(chunk)
    }
    const raw = assembler
      .blocks()
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
    for (const c of parseCandidates(raw, text, SLOTS)) {
      ingestClaim(getDb(session), {
        slot: c.slot,
        value: c.value,
        quote: c.quote,
        evidence: [eid],
        validFrom: t,
        kind: c.kind,
        sourceText: text,
        confidence: 0.85,
        sourcePriority: 90,
      }, t)
    }
  }

  // 自动写入：宿主每追加一条用户消息就抽取一次，不再依赖模型主动调 chaos_write。
  // 契约来源：dsh-session 的 session/event（event.seq / data.source.kind / text 块），
  // 消费方式与 dsh-session-title 一致。
  // 规则版先写（同步、零成本，兜底）；LLM 抽取在后台补齐语义项。
  // （unanswered 需要看下一轮回应，故不在此处派生。）
  const seen = new Set()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    const text = event.data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    if (!text.trim()) return
    const key = `${session.id}:${event.seq}`
    if (seen.has(key)) return
    seen.add(key)

    // 严格递增：同一进程里的新会话 seq 会从 1 重来，只取 max 会把两轮写成同一个 turn。
    const t = Math.max(clockOf(session) + 1, event.seq)
    bumpClock(session, t)
    const db = getDb(session)
    const eid = ensureEvent(db, t, 'turn.user', 'user', text)
    for (const c of [...extract(text), ...extractUnspoken(text)]) {
      ingestClaim(db, {
        slot: c.slot,
        value: c.value,
        quote: c.quote,
        evidence: [eid],
        validFrom: t,
        kind: c.kind,
        sourceText: text,
        confidence: 0.9,
        sourcePriority: 100,
      }, t)
    }
    void extractWithHost(session, text, eid, t).catch((err) => {
      ctx.logger.warn(`chaos: LLM 抽取失败，保留规则版结果: ${String(err)}`)
    })
  })

  // 自动注入：每轮装配系统提示时把该浮现的记忆拼进去，不再依赖模型主动调 chaos_recall。
  // 契约来源：system-prompt/assemble（assembly.contexts 的 { name, text, interpolate } 条目），
  // 与 dsh-working-directory 的用法一致。
  // query 传空 → 走涌现模式（Φ 排序）：未兑现的承诺、没被回答的问题、没说出口的话才会自己浮上来。
  //
  // 会话预算：注入是按会话累计的。每个会话有自己的预算和「已注入」表——
  // 已注入过的条目降权（让位置给新的），窗口内累计到 SESSION_BUDGET 后暂停注入，
  // 窗口到期重新计数，长会话不会永久失忆。
  const budgets = new Map()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const session = context.agent?.session
    const key = session?.id ?? '__no-session__'
    const st = budgets.get(key) ?? { spent: 0, turn: 0, seen: new Map() }

    // 预算按窗口滚动：窗口到期重新计数，只在窗口内封顶。
    st.turn += 1
    if (st.turn > SESSION_WINDOW) {
      st.turn = 1
      st.spent = 0
    }
    budgets.set(key, st)

    if (st.spent >= SESSION_BUDGET) {
      assembly.contexts.unshift({
        name: 'chaos:gap',
        text: '<chaos-gap>本会话的记忆注入预算已用完；还需要的话用 chaos_recall 按需取。</chaos-gap>',
        interpolate: false,
      })
      return assembly
    }

    const items = assemble(getDb(session), '', clockOf(session), 200, st.seen)
    const block = render(items)
    if (block) {
      assembly.contexts.unshift({
        name: 'chaos:memory',
        text: `<chaos>\n${block}\n</chaos>`,
        interpolate: false,
      })
      st.spent += block.length
      for (const it of items) st.seen.set(it.id, (st.seen.get(it.id) ?? 0) + 1)
    }
    return assembly
  })

  ctx.tools.register(defineTool({
    name: 'chaos_write',
    description:
      '写入一条记忆主张。source_text 是本轮对话原文，quote 必须是它的子串；'
      + '值若不在引文中会被拒（防抽取失真），引文若不在原文中也会被拒（防伪造）。'
      + '本条原文若已由自动通道记录，复用那条 event，不重复落库。',
    parameters: {
      slot: { type: 'string', required: true, description: '槽位键，如 user.pet.name / promise.bookstore' },
      value: { type: 'string', required: true, description: '该槽位的值，须是引文的子串' },
      quote: { type: 'string', required: true, description: '支撑这条主张的原文摘录' },
      source_text: { type: 'string', required: true, description: '本轮对话原文' },
      kind: { type: 'string', description: 'fact | commitment | grievance | question | unspoken' },
      turn: { type: 'number', description: '轮次，省略则沿用库内最新一轮' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => text(v),
    },
    async execute(args, exec) {
      const session = exec.agent.session
      const db = getDb(session)
      const t = args.turn ?? (latestTurn(db) || 1)
      const eid = ensureEvent(db, t, 'turn.user', 'user', args.source_text)
      const rc = ingestClaim(db, {
        slot: args.slot,
        value: args.value,
        quote: args.quote,
        evidence: [eid],
        validFrom: t,
        kind: args.kind ?? 'fact',
        sourceText: args.source_text,
        confidence: 0.9,
        sourcePriority: 100,
      }, t)
      bumpClock(session, t)
      return `${rc}: ${args.slot}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chaos_recall',
    description: '按 query 检索记忆并返回可注入的 <chaos> 块（检索模式）。',
    parameters: {
      query: { type: 'string', required: true },
      budget: { type: 'number', description: '字符预算，默认 200' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => text(v),
    },
    async execute(args, exec) {
      const session = exec.agent.session
      const items = assemble(getDb(session), args.query, clockOf(session), args.budget ?? 200)
      const block = render(items)
      return block ? `<chaos>\n${block}\n</chaos>` : '（没有可注入的记忆）'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chaos_status',
    description: '记忆库状态：主张总数、状态分布、待协商条目。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_a, v) => text(v),
    },
    async execute(_args, exec) {
      const session = exec.agent.session
      const s = statusSummary(getDb(session))
      const neg = negotiable(getDb(session))
      const lines = [`主张 ${s.total} 条`, `状态分布 ${JSON.stringify(s.byState)}`]
      if (neg.length) {
        lines.push(`待协商 ${neg.length} 条：`)
        for (const c of neg) lines.push(`  ${c.slot} — ${negotiationLine(c)}`)
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'chaos_correct',
    description: '用户纠正某条记忆：只降 AI 侧保真度，用户侧不动。',
    parameters: {
      id: { type: 'string', required: true },
      penalty: { type: 'number', description: '默认 0.25' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => text(v),
    },
    async execute(args, exec) {
      applyCorrection(getDb(exec.agent.session), args.id, args.penalty ?? 0.25)
      return `已纠正 ${args.id}`
    },
  }))

  // 返回 disposer：Cordis 卸载插件时关闭所有连接。
  return () => {
    for (const db of dbs.values()) db.close()
    dbs.clear()
    clocks.clear()
    budgets.clear()
  }
}
