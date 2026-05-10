import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import {
  insertDeferred, listOpenWithOrdinal, dropDeferred,
  resolveDeferredIds, closeDeferredItems,
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

  it('listOpenWithOrdinal recomputes ordinal after close', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    insertDeferred(db, { project: 'p', title: 'B', priority: 2 });
    insertDeferred(db, { project: 'p', title: 'C', priority: 2 });
    db.prepare(`UPDATE deferred_work SET status='done' WHERE id=?`).run(a.id);
    const list = listOpenWithOrdinal(db, 'p');
    expect(list.map(r => r.title)).toEqual(['B', 'C']);
    expect(list.map(r => r.ordinal)).toEqual([1, 2]);
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

describe('deferred_work closure', () => {
  it('resolveDeferredIds maps ordinal int → real id within project', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 3 });
    // Ordinal 1 should be B (priority 3 wins). Ordinal 2 should be A.
    expect(resolveDeferredIds(db, 'p', [1, 2])).toEqual([b.id, a.id]);
    db.close();
  });

  it('resolveDeferredIds maps "D#N" string → raw id (project-scoped)', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    expect(resolveDeferredIds(db, 'p', [`D#${a.id}`])).toEqual([a.id]);
    db.close();
  });

  it('resolveDeferredIds rejects unknown string shape', () => {
    const db = createTestDb();
    expect(() => resolveDeferredIds(db, 'p', ['#42'])).toThrow(/D#N or integer ordinal/);
    expect(() => resolveDeferredIds(db, 'p', ['foo'])).toThrow(/D#N or integer ordinal/);
    db.close();
  });

  it('resolveDeferredIds rejects ordinal out of range', () => {
    const db = createTestDb();
    insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    expect(() => resolveDeferredIds(db, 'p', [5])).toThrow(/ordinal 5/);
    db.close();
  });

  it('resolveDeferredIds rejects D#N from foreign project', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p1', title: 'A', priority: 2 });
    expect(() => resolveDeferredIds(db, 'p2', [`D#${a.id}`])).toThrow(
      new RegExp(`D#${a.id}.*project.*p1`)
    );
    db.close();
  });

  it('resolveDeferredIds rejects done/dropped items', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    db.prepare(`UPDATE deferred_work SET status='done' WHERE id=?`).run(a.id);
    expect(() => resolveDeferredIds(db, 'p', [`D#${a.id}`])).toThrow(/status.*done/);
    db.close();
  });

  it('closeDeferredItems updates status + closed_by_obs_id atomically', () => {
    const db = createTestDb();
    // initSchema enables FKs at end of migration; disable here so we can pass
    // a fabricated obs id without setting up an observations row. The unit
    // under test is the UPDATE semantics, not FK enforcement.
    db.pragma('foreign_keys = OFF');
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 2 });
    closeDeferredItems(db, [a.id, b.id], 999);
    const ra = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(a.id);
    const rb = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(b.id);
    expect(ra.status).toBe('done');
    expect(ra.closed_by_obs_id).toBe(999);
    expect(ra.closed_at_epoch).toBeGreaterThan(0);
    expect(rb.status).toBe('done');
    db.close();
  });

  it('closeDeferredItems rolls back when one id is invalid', () => {
    const db = createTestDb();
    db.pragma('foreign_keys = OFF'); // see note in atomicity test above
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    // 999 is a non-existent deferred id
    expect(() => closeDeferredItems(db, [a.id, 999], 1234)).toThrow();
    const ra = db.prepare(`SELECT status FROM deferred_work WHERE id=?`).get(a.id);
    expect(ra.status).toBe('open'); // unchanged
    db.close();
  });

  it('resolveDeferredIds rejects duplicate tokens that resolve to the same id', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    // ordinal 1 and "D#<a.id>" both resolve to a.id — must reject as duplicate.
    expect(() => resolveDeferredIds(db, 'p', [1, `D#${a.id}`])).toThrow(/duplicate.*id/i);
    // also bare-int duplicate
    expect(() => resolveDeferredIds(db, 'p', [1, 1])).toThrow(/duplicate.*id/i);
    db.close();
  });
});
