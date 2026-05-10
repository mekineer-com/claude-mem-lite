import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';

describe('deferred_work schema (v31)', () => {
  it('creates deferred_work table with required columns', () => {
    const db = createTestDb();
    const cols = db.prepare(`PRAGMA table_info(deferred_work)`).all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'project', 'title', 'detail', 'priority', 'status',
      'created_at_epoch', 'closed_at_epoch', 'closed_by_obs_id',
      'drop_reason', 'source_session_id', 'source_prompt_id', 'files',
    ]));
    db.close();
  });

  it('creates partial index on open items', () => {
    const db = createTestDb();
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_deferred_open'`).get();
    expect(idx).toBeTruthy();
    expect(idx.sql).toMatch(/WHERE\s+status\s*=\s*'open'/i);
    db.close();
  });
});
