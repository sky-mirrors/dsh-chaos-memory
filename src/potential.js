// 势能浮现：线程派生 + 唤醒势 Φ + 双模式装配。
// 主模式（检索）：query 有明确指向时按相关性排序。
// 旁路模式（涌现）：query 无明确指向时按 Φ 排序，未了结的承诺才可能浮上来。
import { createHash } from 'node:crypto'
import { bm25Scores } from './retrieval.js'
import { currentClaims } from './store.js'
import { INJECTED_PENALTY } from './constants.js'

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

export function assemble(db, query, now, budget = 200, seen = new Map()) {
  const claims = currentClaims(db)
  if (!claims.length) return []

  const docs = claims.map((c) => `${c.slot} ${c.value} ${c.quote}`)
  const raw = bm25Scores(query, docs)
  const max = Math.max(...raw) || 1
  const rs = raw.map((x) => x / max)
  const threads = deriveThreads(db, now)

  // 已在本会话注入过的条目打折，把位置让给还没露过面的；模式判断仍用原始 R。
  const scored = claims.map((c, i) => {
    const penalty = seen.has(c.id) ? INJECTED_PENALTY : 1
    return {
      r: rs[i] * penalty,
      phi: phiFromR(rs[i], c, now, threads) * penalty,
      c,
    }
  })

  const retrieval = Math.max(...rs) >= R_GATE
  if (retrieval) {
    scored.sort((x, y) => y.r - x.r || x.c.id.localeCompare(y.c.id))
  } else {
    scored.sort((x, y) => y.phi - x.phi || x.c.id.localeCompare(y.c.id))
  }

  const out = []
  const picked = []
  let used = 0
  for (const { c, r, phi } of scored) {
    const cost = c.slot.length + c.value.length + 3
    if (used + cost > budget) continue
    out.push({ slot: c.slot, value: c.value, id: c.id })
    picked.push({ id: c.id, score: retrieval ? r : phi })
    used += cost
  }

  // 装配审计：每次注入了什么、按什么分数、哪个模式、整包指纹。
  // packet_hash 覆盖本包全部条目，同 turn 的多行共享一个指纹。
  // 整包写在一个事务里：逐条 autocommit 会把每轮装配从 0.3 ms 拖到 9 ms。
  if (picked.length) {
    const packetHash = createHash('sha1')
      .update(out.map((it) => `${it.id}:${it.value}`).join('\n'))
      .digest('hex')
      .slice(0, 12)
    const ins = db.prepare(
      'INSERT INTO assembly_log(turn_id, claim_id, score, reason, packet_hash) VALUES (?,?,?,?,?)'
    )
    const reason = retrieval ? 'retrieval' : 'emergence'
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const p of picked) ins.run(now, p.id, p.score, reason, packetHash)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return out
}

export function render(items) {
  if (!items.length) return ''
  return ['【你记得的关于对方的事】', ...items.map((it) => `- ${it.value}`)].join('\n')
}
