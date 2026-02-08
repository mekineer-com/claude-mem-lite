// claude-mem-lite shared database schema and initialization
// Used by both server.mjs (MCP process) and hook.mjs (hook process)
// Ensures DB + tables exist regardless of which process starts first

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

export const DB_DIR = join(homedir(), 'claude-mem-lite');
export const DB_PATH = join(DB_DIR, 'claude-mem.db');

const CORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sdk_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT NOT NULL UNIQUE,
    memory_session_id TEXT,
    project TEXT NOT NULL,
    user_prompt TEXT,
    started_at TEXT NOT NULL,
    started_at_epoch INTEGER NOT NULL,
    completed_at TEXT,
    completed_at_epoch INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    worker_port INTEGER,
    prompt_counter INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    text TEXT,
    type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
    title TEXT,
    subtitle TEXT,
    facts TEXT,
    narrative TEXT,
    concepts TEXT,
    files_read TEXT,
    files_modified TEXT,
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    files_read TEXT,
    files_edited TEXT,
    notes TEXT,
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT NOT NULL,
    prompt_text TEXT,
    prompt_number INTEGER,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );
`;

// Column migrations (idempotent — only swallow "duplicate column" errors)
const MIGRATIONS = [
  'ALTER TABLE observations ADD COLUMN importance INTEGER DEFAULT 1',
  'ALTER TABLE observations ADD COLUMN related_ids TEXT DEFAULT \'[]\'',
  'ALTER TABLE observations ADD COLUMN minhash_sig TEXT',
  'ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0',
  'ALTER TABLE observations ADD COLUMN compressed_into INTEGER DEFAULT NULL',
];

/**
 * Ensure DB directory, database file, and all tables exist.
 * Safe to call from any process (hook or server). Idempotent.
 * Returns an opened Database instance with WAL + busy_timeout configured.
 */
export function ensureDb() {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF'); // Enabled after dedup migration

  // Create core tables
  db.exec(CORE_SCHEMA);

  // Run column migrations
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) {
      if (!e.message?.includes('duplicate column name')) throw e;
    }
  }

  // Dedup migration: ensure memory_session_id is unique, then enable FK
  const hasIdx = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sess_memory_sid'`).get();
  if (!hasIdx) {
    const dupes = db.prepare(`
      SELECT memory_session_id, COUNT(*) as cnt
      FROM sdk_sessions
      WHERE memory_session_id IS NOT NULL
      GROUP BY memory_session_id HAVING cnt > 1
    `).all();

    if (dupes.length > 0) {
      const dedup = db.transaction(() => {
        for (const { memory_session_id } of dupes) {
          const rows = db.prepare(`
            SELECT s.id FROM sdk_sessions s
            WHERE s.memory_session_id = ?
            ORDER BY s.id ASC
          `).all(memory_session_id);
          for (let i = 1; i < rows.length; i++) {
            db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(rows[i].id);
          }
        }
      });
      dedup();
    }

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sess_memory_sid ON sdk_sessions(memory_session_id)`);
  }
  db.pragma('foreign_keys = ON');

  // Performance indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_epoch_project ON observations(created_at_epoch DESC, project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sess_sum_epoch ON session_summaries(created_at_epoch DESC, project)`);

  return db;
}
