import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import {
  insertDeferred, listOpenWithOrdinal, dropDeferred,
} from '../lib/deferred-work.mjs';

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

describe('deferred_work CRUD', () => {
  it('insertDeferred returns id and inserts open row', () => {
    const db = createTestDb();
    const r = insertDeferred(db, {
      project: 'proj-a',
      title: 'Round 2 zero-byte index.db',
      priority: 3,
      detail: 'exit code 不稳定',
    });
    expect(r.id).toBeGreaterThan(0);
    const row = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(r.id);
    expect(row.status).toBe('open');
    expect(row.title).toBe('Round 2 zero-byte index.db');
    expect(row.priority).toBe(3);
    db.close();
  });

  it('listOpenWithOrdinal returns priority DESC, created_at ASC with sequential ordinal', () => {
    const db = createTestDb();
    const _a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 3 });
    const _c = insertDeferred(db, { project: 'p', title: 'C', priority: 2 });
    const list = listOpenWithOrdinal(db, 'p');
    expect(list.map(r => r.title)).toEqual(['B', 'A', 'C']);
    expect(list.map(r => r.ordinal)).toEqual([1, 2, 3]);
    expect(list.find(r => r.title === 'B').id).toBe(b.id);
    db.close();
  });

  it('listOpenWithOrdinal filters by project', () => {
    const db = createTestDb();
    insertDeferred(db, { project: 'p1', title: 'A', priority: 2 });
    insertDeferred(db, { project: 'p2', title: 'B', priority: 2 });
    expect(listOpenWithOrdinal(db, 'p1').map(r => r.title)).toEqual(['A']);
    expect(listOpenWithOrdinal(db, 'p2').map(r => r.title)).toEqual(['B']);
    db.close();
  });

  it('listOpenWithOrdinal excludes done and dropped', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 2 });
    db.prepare(`UPDATE deferred_work SET status='done' WHERE id=?`).run(a.id);
    db.prepare(`UPDATE deferred_work SET status='dropped' WHERE id=?`).run(b.id);
    expect(listOpenWithOrdinal(db, 'p')).toEqual([]);
    db.close();
  });

  it('dropDeferred sets status=dropped with reason and refuses non-open', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const r = dropDeferred(db, a.id, 'no longer relevant');
    expect(r.changed).toBe(1);
    const row = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(a.id);
    expect(row.status).toBe('dropped');
    expect(row.drop_reason).toBe('no longer relevant');
    expect(row.closed_at_epoch).toBeGreaterThan(0);
    // second drop should be no-op (status no longer 'open')
    const r2 = dropDeferred(db, a.id, 'again');
    expect(r2.changed).toBe(0);
    db.close();
  });

  it('dropDeferred requires non-empty reason', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    expect(() => dropDeferred(db, a.id, '')).toThrow(/reason/i);
    expect(() => dropDeferred(db, a.id, '   ')).toThrow(/reason/i);
    db.close();
  });
});
