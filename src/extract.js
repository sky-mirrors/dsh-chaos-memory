// 抽取器：从一句对话里提出结构化候选。
// 只产候选，不写库——入库由 store.ingestClaim 的三道门决定。
// 规则版是基线：零成本、可测、覆盖窄。真实使用应换 LLM 抽取器，接口一致。
import { createHash } from 'node:crypto'

const NEG_TAIL = '[^\\s，,。！？…]+'

const PATTERNS = [
  // 宠物
  { re: new RegExp(`我养了一只猫[，,]?\\s*叫(${NEG_TAIL})`), slot: 'user.pet.name' },
  { re: new RegExp(`我养了一只狗[，,]?\\s*叫(${NEG_TAIL})`), slot: 'user.pet.name' },
  // 职业
  { re: new RegExp(`我(?:现在)?的职业是(${NEG_TAIL})`), slot: 'user.job' },
  { re: new RegExp(`我是(画${NEG_TAIL}?)的`), slot: 'user.job' },
  // 城市
  { re: new RegExp(`我在(${NEG_TAIL}?)住了`), slot: 'user.city' },
  { re: /下个月我要搬去([\u4e00-\u9fa5]{2,3}?)(?:了|$)/, slot: 'user.city' },
  // 喜好
  { re: new RegExp(`我只喝(${NEG_TAIL})`), slot: 'user.coffee' },
  { re: new RegExp(`茶我只喝(${NEG_TAIL})`), slot: 'user.tea' },
  { re: new RegExp(`我喜欢(${NEG_TAIL}?)天`), slot: 'user.weather_like' },
  // 作息 / 身体 / 恐惧
  { re: new RegExp(`我(?:一般|通常)(${NEG_TAIL}?)才睡`), slot: 'user.sleep' },
  { re: new RegExp(`我最怕的(?:其实)?是(${NEG_TAIL})`), slot: 'user.fear' },
  { re: new RegExp(`我(?:最)?讨厌(${NEG_TAIL})`), slot: 'user.hate' },
  { re: new RegExp(`我右手腕有(${NEG_TAIL})`), slot: 'user.hand' },
  // 生日 / 家庭 / 朋友
  { re: new RegExp(`我生日是(${NEG_TAIL})`), slot: 'user.birthday' },
  { re: /我妈(每周日打电话|每周日|每个周日)/, slot: 'user.mother' },
  { re: new RegExp(`(${NEG_TAIL}?)是我唯一还联系的朋友`), slot: 'user.friend' },
  // 愿望
  { re: new RegExp(`我想开一家(${NEG_TAIL}?)书店`), slot: 'user.dream' },
  // 其他常驻事实
  { re: /团子一打雷就(钻床底)/, slot: 'user.pet.trait' },
  { re: /我房间窗户(朝北)/, slot: 'user.window' },
  { re: /我画画必须开着(雨声)/, slot: 'user.habit' },
  { re: /我一到冬天(手脚就跟冰块一样)/, slot: 'user.body' },
  { re: /三年前(?:那次)?分手/, slot: 'user.ex' },
  // 改口：新值会触发 supersede，旧值关闭 tx_to
  { re: /(?:改成喝|开始喝)([\u4e00-\u9fa5]{2,4})了/, slot: 'user.coffee', kind: 'revision' },
  { re: /现在([^\s，,。]+?)就睡/, slot: 'user.sleep', kind: 'revision' },
]

const PROMISE_RE = /说好了|我陪你|我提醒你|我陪你看|陪你一整晚/
// 未化解的怨：争执句式。unanswered 需要看下一轮是否回应，单句不可判定，故不在此处派生。
const GRIEVANCE_RE = /算了，?不想说|你是不是根本不在意|每次都这样|你怎么回得这么慢/
// 疑问句里的"什么/哪/谁…"不是事实，是提问
const QUESTION_HEAD = /^(什么|哪|谁|多少|几|怎么|为什么|啥|来着|一样)/

export function shortHash(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 8)
}

/**
 * 从一段对话文本抽取候选记忆。
 * @param {string} text 本轮原文（会作为 quote 整句写入，保证是 event 的子串）
 * @returns {{slot:string, value:string, quote:string, kind:string}[]}
 */
export function extract(text) {
  const out = []
  const seen = new Set()

  for (const p of PATTERNS) {
    // "茶我只喝普洱" 也含"我只喝"，会误抽成咖啡偏好
    if (p.slot === 'user.coffee' && text.startsWith('茶')) continue
    const m = text.match(p.re)
    if (!m) continue
    const value = m[1]
    if (!value || !text.includes(value)) continue
    if (QUESTION_HEAD.test(value)) continue
    const key = `${p.slot}|${value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ slot: p.slot, value, quote: text, kind: 'fact' })
  }

  // 承诺：内容无法稳定归到固定槽位，用内容哈希做键，同一句永远落到同一槽位
  if (PROMISE_RE.test(text)) {
    const key = `promise.${shortHash(text)}`
    if (!seen.has(key)) {
      out.push({ slot: key, value: text, quote: text, kind: 'commitment' })
    }
  }

  if (GRIEVANCE_RE.test(text)) {
    const key = `grievance.${shortHash(text)}`
    if (!seen.has(key)) {
      out.push({ slot: key, value: text, quote: text, kind: 'grievance' })
    }
  }

  return out
}

// ---------- 跨轮抽取 ----------
const QUESTION_RE = /[？?]$|吗$|呢$|什么|哪|怎么|为什么|多少|会不会|该不该|是不是/
const AVOID_RE = /不知道|不清楚|换个话题|不想说|以后再说|随便你/
// 未说出口：只在「表达了没说」的句式上命中。刻意保守——宁可漏报，不误报。
// 「已经说出口」与「决定要说」必须在后半段被退缩词排除，否则会与正常陈述混淆。
const UNSPOKEN_RE = new RegExp([
  '不知道(该不该|要不要)(说|讲|跟)',
  '(要不要|该不该).{0,10}(说|讲).{0,15}犹豫',
  '(有件事|有句话|有些话).{0,12}(想告诉你|要对你说|想说).{0,15}(算了|没敢|不敢|怕|犹豫|没必要)',
  '有件事.{0,8}没说',
  '想说.{0,10}(但|可是|又).{0,12}(算了|没说|没敢|怕|犹豫|没必要)',
  '想说.{0,12}不知道从哪',
  '(话|事).{0,4}到嘴边',
  '没敢(说|讲)',
  '憋了很久',
  '本来想说的',
].join('|'))

/**
 * 回答是否算数。只看回答本身：空 / 单个语气词 / 明确回避 → 未回答。
 * 宁漏报不误报——把"跑题的长回答"误判成已回答，比反过来安全。
 */
export function isAnswered(answer) {
  const a = String(answer ?? '').replace(/[。，、！？…\s]/g, '')
  if (a.length < 2) return false
  if (AVOID_RE.test(a)) return false
  return true
}

/**
 * 一轮问答的完整抽取：单句事实 + 未答问题 + 未说出口。
 * @param {string} userText 用户这一轮说的话
 * @param {string} aiText   对方这一轮的回应（用于判定问题是否被回答）
 */
export function extractTurn(userText, aiText = '') {
  const out = extract(userText)

  if (QUESTION_RE.test(userText) && !isAnswered(aiText)) {
    out.push({
      slot: `unanswered.${shortHash(userText)}`,
      value: userText, quote: userText, kind: 'question',
    })
  }

  if (UNSPOKEN_RE.test(userText)) {
    out.push({
      slot: `unspoken.${shortHash(userText)}`,
      value: userText, quote: userText, kind: 'unspoken',
    })
  }

  return out
}
