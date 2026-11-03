// 双时态主张存储：写入闸门 + 引文门 + 值支撑门 + 合并代数 + 四态生命周期。
import { SUPPORT_THRESHOLD } from './constants.js'
import { checkGate } from './gate.js'

const norm = (s) => String(s).replace(/\s+/g, '')

export function valueSupportRatio(value, quote) {
  const v = norm(value)
  const q = norm(quote)
  if (!v || !q) return 0
  if (v.length === 1) return q.includes(v) ? 1 : 0
  const grams = new Set()
  for (let i = 0; i < v.length - 1; i++) grams.add(v.slice(i, i + 2))
  let hit = 0
  for (const g of grams) if (q.includes(g)) hit++
  return hit / grams.size
}

export function appendEvent(db, ts, kind, actor, payload) {
  const r = db
    .prepare('INSERT INTO event(ts, kind, actor, payload) VALUES (?,?,?,?)')
    .run(ts, kind, actor, payload)
  return Number(r.lastInsertRowid)
}

/**
 * 同一 (ts, payload) 只存一条 event。
 * 自动写入与 chaos_write 都会记同一句话——真相源只该有一份，否则
 * 同一事实攒成两条 evidence，合并代数会把它当成互证（corroborated）。
 */
export function ensureEvent(db, ts, kind, actor, payload) {
  const row = db
    .prepare('SELECT id FROM event WHERE ts=? AND payload=? ORDER BY id DESC LIMIT 1')
    .get(ts, payload)
  if (row) return Number(row.id)
  return appendEvent(db, ts, kind, actor, payload)
}

/** 库内最新一轮的 turn；空库为 0。 */
export function latestTurn(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(ts), 0) AS t FROM event').get().t)
}

function quoteVerifiable(db, cand) {
  if (!cand.quote || !cand.quote.trim()) return false
  for (const id of cand.evidence) {
    const row = db.prepare('SELECT payload FROM event WHERE id=?').get(id)
    if (row && row.payload.includes(cand.quote)) return true
  }
  return false
}

const rank = (c) => [
  c.source_priority ?? c.sourcePriority ?? 0,
  c.confidence,
  c.valid_from ?? c.validFrom ?? 0,
  c.tx_from ?? c.txFrom ?? 0,
]

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

function nextId(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM claim').get().n
  return `c${String(Number(n) + 1).padStart(5, '0')}`
}

function insert(db, cand, nowTx, state) {
  const id = nextId(db)
  db.prepare(
    `INSERT INTO claim(id,slot,value,kind,valid_from,valid_to,tx_from,tx_to,superseded_by,
       confidence,source_priority,corroboration,fidelity_user,fidelity_ai,evidence,quote,state,extractor)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    cand.slot,
    cand.value,
    cand.kind ?? 'fact',
    cand.validFrom ?? 0,
    null,
    nowTx,
    null,
    null,
    cand.confidence ?? 0.9,
    cand.sourcePriority ?? 100,
    0,
    1,
    1,
    JSON.stringify(cand.evidence),
    cand.quote,
    state,
    cand.extractor ?? 'chaos'
  )
  return id
}

/** 返回 inserted / corroborated / superseded / deferred / duplicate / rejected */
export function ingestClaim(db, cand, nowTx) {
  if (checkGate(cand.sourceText ?? '', cand.quote)) return 'rejected'
  if (!quoteVerifiable(db, cand)) return 'rejected'
  if (valueSupportRatio(cand.value, cand.quote) < SUPPORT_THRESHOLD) return 'rejected'

  const same = db
    .prepare('SELECT id, confidence, evidence FROM claim WHERE slot=? AND value=? AND tx_to IS NULL')
    .get(cand.slot, cand.value)
  if (same) {
    if (JSON.stringify(JSON.parse(same.evidence)) !== JSON.stringify(cand.evidence)) {
      db.prepare(
        'UPDATE claim SET confidence=?, corroboration=corroboration+1 WHERE id=?'
      ).run(Math.min(1, same.confidence + 0.1), same.id)
      return 'corroborated'
    }
    return 'duplicate'
  }

  const rivals = db
    .prepare('SELECT * FROM claim WHERE slot=? AND tx_to IS NULL')
    .all(cand.slot)

  if (rivals.length) {
    const best = rivals.reduce((m, r) => (cmp(rank(r), rank(m)) > 0 ? r : m))
    if (cmp(rank(best), rank(cand)) >= 0) {
      insert(db, cand, nowTx, 'deferred')
      return 'deferred'
    }
  }

  const id = insert(db, cand, nowTx, 'active')
  for (const r of rivals) {
    db.prepare('UPDATE claim SET tx_to=?, superseded_by=? WHERE id=?').run(nowTx, id, r.id)
  }
  return rivals.length ? 'superseded' : 'inserted'
}

export function currentClaims(db) {
  return db
    .prepare("SELECT * FROM claim WHERE tx_to IS NULL AND state='active'")
    .all()
}

export function applyCorrection(db, id, penalty) {
  db.prepare('UPDATE claim SET fidelity_ai = MAX(0.0, fidelity_ai - ?) WHERE id=?').run(
    penalty,
    id
  )
}

export function statusSummary(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM claim').get().n
  const byState = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) AS n FROM claim GROUP BY state').all().map((r) => [r.state, Number(r.n)])
  )
  return { total: Number(total), byState }
}
