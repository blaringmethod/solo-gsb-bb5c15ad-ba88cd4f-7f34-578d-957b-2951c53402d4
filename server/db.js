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
  seg_ord    INTEGER,
  match_status   TEXT NOT NULL DEFAULT 'matched',
  pending_reason TEXT NOT NULL DEFAULT '',
  match_candidates TEXT NOT NULL DEFAULT '[]',
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

// 轻量迁移：为旧版本数据库补齐“原文修订影响追踪”相关列
{
  const cols = new Set(db.prepare('PRAGMA table_info(evidence)').all().map((c) => c.name));
  const addCol = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE evidence ADD COLUMN ${ddl}`); };
  addCol('seg_ord', 'seg_ord INTEGER');
  addCol('match_status', "match_status TEXT NOT NULL DEFAULT 'matched'");
  addCol('pending_reason', "pending_reason TEXT NOT NULL DEFAULT ''");
  addCol('match_candidates', "match_candidates TEXT NOT NULL DEFAULT '[]'");
}

module.exports = db;
