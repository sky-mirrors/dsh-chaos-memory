// 势能浮现：线程派生 + 唤醒势 Φ + 双模式装配。
// 主模式（检索）：query 有明确指向时按相关性排序。
// 旁路模式（涌现）：query 无明确指向时按 Φ 排序，未了结的承诺才可能浮上来。
import { bm25Scores } from './retrieval.js'
import { currentClaims } from './store.js'

export const TAU = 100
export const TAU_S = 300
export const FAITH_FLOOR = 0.5
export const R_GATE = 0.2
export const W = { a: 0.5, b: 0.2, g: 0.35, d: 0.15, e: 0.25 }

export function pressureOf(age, tau = TAU) {
  return age <= 0 ? 0 : 1 - Math.exp(-age / tau)
}

export function rarity(age, tau = TAU_S) {
  return age <= 0 ? 0 : 1 - Math.exp(-age / tau)
}

/** 周期共振 β·C：当前时刻与记忆发生时刻在日历维度上的重合度。 */
export function cycleMatch(t1, t2) {
  if (!t1 || !t2) return 0
  const d1 = new Date(t1 * 1000)
  const d2 = new Date(t2 * 1000)
  if (d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate()) return 1
  if (d1.getMonth() === d2.getMonth()) return 0.6
  if (d1.getDay() === d2.getDay()) return 0.4
  const dh = Math.abs(d1.getHours() - d2.getHours())
  return Math.min(dh, 24 - dh) <= 2 ? 0.3 : 0
}

/** 关系张力 δ·T：只在存在未闭合 grievance 时非零。 */
export function relationalTension(claim, threads) {
  let max = 0
  for (const t of Object.values(threads)) {
    if (t.kind === 'grievance' && t.state === 'open' && t.pressure > max) max = t.pressure
  }
  return max
}

const THREAD_KIND = {
  commitment: 'promise', grievance: 'grievance',
  question: 'unanswered', unspoken: 'unspoken',
}

export function deriveThreads(db, now) {
  const out = {}
  const rows = db
    .prepare(
      "SELECT * FROM claim WHERE tx_to IS NULL AND state='active'"
      + " AND kind IN ('commitment','grievance','question','unspoken')"
    )
    .all()
  for (const c of rows) {
    const kind = THREAD_KIND[c.kind]
    if (!kind) continue
    out[c.slot] = {
      key: c.slot,
      kind,
      openedAt: c.valid_from,
      lastTouchedAt: c.tx_from,
      pressure: pressureOf(now - c.valid_from),
      state: 'open',
    }
  }
  return out
}

export function phiFromR(r, claim, now, threads, w = W) {
  const rr = Math.min(1, Math.max(0, r))
  const thr = threads[claim.slot]
  const u = thr ? thr.pressure : 0
  const s = rarity(now - (claim.tx_from ?? claim.txFrom ?? 0))
  const c = cycleMatch(claim.valid_from ?? claim.validFrom ?? 0, now)
  const t = relationalTension(claim, threads)
  const base = w.a * rr + (1 - rr) * (w.b * c + w.g * u + w.d * t + w.e * s)
  const faith = FAITH_FLOOR + (1 - FAITH_FLOOR) * (claim.fidelity_ai ?? 1)
  return base * faith
}

export function assemble(db, query, now, budget = 200) {
  const claims = currentClaims(db)
  if (!claims.length) return []

  const docs = claims.map((c) => `${c.slot} ${c.value} ${c.quote}`)
  const raw = bm25Scores(query, docs)
  const max = Math.max(...raw) || 1
  const rs = raw.map((x) => x / max)
  const threads = deriveThreads(db, now)

  const scored = claims.map((c, i) => ({
    r: rs[i],
    phi: phiFromR(rs[i], c, now, threads),
    c,
  }))

  if (Math.max(...rs) >= R_GATE) {
    scored.sort((x, y) => y.r - x.r || x.c.id.localeCompare(y.c.id))
  } else {
    scored.sort((x, y) => y.phi - x.phi || x.c.id.localeCompare(y.c.id))
  }

  const out = []
  let used = 0
  for (const { c } of scored) {
    const cost = c.slot.length + c.value.length + 3
    if (used + cost > budget) continue
    out.push({ slot: c.slot, value: c.value, id: c.id })
    used += cost
  }
  return out
}

export function render(items) {
  if (!items.length) return ''
  return ['【你记得的关于对方的事】', ...items.map((it) => `- ${it.value}`)].join('\n')
}
