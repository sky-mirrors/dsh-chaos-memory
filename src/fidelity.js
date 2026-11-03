// 双向保真度与记忆协商：衰减、背离、协商话术、改口历史。
import { currentClaims } from './store.js'

export function decayFidelity(db, now, tau = 100, floor = 0.3) {
  for (const c of currentClaims(db)) {
    const age = now - c.tx_from
    if (age <= 0) continue
    const f = floor + (1 - floor) * Math.exp(-age / tau)
    db.prepare('UPDATE claim SET fidelity_ai=?, fidelity_user=? WHERE id=?').run(f, f, c.id)
  }
}

export function divergence(c) {
  return Math.abs(c.fidelity_user - c.fidelity_ai)
}

/** 背离超过阈值才是协商候选：未超阈值不得打扰用户。 */
export function negotiable(db, threshold = 0.2) {
  return currentClaims(db).filter((c) => divergence(c) > threshold)
}

export function negotiationLine(c) {
  return `我记得的是「${c.value}」，不过这条我不太确定……你记的是这样吗？`
}

export function revisions(db, slot) {
  return db
    .prepare('SELECT tx_from, value FROM claim WHERE slot=? ORDER BY tx_from, id')
    .all(slot)
    .map((r) => [r.tx_from, r.value])
}

export function revisionLine(db, slot) {
  const chain = revisions(db, slot)
  if (chain.length < 2) return ''
  const oldV = chain[chain.length - 2][1]
  const newV = chain[chain.length - 1][1]
  return `你之前说的是「${oldV}」，现在是「${newV}」了？`
}
