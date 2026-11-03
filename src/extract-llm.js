// LLM 抽取器：把"模型说了什么"变成"能不能入库"。
// 核心不是调模型，而是三道校验——模型胡说时，一条也进不去。
import { SUPPORT_THRESHOLD } from './constants.js'
import { valueSupportRatio } from './store.js'

export function buildPrompt(text, slots) {
  return [
    '从下面这段对话里，抽出可以长期记住的事实。',
    '只输出 JSON 数组，不要任何解释。每项形如：{"slot":"...","value":"...","quote":"..."}',
    `slot 必须是这些之一：${slots.join(', ')}`,
    'quote 必须是原文里的连续片段，逐字复制，不改写、不补全。',
    'value 必须是 quote 里的连续片段。',
    '没有可抽的就输出 []。',
    '',
    '原文：',
    text,
  ].join('\n')
}

/**
 * 校验并过滤模型输出。任何一条不满足就整条丢弃。
 * 三道门：槽位白名单 / 引文必须在原文 / 值必须被引文支撑。
 */
export function parseCandidates(raw, sourceText, slots) {
  let arr
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []

  const allow = new Set(slots)
  const out = []
  for (const c of arr) {
    if (!c || typeof c.slot !== 'string') continue
    if (!allow.has(c.slot)) continue
    const quote = String(c.quote ?? '')
    const value = String(c.value ?? '')
    if (!quote || !value) continue
    if (!sourceText.includes(quote)) continue
    if (valueSupportRatio(value, quote) < SUPPORT_THRESHOLD) continue
    out.push({ slot: c.slot, value, quote, kind: c.kind ?? 'fact' })
  }
  return out
}

/**
 * @param {string} text 本轮原文
 * @param {{callModel:(prompt:string)=>Promise<string>, slots:string[]}} opts
 *        callModel 由宿主注入——本模块不认识任何模型 SDK。
 */
export async function extractLLM(text, { callModel, slots }) {
  const raw = await callModel(buildPrompt(text, slots))
  return parseCandidates(raw, text, slots)
}
