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
  mergeDuplicates, purgeStale, purgeStalePreview, recoverChildrenOf,
  selectFuzzyDedupeIds, maintenanceStats, hardDeleteCandidateCount,
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

describe('hardDeleteCandidateCount (MED-2 pre-maintenance snapshot guard)', () => {
  test('counts pending-purge and/or broken rows per selected ops; 0 when none', () => {
    const db = freshDb();
    add(db, { title: 'live' });                                          // neither
    add(db, { title: 'doomed', compressedInto: COMPRESSED_PENDING_PURGE }); // purge candidate
    add(db, { title: '', narrative: '' });                              // broken candidate

    expect(hardDeleteCandidateCount(db, ctx(), { purge: true })).toBe(1);
    expect(hardDeleteCandidateCount(db, ctx(), { cleanup: true })).toBe(1);
    expect(hardDeleteCandidateCount(db, ctx(), { cleanup: true, purge: true })).toBe(2);
    expect(hardDeleteCandidateCount(db, ctx(), {})).toBe(0); // no destructive op selected
    db.close();
  });

  test('returns 0 on a clean DB (no snapshot taken for a no-op maintenance run)', () => {
    const db = freshDb();
    add(db, { title: 'healthy', narrative: 'fine' });
    expect(hardDeleteCandidateCount(db, ctx(), { cleanup: true, purge: true })).toBe(0);
    db.close();
  });
});

describe('recoverChildrenOf (shared hard-delete guard — CLI + MCP + maintain)', () => {
  test('resets compressed_into to NULL for rows pointing at the doomed keepers', () => {
    const db = freshDb();
    const keeper = add(db, { title: 'keeper' });
    const childA = add(db, { title: 'child A', compressedInto: keeper });
    const childB = add(db, { title: 'child B', compressedInto: keeper });
    const unrelated = add(db, { title: 'unrelated', compressedInto: 99999 });

    const recovered = recoverChildrenOf(db, [keeper]);

    expect(recovered).toBe(2);
    expect(get(db, childA, 'compressed_into')).toBeNull(); // resurfaced as live
    expect(get(db, childB, 'compressed_into')).toBeNull();
    expect(get(db, unrelated, 'compressed_into')).toBe(99999); // untouched
  });

  test('no-op (returns 0) when the id list is empty', () => {
    const db = freshDb();
    expect(recoverChildrenOf(db, [])).toBe(0);
  });

  test('does not recover (or count) a child that is itself in the delete set', () => {
    // `delete 1,2` where #2 was merged INTO #1: #2 must NOT be reported as recovered-to-live
    // because it is deleted in the same call. Only children that actually survive count.
    const db = freshDb();
    const keeper = add(db, { title: 'keeper' });
    const childInSet = add(db, { title: 'child also deleted', compressedInto: keeper });
    const childKept = add(db, { title: 'child that survives', compressedInto: keeper });

    // Recover for a delete of BOTH keeper and childInSet.
    const recovered = recoverChildrenOf(db, [keeper, childInSet]);
    expect(recovered).toBe(1); // only childKept, not childInSet
    expect(get(db, childKept, 'compressed_into')).toBeNull();
    expect(get(db, childInSet, 'compressed_into')).toBe(keeper); // untouched (it's being deleted)
  });
});

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

describe('maintenanceStats (scan preview must match what execute does)', () => {
  // Regression: the scan "Stale (>30d, imp=1, no access)" count omitted the
  // injection_count=0 guard that decayAndMarkIdle's mark-idle pass enforces
  // (v2.56.0 / #8614). So `maintain scan` over-counted stale by including
  // injected-but-decayed rows decay will NEVER mark idle — e.g. exactly the rows
  // `demote_pinned` just dropped to imp=1 (they keep inj>0). User sees "Stale: 2",
  // runs decay, gets "marked 0 idle" → the same scan↔execute drift #8614 fixed.
  test('stale count excludes injection-protected rows (parity with decay mark-idle)', () => {
    const db = freshDb();
    add(db, { title: 'idle never injected', importance: 1, injectionCount: 0 }); // decay marks idle → stale
    add(db, { title: 'idle but injected', importance: 1, injectionCount: 8 });   // decay PROTECTS → not stale

    const stats = maintenanceStats(db, ctx(Date.now() - 30 * DAY));
    expect(stats.stale).toBe(1); // only the never-injected row (was 2 pre-fix)

    // The parity claim itself: scan's stale count == rows decay actually marks idle.
    const { idleMarked } = decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));
    expect(idleMarked).toBe(stats.stale);
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

// Audit 2026-06-22 P2 #8: the hook fuzzy-dedup pass compared TITLES only (a word-set
// metric), so distinct observations sharing a title token-set were auto-hidden. The
// pass now also requires body similarity. selectFuzzyDedupeIds is the extracted pure
// core so this is unit-testable without driving the whole SessionStart hook.
describe('selectFuzzyDedupeIds — title + body fuzzy dedup (audit #8)', () => {
  const row = (id, title, body, importance = 1) => ({ id, title, body, importance });

  // Both titles carry the IDENTICAL token set, just reordered → title Jaccard = 1.0
  // (clears the 0.95 floor). So the BODY comparison is the only thing that decides,
  // which is exactly what audit #8 added. (Using titles that differ by a token would
  // pass-for-the-wrong-reason: blocked on title, not body.)
  const TITLE_A = 'Fix auth bug login handler';
  const TITLE_B = 'Fix login handler auth bug';

  test('dedupes a genuine re-save: same title token-set AND near-identical body', () => {
    const rows = [
      row(1, TITLE_A, 'auth token was not refreshed on expiry so calls returned 401'),
      row(2, TITLE_B, 'auth token was not refreshed on expiry so calls returned 401 again'),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([2]);
  });

  test('does NOT dedupe same-title-token-set rows with DIFFERENT bodies (the fix)', () => {
    const rows = [
      row(1, TITLE_A, 'root cause was a missing await on the refresh call'),
      row(2, TITLE_B, 'root cause was an off-by-one in the retry backoff loop'),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([]);
  });

  test('dedupes when both bodies are empty (no body to differ)', () => {
    const rows = [row(1, 'Modified config json file', ''), row(2, 'Modified config json file', '')];
    expect(selectFuzzyDedupeIds(rows)).toEqual([2]);
  });

  test('does NOT dedupe when one row has a body and the other does not', () => {
    const rows = [
      row(1, 'Modified config json file', 'added the retry flag and bumped the timeout to thirty'),
      row(2, 'Modified config json file', ''),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([]);
  });

  test('keeps the higher-importance row and removes the lower-importance peer', () => {
    const rows = [
      row(1, 'Fix the auth bug in login', 'identical body text shared by both candidate rows', 1),
      row(2, 'Fix the auth bug in login', 'identical body text shared by both candidate rows', 3),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([1]);
  });
});
