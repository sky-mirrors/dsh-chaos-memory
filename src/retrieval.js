// BM25 检索：中文单字 + 字符 bigram，英文按词；IDF 压制常见 token。
const K1 = 1.5
const B = 0.75

export function tokenize(s) {
  const lower = String(s).toLowerCase()
  const toks = [...lower.matchAll(/[a-z0-9_]+/g)].map((m) => m[0])
  const zh = [...lower].filter((ch) => ch >= '\u4e00' && ch <= '\u9fff').join('')
  for (const ch of zh) toks.push(ch)
  for (let i = 0; i < zh.length - 1; i++) toks.push(zh.slice(i, i + 2))
  return toks
}

export function bm25Scores(query, docs) {
  const n = docs.length
  if (!n) return []
  const tokens = docs.map(tokenize)
  const avgdl = tokens.reduce((s, t) => s + t.length, 0) / n

  const df = new Map()
  for (const toks of tokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const idf = (t) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))

  const qTokens = tokenize(query)
  return tokens.map((toks) => {
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    let s = 0
    for (const t of qTokens) {
      const f = tf.get(t)
      if (!f) continue
      s += (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks.length) / avgdl))
    }
    return s
  })
}

/** 返回按分数降序的文档下标（同分保留原顺序，保证确定性）。 */
export function bm25Ranked(query, docs) {
  return bm25Scores(query, docs)
    .map((v, i) => [v, i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map(([, i]) => i)
}
