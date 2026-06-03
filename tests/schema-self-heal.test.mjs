import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

describe('initSchema self-heal — version-vs-columns mismatch (D#22)', () => {
  // The self-heal sentinel is LATEST_MIGRATION_COLUMN, which moved to
  // user_prompts.cc_session_id in v37 (D#26). Drop the index first — cc_session_id is
  // indexed (idx_user_prompts_cc), and SQLite refuses DROP COLUMN on an indexed column.
  it('falls through to migration re-apply when schema_version matches but latest sentinel column is missing', () => {
    const db = new Database(':memory:');
    initSchema(db); // clean init — DB at CURRENT_SCHEMA_VERSION with all columns
    // Simulate the half-migrated state observed in dev during v2.74.0 release:
    // version row reads CURRENT but the latest migration's column is missing.
    db.exec('DROP INDEX IF EXISTS idx_user_prompts_cc');
    db.exec('ALTER TABLE user_prompts DROP COLUMN cc_session_id');
    expect(
      db.prepare("SELECT name FROM pragma_table_info('user_prompts') WHERE name='cc_session_id'").all()
    ).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(CURRENT_SCHEMA_VERSION);

    initSchema(db); // expected: detects missing column, re-runs migrations idempotently

    expect(
      db.prepare("SELECT name FROM pragma_table_info('user_prompts') WHERE name='cc_session_id'").get()
    ).toEqual({ name: 'cc_session_id' });
    db.close();
  });

  it('fast-path stays a no-op when both version and sentinel column are present', () => {
    const db = new Database(':memory:');
    initSchema(db);
    initSchema(db); // second call — should be cheap, no errors
    // Sentinel column still intact, version still pinned.
    expect(
      db.prepare("SELECT name FROM pragma_table_info('user_prompts') WHERE name='cc_session_id'").get()
    ).toEqual({ name: 'cc_session_id' });
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});
