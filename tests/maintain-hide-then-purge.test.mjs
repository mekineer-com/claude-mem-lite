// D12 (2026-09-29): maintenance hides first and deletes only after a grace, the same for every
// project. Before: markAutoCompressible — which runs only for the project that booted the
// session — HID an old idle row (COMPRESSED_AUTO, kept, reachable by id), while the whole-DB
// idle pass QUEUED every other project's identically-shaped rows for purge, with a grace
// counted from created_at: one day for anything past 37 days. Reproduced with two projects
// and four daily passes: `beta` ended at "Total: 0 observations".
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE } from '../utils.mjs';
import {
  decayAndMarkIdle,
  markAutoCompressible,
  purgeStale,
  HIDE_GRACE_MS,
  STALE_AGE_MS,
} from '../lib/maintain-core.mjs';

const DAY = 86400000;
const ctx = { projectFilter: '', baseParams: [], staleAge: Date.now() - STALE_AGE_MS, opCap: 1000 };
const col = (db, id, c) => db.prepare(`SELECT ${c} AS v FROM observations WHERE id = ?`).get(id)?.v;

function seed() {
  const db = createTestDb();
  const ids = {};
  for (const p of ['alpha', 'beta']) {
    insertSession(db, { id: `s-${p}`, project: p });
    ids[p] = Number(
      insertObs(db, {
        sessionId: `s-${p}`,
        project: p,
        title: `${p} old idle row`,
        importance: 1,
        epochOffset: -45 * DAY,
      }).lastInsertRowid,
    );
  }
  return { db, ids };
}

describe('maintenance hides first, deletes after the grace (D12)', () => {
  it('the booting project and every other project get the same first step: hidden, kept', () => {
    const { db, ids } = seed();
    markAutoCompressible(db, 'alpha'); // what SessionStart runs for the project that booted
    decayAndMarkIdle(db, ctx); // the whole-DB pass
    for (const p of ['alpha', 'beta']) {
      expect(col(db, ids[p], 'compressed_into'), p).toBe(COMPRESSED_AUTO);
      expect(col(db, ids[p], 'hidden_at'), p).toBeGreaterThan(0);
    }
    expect(purgeStale(db, ctx, Date.now() - 37 * DAY)).toBe(0); // nothing is deletable yet
    db.close();
  });

  it('a row still idle a grace after it was hidden is queued, then purged', () => {
    const { db, ids } = seed();
    decayAndMarkIdle(db, ctx);
    const later = Date.now() + HIDE_GRACE_MS + DAY;
    const { idleMarked } = decayAndMarkIdle(db, { ...ctx, now: later });
    expect(idleMarked).toBe(2);
    expect(col(db, ids.beta, 'compressed_into')).toBe(COMPRESSED_PENDING_PURGE);
    expect(purgeStale(db, ctx, Date.now() - 37 * DAY)).toBe(2);
    db.close();
  });

  it('within the grace, or once accessed, a hidden row is not queued', () => {
    const { db, ids } = seed();
    decayAndMarkIdle(db, ctx);
    expect(decayAndMarkIdle(db, { ...ctx, now: Date.now() + HIDE_GRACE_MS - DAY }).idleMarked).toBe(0);
    db.prepare('UPDATE observations SET access_count = 1 WHERE id = ?').run(ids.alpha);
    decayAndMarkIdle(db, { ...ctx, now: Date.now() + HIDE_GRACE_MS + DAY });
    expect(col(db, ids.alpha, 'compressed_into')).toBe(COMPRESSED_AUTO);
    db.close();
  });

  it('a row hidden before hidden_at existed is never queued', () => {
    const { db, ids } = seed();
    db.prepare(
      `UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, hidden_at = NULL WHERE id = ?`,
    ).run(ids.alpha);
    decayAndMarkIdle(db, { ...ctx, now: Date.now() + 365 * DAY });
    expect(col(db, ids.alpha, 'compressed_into')).toBe(COMPRESSED_AUTO);
    db.close();
  });

  it('a DB from the previous release gets hidden_at without a version bump', async () => {
    const { initSchema } = await import('../schema.mjs');
    const { db } = seed();
    db.exec('ALTER TABLE observations DROP COLUMN hidden_at');
    initSchema(db);
    expect(
      db
        .prepare('PRAGMA table_info(observations)')
        .all()
        .map((c) => c.name),
    ).toContain('hidden_at');
    db.close();
  });
});
