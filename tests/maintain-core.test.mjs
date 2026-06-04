// Characterization tests for lib/maintain-core.mjs — the shared maintenance ops
// extracted from cmdMaintain (CLI), mem_maintain (MCP), and handleAutoMaintain
// (hook). Headline: decayAndMarkIdle protects injection_count>0, the clause that
// had drifted out of the MCP copy (mem_maintain used to decay/purge injected
// memories the CLI + hook preserve). The rest pin each op's exact mutation.

import { describe, test, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';
import {
  cleanupBroken, decayAndMarkIdle, boostAccessed, demotePinned,
  mergeDuplicates, purgeStale, purgeStalePreview,
} from '../lib/maintain-core.mjs';

const DAY = 86400000;
const OLD = -40 * DAY; // past the 30-day stale gate
const ctx = (staleAge) => ({ projectFilter: '', baseParams: [], staleAge, opCap: 1000 });
const get = (db, id, col) => db.prepare(`SELECT ${col} AS v FROM observations WHERE id = ?`).get(id).v;
const add = (db, o) => Number(insertObs(db, { sessionId: 'sess-1', project: 'proj-a', epochOffset: OLD, ...o }).lastInsertRowid);

function freshDb() {
  const db = createTestDb();
  insertSession(db, { id: 'sess-1', project: 'proj-a' });
  return db;
}

describe('decayAndMarkIdle (injection protection — the drift fix)', () => {
  test('protects injected rows; decays/marks only never-injected stale rows', () => {
    const db = freshDb();
    const A = add(db, { title: 'injected imp2', importance: 2, injectionCount: 8 }); // protected from decay
    const B = add(db, { title: 'stale imp3', importance: 3, injectionCount: 0 });    // decays 3->2
    const C = add(db, { title: 'injected imp1', importance: 1, injectionCount: 8 }); // protected from mark-idle
    const D = add(db, { title: 'idle imp1', importance: 1, injectionCount: 0 });     // marked pending-purge

    const { decayed, idleMarked } = decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));

    expect(decayed).toBe(1);
    expect(idleMarked).toBe(1);
    expect(get(db, A, 'importance')).toBe(2);                  // injection protected
    expect(get(db, B, 'importance')).toBe(2);                  // decayed 3->2
    expect(get(db, C, 'compressed_into')).toBeNull();          // injection protected
    expect(get(db, D, 'compressed_into')).toBe(COMPRESSED_PENDING_PURGE);
  });
});

describe('execute ops', () => {
  test('cleanupBroken deletes only no-title/no-narrative rows', () => {
    const db = freshDb();
    const broken = add(db, { title: '', narrative: '' });
    const ok = add(db, { title: 'has title', narrative: '' });
    const deleted = cleanupBroken(db, ctx(0));
    expect(deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(broken).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(ok).c).toBe(1);
  });

  test('boostAccessed raises importance of frequently-accessed rows', () => {
    const db = freshDb();
    const hot = add(db, { title: 'hot', importance: 1, accessCount: 5 });
    const cold = add(db, { title: 'cold', importance: 1, accessCount: 1 });
    expect(boostAccessed(db, ctx(0))).toBe(1);
    expect(get(db, hot, 'importance')).toBe(2);
    expect(get(db, cold, 'importance')).toBe(1);
  });

  test('demotePinned drops heavy-injection zero-citation rows to importance 1', () => {
    const db = freshDb();
    const pinned = add(db, { title: 'pinned noise', importance: 3, injectionCount: 8, citedCount: 0 });
    const cited = add(db, { title: 'earns it', importance: 3, injectionCount: 8, citedCount: 2 });
    expect(demotePinned(db, ctx(0))).toBe(1);
    expect(get(db, pinned, 'importance')).toBe(1);
    expect(get(db, cited, 'importance')).toBe(3);
  });

  test('mergeDuplicates marks removeIds compressed into keepId', () => {
    const db = freshDb();
    const keep = add(db, { title: 'canonical' });
    const dup = add(db, { title: 'dup' });
    expect(mergeDuplicates(db, [[keep, dup]])).toBe(1);
    expect(get(db, dup, 'compressed_into')).toBe(keep);
    expect(get(db, keep, 'compressed_into')).toBeNull();
  });

  test('mergeDuplicates ignores self-merge (keepId===removeId) — must not orphan the row', () => {
    // A typo like `--merge-ids 5:5` previously set compressed_into=self, which hides
    // the row from every compressed_into=0 view (recent/search/browse) — silent data loss.
    const db = freshDb();
    const solo = add(db, { title: 'must survive self-merge' });
    expect(mergeDuplicates(db, [[solo, solo]])).toBe(0); // no-op, nothing merged
    expect(get(db, solo, 'compressed_into')).toBeNull(); // row stays live
    // Mixed group: self-ref skipped, real dup still merged.
    const keep = add(db, { title: 'keep' });
    const dup = add(db, { title: 'dup' });
    expect(mergeDuplicates(db, [[keep, keep, dup]])).toBe(1);
    expect(get(db, keep, 'compressed_into')).toBeNull();
    expect(get(db, dup, 'compressed_into')).toBe(keep);
  });

  // --- transitive-merge orphan prevention (data-loss bug class beyond direct self-merge) ---
  // The 1-line `removeId===keepId` guard only catches the DIRECT case. Chained, mutual,
  // and already-compressed-target merges still point a row at a HIDDEN keeper, which
  // vanishes from every compressed_into=0 view. The tool's own mem_maintain "dedup"
  // auto-suggests pairs that can form these chains, so this is reachable in normal use.
  // Invariant under test: no live row may end up compressed_into a non-live row.
  test('mergeDuplicates chain [[A,B],[B,C]] does not orphan C', () => {
    const db = freshDb();
    const A = add(db, { title: 'A keeper' });
    const B = add(db, { title: 'B dup of A' });
    const C = add(db, { title: 'C dup of B' });
    mergeDuplicates(db, [[A, B], [B, C]]);
    // A survives live; B and C collapse DIRECTLY onto the single live keeper A.
    // Pre-fix C->B (the hidden middle): if B is later purgeStale-deleted, C's keeper
    // vanishes and C is unrecoverable. Direct C->A keeps C safe under later purges.
    expect(get(db, A, 'compressed_into')).toBeNull();
    expect(get(db, B, 'compressed_into')).toBe(A);
    expect(get(db, C, 'compressed_into')).toBe(A); // pre-fix: C->B (hidden middle)
  });

  test('mergeDuplicates mutual [[A,B],[B,A]] keeps exactly one live (no total loss)', () => {
    const db = freshDb();
    const A = add(db, { title: 'A' });
    const B = add(db, { title: 'B' });
    mergeDuplicates(db, [[A, B], [B, A]]);
    const aLive = get(db, A, 'compressed_into') === null;
    const bLive = get(db, B, 'compressed_into') === null;
    expect(aLive !== bLive, 'exactly one of A/B must remain live').toBe(true); // pre-fix: BOTH hidden
    // the hidden one points at the live one
    if (aLive) expect(get(db, B, 'compressed_into')).toBe(A);
    else expect(get(db, A, 'compressed_into')).toBe(B);
  });

  test('mergeDuplicates does not merge into an already-compressed keeper (cross-call)', () => {
    const db = freshDb();
    const D = add(db, { title: 'D keeper' });
    const E = add(db, { title: 'E dup of D' });
    const F = add(db, { title: 'F dup of E' });
    mergeDuplicates(db, [[D, E]]);          // E now hidden into D
    mergeDuplicates(db, [[E, F]]);          // keeper E is hidden -> must NOT orphan F
    expect(get(db, F, 'compressed_into')).toBeNull(); // F stays live (pre-fix: F->E hidden)
  });

  test('purgeStale deletes pending-purge rows older than the cutoff; preview counts them', () => {
    const db = freshDb();
    const stale = add(db, { title: 'to purge', compressedInto: COMPRESSED_PENDING_PURGE });
    const cutoff = Date.now() - 30 * DAY;
    expect(purgeStalePreview(db, ctx(0), cutoff).candidates).toBe(1);
    expect(purgeStale(db, ctx(0), cutoff)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(stale).c).toBe(0);
  });

  // --- hard-delete must not orphan a deleted keeper's children (compressed_into has no FK) ---
  const exists = (db, id) => db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(id).c;

  test('purgeStale recovers children of a purged keeper instead of orphaning them', () => {
    const db = freshDb();
    // A keeper that absorbed a dup, later marked idle (compressed_into=PENDING_PURGE).
    const keeper = add(db, { title: 'idle keeper marked for purge', compressedInto: COMPRESSED_PENDING_PURGE });
    const child = add(db, { title: 'dup merged into the keeper', compressedInto: keeper });
    expect(purgeStale(db, ctx(0), Date.now() - 30 * DAY)).toBe(1); // keeper deleted
    expect(exists(db, keeper)).toBe(0);
    expect(exists(db, child)).toBe(1);                  // child survives (pre-fix: orphaned)
    expect(get(db, child, 'compressed_into')).toBeNull(); // recovered: un-hidden, reachable again
  });

  test('cleanupBroken recovers children of a deleted empty keeper', () => {
    const db = freshDb();
    const emptyKeeper = add(db, { title: '', narrative: '' }); // empty-content but a cluster keeper
    const child = add(db, { title: 'dup merged into empty keeper', compressedInto: emptyKeeper });
    expect(cleanupBroken(db, ctx(0))).toBe(1);          // empty keeper deleted
    expect(exists(db, emptyKeeper)).toBe(0);
    expect(exists(db, child)).toBe(1);                  // child survives (pre-fix: orphaned)
    expect(get(db, child, 'compressed_into')).toBeNull();
  });
});
