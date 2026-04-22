// Shared test utilities for claude-mem-lite
// Single source of truth: uses initSchema/registry schemas — no DDL duplication

import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { RESOURCES_SCHEMA, FTS5_SCHEMA, TRIGGERS_SCHEMA, INVOCATIONS_SCHEMA, PREINSTALLED_SCHEMA } from '../registry.mjs';

/**
 * Create an in-memory test database with full production schema + FTS5.
 * Uses initSchema() from schema.mjs — single source of truth.
 */
export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
}

/**
 * Create an in-memory registry test database with full production schema.
 * Uses exported schemas from registry.mjs — single source of truth.
 */
export function createRegistryTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = ON');
  db.exec(RESOURCES_SCHEMA);
  db.exec(FTS5_SCHEMA);
  db.exec(TRIGGERS_SCHEMA);
  db.exec(INVOCATIONS_SCHEMA);
  db.exec(PREINSTALLED_SCHEMA);
  return db;
}

export function insertSession(db, { id, project = 'test', memoryId = null }) {
  const now = new Date();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(id, memoryId ?? id, project, now.toISOString(), now.getTime());
}

/**
 * Insert into user_prompts for tests that need to exercise the
 * prompts-table fallback path in user-prompt-search.js (v2.34.5+).
 * Matches the shape produced by hook-episode.mjs at runtime.
 */
export function insertPrompt(db, { contentSessionId = 'sess-1', text, promptNumber = 1, epochOffset = 0 }) {
  const now = Date.now() + epochOffset;
  const result = db.prepare(`
    INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(contentSessionId, text, promptNumber, new Date(now).toISOString(), now);
  return result;
}

export function insertObs(db, { sessionId = 'sess-1', project = 'test', type = 'discovery', title, subtitle = '', text = '', narrative = '', importance = 1, relatedIds = '[]', epochOffset = 0, filesModified = '[]', accessCount = 0, compressedInto = null, lessonLearned = null, searchAliases = null, branch = null, supersededAt = null, supersededBy = null, lastAccessedAt = null }) {
  const now = Date.now() + epochOffset;
  const result = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, related_ids, access_count, compressed_into, lesson_learned, search_aliases, branch, superseded_at, superseded_by, last_accessed_at, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, project, text, type, title, subtitle, narrative, filesModified, importance, relatedIds, accessCount, compressedInto, lessonLearned, searchAliases, branch, supersededAt, supersededBy, lastAccessedAt, new Date(now).toISOString(), now);

  // Also populate observation_files junction table (mirrors saveObservation behavior)
  if (filesModified && filesModified !== '[]') {
    try {
      const files = JSON.parse(filesModified);
      if (Array.isArray(files)) {
        const obsId = Number(result.lastInsertRowid);
        const insertFile = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
        for (const f of files) {
          if (typeof f === 'string' && f.length > 0) insertFile.run(obsId, f);
        }
      }
    } catch { /* skip malformed JSON */ }
  }

  return result;
}
