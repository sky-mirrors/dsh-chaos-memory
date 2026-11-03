// Chaos 存储层：事件日志（真相源）+ 双时态主张（派生视图）+ 装配日志。
// 台账：事件只追加；主张有 valid(何时为真) 与 tx(何时知道) 两维时间。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS event (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  actor   TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim (
  id             TEXT PRIMARY KEY,
  slot           TEXT NOT NULL,
  value          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'fact',
  valid_from     INTEGER NOT NULL,
  valid_to       INTEGER,
  tx_from        INTEGER NOT NULL,
  tx_to          INTEGER,
  superseded_by  TEXT,
  confidence     REAL NOT NULL DEFAULT 0.9,
  source_priority INTEGER NOT NULL DEFAULT 100,
  corroboration  INTEGER NOT NULL DEFAULT 0,
  fidelity_user  REAL NOT NULL DEFAULT 1.0,
  fidelity_ai    REAL NOT NULL DEFAULT 1.0,
  evidence       TEXT NOT NULL,
  quote          TEXT NOT NULL,
  state          TEXT NOT NULL,
  extractor      TEXT NOT NULL DEFAULT 'chaos'
);
CREATE INDEX IF NOT EXISTS claim_slot_live ON claim(slot, tx_to);

CREATE TABLE IF NOT EXISTS assembly_log (
  turn_id     INTEGER NOT NULL,
  claim_id    TEXT NOT NULL,
  score       REAL NOT NULL,
  reason      TEXT NOT NULL,
  packet_hash TEXT NOT NULL
);
`

const MIGRATIONS = [{ version: 1, sql: SCHEMA_V1 }]

export function openDb(path) {
  // WAL 是写进数据库文件头的持久设置，建库时设一次就够。
  // 每次打开都执行 `PRAGMA journal_mode=WAL` 需要拿排他锁——多进程同时打开会直接
  // "database is locked"，还没进入任何写事务就崩。
  const fresh = path === ':memory:' || !existsSync(path)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout=5000')
  if (fresh) db.exec('PRAGMA journal_mode=WAL')
  migrate(db)
  return db
}

function migrate(db) {
  // 迁移是「读当前版本 → 按版本执行 SQL → 记一笔」。多进程同时建库时，
  // 两边都读到 version=0，后到的那个会在 schema_migrations 上撞 UNIQUE。
  // 整段放进一把写锁：拿到锁之后再读版本，就不会有第二个进程插进来。
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'
    )
    const current = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v ?? 0
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now()
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
