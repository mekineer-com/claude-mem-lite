// Schema tests — additive `events` table + FTS5 (v2.31 T6)
// Verifies events table, FTS5 virtual table, triggers, and idempotent migration.

import { describe, test, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';

describe('events table (T6)', () => {
  test('events table + FTS virtual table created fresh', () => {
    const db = createTestDb();
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    const colNames = cols.map(c => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        'id', 'project', 'event_type', 'title', 'body',
        'file_paths', 'git_sha', 'importance',
        'created_at_epoch', 'accessed_count', 'last_accessed_epoch',
        'superseded_at_epoch', 'superseded_by_id',
      ])
    );
    const fts = db.prepare(`SELECT name FROM sqlite_master WHERE name='events_fts'`).get();
    expect(fts).toBeTruthy();
  });

  test('event insertion propagates to FTS', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('mem', 'bugfix', 'fix null deref in foo', 'root cause: missing nullcheck in bar()', 2, Date.now());
    const hit = db.prepare(`
      SELECT events.title FROM events_fts
      JOIN events ON events.id = events_fts.rowid
      WHERE events_fts MATCH ?
    `).get('nullcheck');
    expect(hit?.title).toContain('null deref');
  });

  test('event_type enum rejects invalid types', () => {
    const db = createTestDb();
    expect(() => db.prepare(`
      INSERT INTO events (project, event_type, title, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run('mem', 'not_a_real_type', 't', 1, Date.now())).toThrow();
  });

  test('event deletion cascades to FTS', () => {
    const db = createTestDb();
    const info = db.prepare(`
      INSERT INTO events (project, event_type, title, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run('mem', 'lesson', 'to be deleted', 1, Date.now());
    db.prepare(`DELETE FROM events WHERE id = ?`).run(info.lastInsertRowid);
    const hit = db.prepare(`
      SELECT * FROM events_fts WHERE events_fts MATCH ?
    `).get('deleted');
    expect(hit).toBeUndefined();
  });

  test('migration is idempotent (running initSchema twice is safe)', () => {
    const db = createTestDb();
    // createTestDb already invoked initSchema — running it again on the same
    // opened DB must not throw and must leave events table intact.
    expect(() => initSchema(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    expect(cols.length).toBeGreaterThan(0);
  });

  test('idx_events_project_created compound index exists', () => {
    const db = createTestDb();
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE name='idx_events_project_created'`).get();
    expect(idx).toBeTruthy();
  });
});
