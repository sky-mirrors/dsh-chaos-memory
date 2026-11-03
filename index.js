// Chaos —— DeepSeek Harness 插件入口（Cordis 契约）。
// 契约来源：docs/cookbook/adding-a-tool.md；依赖 @deepseek-ai/dsh-tools 的 defineTool。
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { openDb } from './src/db.js'
import { appendEvent, applyCorrection, ingestClaim, statusSummary } from './src/store.js'
import { assemble, render } from './src/potential.js'
import { negotiable, negotiationLine } from './src/fidelity.js'

export const name = 'chaos'
export const inject = ['tools']

const text = (s) => [{ type: 'text', text: s }]

export function apply(ctx) {
  let db = null
  let clock = 0

  const getDb = () => {
    if (!db) db = openDb(join(process.cwd(), '.rivet', 'chaos', 'chaos.db'))
    return db
  }

  ctx.tools.register(defineTool({
    name: 'chaos_write',
    description:
      '写入一条记忆主张。source_text 是本轮对话原文，quote 必须是它的子串；'
      + '值若不在引文中会被拒（防抽取失真），引文若不在原文中也会被拒（防伪造）。',
    parameters: {
      slot: { type: 'string', required: true, description: '槽位键，如 user.pet.name / promise.bookstore' },
      value: { type: 'string', required: true, description: '该槽位的值，须是引文的子串' },
      quote: { type: 'string', required: true, description: '支撑这条主张的原文摘录' },
      source_text: { type: 'string', required: true, description: '本轮对话原文' },
      kind: { type: 'string', description: 'fact | commitment | grievance | question | unspoken' },
      turn: { type: 'number', description: '轮次，省略则自增' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => text(v),
    },
    async execute(args) {
      const t = args.turn ?? clock + 1
      const eid = appendEvent(getDb(), t, 'turn.user', 'user', args.source_text)
      const rc = ingestClaim(getDb(), {
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
      clock = Math.max(clock, t)
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
    async execute(args) {
      const items = assemble(getDb(), args.query, clock, args.budget ?? 200)
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
    async execute() {
      const s = statusSummary(getDb())
      const neg = negotiable(getDb())
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
    async execute(args) {
      applyCorrection(getDb(), args.id, args.penalty ?? 0.25)
      return `已纠正 ${args.id}`
    },
  }))

  // 返回 disposer：Cordis 卸载插件时关闭连接。
  return () => {
    if (db) {
      db.close()
      db = null
    }
  }
}
