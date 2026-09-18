'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'factcheck.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS interviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  source      TEXT DEFAULT '',
  transcript  TEXT NOT NULL DEFAULT '',
  revision    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS segments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  time_label   TEXT DEFAULT '',
  seconds      REAL,
  speaker      TEXT DEFAULT '',
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_interview ON segments(interview_id, ord);

CREATE TABLE IF NOT EXISTS claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id      INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  normalized_text   TEXT NOT NULL,
  original_text     TEXT NOT NULL DEFAULT '',
  keywords          TEXT NOT NULL DEFAULT '',
  facts             TEXT NOT NULL DEFAULT '[]',
  polarity          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'unverified',
  note              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_interview ON claims(interview_id);

CREATE TABLE IF NOT EXISTS evidence (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id   INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  excerpt    TEXT NOT NULL,
  time_label TEXT DEFAULT '',
  speaker    TEXT DEFAULT '',
  match_state TEXT NOT NULL DEFAULT 'located',
  match_info  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_claim ON evidence(claim_id);

CREATE TABLE IF NOT EXISTS contradictions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  claim_a_id  INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  claim_b_id  INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  types       TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  ignored     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(interview_id, claim_a_id, claim_b_id)
);
CREATE INDEX IF NOT EXISTS idx_contra_interview ON contradictions(interview_id);
`);

// 轻量迁移：为已存在的数据库补充「原文修订影响追踪」所需列
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('interviews', 'revision', "revision INTEGER NOT NULL DEFAULT 0");
ensureColumn('evidence', 'match_state', "match_state TEXT NOT NULL DEFAULT 'located'");
ensureColumn('evidence', 'match_info', "match_info TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS idx_evidence_state ON evidence(match_state);');

module.exports = db;
