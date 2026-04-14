// lib/activity.mjs — activity namespace data layer (T7 v2.31)
// Pure functions over the events table. No I/O beyond the passed-in db handle.
//
// Activity events are NOT memdir-compatible types; they live here precisely
// so they don't pollute the L1 system-prompt memory section.

import { sanitizeFtsQuery } from '../utils.mjs';

/**
 * Canonical event_type enum — mirrors the events.event_type CHECK constraint.
 * Single source of truth for CLI validation, hook-llm (future T9), and any
 * other caller that needs to guard against invalid types before INSERT.
 * Order matches the DDL; frozen to prevent accidental mutation.
 */
export const EVENT_TYPES = Object.freeze([
  'bugfix',
  'lesson',
  'bug',
  'discovery',
  'refactor',
  'feature',
  'observation',
  'decision',
]);

/**
 * Insert one event. Returns the new id (Number cast from BigInt).
 *
 * @param {object} db better-sqlite3 handle
 * @param {object} params
 * @param {string} params.project
 * @param {string} params.event_type  one of the CHECK-constrained enum values
 * @param {string} params.title
 * @param {string|null} [params.body]
 * @param {string[]|null} [params.file_paths]  stored as JSON array
 * @param {string|null} [params.git_sha]
 * @param {number} [params.importance=1]
 * @param {number} [params.created_at_epoch=Date.now()]
 * @returns {number} lastInsertRowid
 */
export function saveEvent(db, {
  project,
  event_type,
  title,
  body = null,
  file_paths = null,
  git_sha = null,
  importance = 1,
  created_at_epoch = Date.now(),
}) {
  const info = db.prepare(`
    INSERT INTO events (project, event_type, title, body, file_paths, git_sha, importance, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project,
    event_type,
    title,
    body,
    file_paths ? JSON.stringify(file_paths) : null,
    git_sha,
    importance,
    created_at_epoch,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Fetch one event by id, bumping accessed_count + last_accessed_epoch.
 * Returns the row (access bump already applied) or undefined.
 */
export function getEvent(db, id) {
  db.prepare(`UPDATE events SET accessed_count = accessed_count + 1, last_accessed_epoch = ? WHERE id = ?`)
    .run(Date.now(), id);
  return db.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
}

/**
 * FTS5 search filtered by project (and optionally event_type).
 * Excludes superseded events. Returns up to `limit` rows ordered by FTS rank.
 */
export function searchEvents(db, query, { project, type = null, limit = 10 } = {}) {
  const q = sanitizeFtsQuery(query);
  if (!q) return [];
  const typeClause = type ? 'AND e.event_type = ?' : '';
  const sql = `
    SELECT e.*
    FROM events_fts
    JOIN events e ON e.id = events_fts.rowid
    WHERE events_fts MATCH ?
      AND e.project = ?
      AND e.superseded_at_epoch IS NULL
      ${typeClause}
    ORDER BY events_fts.rank
    LIMIT ?
  `;
  const params = type ? [q, project, type, limit] : [q, project, limit];
  return db.prepare(sql).all(...params);
}

/**
 * Most recent N events for a project (excluding superseded).
 * Uses idx_events_project_created (T6.1) — index-only sort, no temp B-tree.
 */
export function recentEvents(db, { project, type = null, limit = 20 } = {}) {
  const typeClause = type ? 'AND event_type = ?' : '';
  const sql = `
    SELECT * FROM events
    WHERE project = ? AND superseded_at_epoch IS NULL ${typeClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `;
  const params = type ? [project, type, limit] : [project, limit];
  return db.prepare(sql).all(...params);
}
