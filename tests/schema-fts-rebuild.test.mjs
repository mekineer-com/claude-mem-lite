import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

// Regression: when an old observations_fts predating the lesson_learned/search_aliases
// columns is recreated by the migration, the index is left empty and must be rebuilt
// from the content table. The old emptiness probe `SELECT COUNT(*) FROM observations_fts`
// reads the CONTENT table (external-content FTS5), not the index, so it never detected
// the empty index and the rebuild was dead code — full-text search silently returned 0.
describe('schema — observations_fts rebuild after column-mismatch recreation', () => {
  it('repopulates the FTS index so MATCH works after the recreation migration', () => {
    const db = new Database(':memory:');
    initSchema(db);

    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES ('s1', 's1', 'p', '2026-01-01', 1, 'active')`
    ).run();
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'findme content body', 'discovery', 'findme title', '2026-01-01', 1)`
    ).run();
    // Sanity: fresh-DB triggers indexed it.
    expect(db.prepare(`SELECT COUNT(*) c FROM observations_fts WHERE observations_fts MATCH 'findme'`).get().c).toBe(1);

    // Simulate a pre-migration DB: legacy 6-column FTS (no lesson_learned/search_aliases),
    // triggers dropped, version rolled back so initSchema re-runs the migration pass.
    db.exec(`DROP TRIGGER IF EXISTS observations_ai`);
    db.exec(`DROP TRIGGER IF EXISTS observations_ad`);
    db.exec(`DROP TRIGGER IF EXISTS observations_au`);
    db.exec(`DROP TABLE IF EXISTS observations_fts`);
    db.exec(`CREATE VIRTUAL TABLE observations_fts USING fts5(title, narrative, concepts, facts, text, type, content=observations, content_rowid=id)`);
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION - 1);

    initSchema(db);

    // The migration must have recreated the 8-column FTS AND repopulated it.
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='observations_fts'`).get();
    expect(ddl.sql).toContain('lesson_learned');
    expect(ddl.sql).toContain('search_aliases');
    expect(db.prepare(`SELECT COUNT(*) c FROM observations_fts WHERE observations_fts MATCH 'findme'`).get().c).toBe(1);
    db.close();
  });
});
