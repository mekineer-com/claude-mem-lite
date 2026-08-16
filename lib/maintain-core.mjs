// Shared maintenance operations — single source of truth for cmdMaintain (CLI),
// mem_maintain (MCP), and handleAutoMaintain (hook). Pre-extraction each
// operation's SQL was copy-pasted across the call sites and kept in sync by
// "parity" comments, which had already drifted: the CLI/hook `decay` and
// `mark-idle` protect injection_count>0 (v2.56.0 — an obs Claude was shown 8×
// is contextually proven), but the MCP copy never got that clause, so
// mem_maintain decayed/purged injected memories the other two paths preserve.
// Consolidating here UNIFIES decay/mark-idle on the protected (correct) form.
//
// Every mutation is statement-only — the CALLER owns the transaction boundary
// (CLI/MCP wrap the execute ops in one transaction; the hook runs them in its
// auto-maintain block). `ctx` carries the per-caller knobs:
//   { projectFilter: 'AND project = ?' | '', baseParams: [project?] , staleAge, opCap }

import { COMPRESSED_PENDING_PURGE, computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity } from '../utils.mjs';
import { rebuildVocabulary, computeVector, _resetVocabCache, vectorsEnabled, vecTextForRow } from '../tfidf.mjs';
import { DEDUP_JACCARD_THRESHOLD, MINHASH_PRE_THRESHOLD as MINHASH_PRE_THRESHOLD_SRC, FUZZY_DEDUP_THRESHOLD, FUZZY_BODY_THRESHOLD, MINHASH_PREFILTER } from './dedup-constants.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';

export const STALE_AGE_MS = 30 * 86400000;
export const OP_CAP = 1000;
export const SCAN_LIMIT = 500;
export const DUPLICATE_LIMIT = 50;
// Back-compat: maintain-core historically exported these names; both now source
// their value from the single canonical lib/dedup-constants.mjs.
export const SIMILARITY_THRESHOLD = DEDUP_JACCARD_THRESHOLD;
export const MINHASH_PRE_THRESHOLD = MINHASH_PRE_THRESHOLD_SRC;
// A memory injected this many times with zero citations is "pinned noise" that
// the regular decay op can't touch (decay protects injection_count>0).
export const PINNED_INJ_THRESHOLD = 8;

// Two trimmed bodies count as "the same body" when both are empty (a genuine
// no-body re-save) or their word-set Jaccard clears the floor. One-empty-one-not
// is treated as DISTINCT so a body-bearing observation is never hidden by a
// body-less peer that merely shares its title.
function bodiesSimilar(a, b, threshold) {
  const ba = (a || '').trim();
  const bb = (b || '').trim();
  if (!ba && !bb) return true;
  if (!ba || !bb) return false;
  return jaccardSimilarity(ba, bb) >= threshold;
}

/**
 * Pick which near-duplicate observation ids to supersede in the hook fuzzy-dedup
 * pass. Pure (no DB) so it is unit-testable. A pair must clear BOTH the title
 * thresholds (MinHash prefilter → exact title Jaccard) AND the body Jaccard floor
 * before the lower-importance row is marked for superseding (audit #8 — title-only
 * matching collapsed observations with the same title token-set but different bodies).
 * @param {Array<{id:number,title:string,body:string,importance:number}>} rows
 *        Candidate rows in scan order (caller decides ordering / recency window).
 * @returns {number[]} ids to supersede (lower-importance member of each kept pair).
 */
export function selectFuzzyDedupeIds(rows, {
  titleThreshold = FUZZY_DEDUP_THRESHOLD,
  bodyThreshold = FUZZY_BODY_THRESHOLD,
  minhashPrefilter = MINHASH_PREFILTER,
  maxMerges = 20,
} = {}) {
  const removeIds = [];
  if (!Array.isArray(rows) || rows.length < 2) return removeIds;
  const removed = new Set();
  const titles = rows.map(r => (r.title || '').trim());
  const minhashes = titles.map(t => t ? computeMinHash(t) : null);
  outer: for (let i = 0; i < rows.length; i++) {
    if (!minhashes[i] || removed.has(rows[i].id)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (!minhashes[j] || removed.has(rows[j].id)) continue;
      if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < minhashPrefilter) continue;
      if (jaccardSimilarity(titles[i], titles[j]) < titleThreshold) continue;
      if (!bodiesSimilar(rows[i].body, rows[j].body, bodyThreshold)) continue;
      // Keep the higher-importance row; tiebreak by earlier scan position (kept as i).
      const keep = (rows[i].importance ?? 1) >= (rows[j].importance ?? 1) ? rows[i] : rows[j];
      const remove = keep === rows[i] ? rows[j] : rows[i];
      removeIds.push(remove.id);
      removed.add(remove.id);
      if (removeIds.length >= maxMerges) break outer;
    }
  }
  return removeIds;
}

/** Delete broken observations (no title AND no narrative). Returns rows deleted. */
// Before hard-deleting observations, un-hide any rows merged INTO them. A child has
// compressed_into = <keeperId>; deleting that keeper (compressed_into has no FK) would
// leave the child dangling behind a now-missing parent — hidden from every
// COALESCE(compressed_into,0)=0 view and unrecoverable. Recovery = resurface the child
// as live (NULL) rather than lose it silently. Shared by every hard-delete path:
// maintain (cleanupBroken/purgeStale) AND the interactive `delete` / MCP mem_delete.
export function recoverChildrenOf(db, ids) {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  // `AND id NOT IN (...)`: never "recover" a row that is itself being deleted in the same
  // call (e.g. `delete 1,2` where #2 was merged into #1). Without it, #2 is un-hidden and
  // then immediately deleted, inflating the reported recovery count with a row that did not
  // survive. Recovery should count only children that actually stay live.
  return db.prepare(
    `UPDATE observations SET compressed_into = NULL WHERE compressed_into IN (${ph}) AND id NOT IN (${ph})`
  ).run(...ids, ...ids).changes;
}

// Resurface children orphaned by a keeper hard-deleted BEFORE recoverChildrenOf existed
// (legacy data). recoverChildrenOf only fires at delete time for the keepers being deleted
// in that call; rows whose keeper vanished in a past release are missed forever. A child
// with compressed_into = <positive keeperId> whose keeper row no longer exists is hidden
// from every COALESCE(compressed_into,0)=0 view AND sits in no maintenance queue (not
// COMPRESSED_AUTO, not COMPRESSED_PENDING_PURGE), so nothing ever resurfaces or GCs it —
// it leaks its full narrative out of reach. Setting compressed_into = NULL makes it live
// again; normal decay/GC then handles it on merit. `compressed_into > 0` excludes the
// negative sentinels (intentional states, not orphans). NON-DESTRUCTIVE: only un-hides
// rows, never deletes — safe to run unconditionally, no snapshot needed.
export function recoverOrphanedChildren(db, { projectFilter = '', baseParams = [] } = {}) {
  return db.prepare(`
    UPDATE observations SET compressed_into = NULL
    WHERE compressed_into > 0
      AND NOT EXISTS (SELECT 1 FROM observations k WHERE k.id = observations.compressed_into)
      ${projectFilter}
  `).run(...baseParams).changes;
}

// Heal lesson-bearing rows that citation-decay buried at importance 0 under the old
// IMPORTANCE_FLOOR=0 (fixed in citation-tracker.mjs → floor 1). All passive injection
// surfaces exclude importance 0 (pre-tool-recall >=2, user-prompt-search >=1, memory-context
// >=1), so a lesson demoted there is invisible AND — being injection_count>0 by construction
// — sits in no GC queue either (decayAndMarkIdle only marks injection_count=0 rows): stranded
// out of reach with its distilled lesson. Lifting to 1 restores >=1-surface visibility + a
// citation-recovery path. NON-DESTRUCTIVE (only 0→1 on lesson-bearing rows, never
// deletes/hides), idempotent (a no-op once no imp-0 lesson rows remain), so safe to run
// unconditionally alongside recoverOrphanedChildren. `superseded_at IS NULL` mirrors the
// injection surfaces' own filter (pre-tool-recall:368, memory-context:217) — a de-dup loser
// (auto-dedup sets superseded_at but leaves compressed_into=0) must NOT be lifted back into
// injectability. Non-lesson imp-0 rows are left buried (low-value, not worth resurfacing).
export function recoverBuriedLessons(db, { projectFilter = '', baseParams = [] } = {}) {
  return db.prepare(`
    UPDATE observations SET importance = 1
    WHERE ${liveObsFilterSql('')}
      AND COALESCE(importance, 1) = 0
      AND lesson_learned IS NOT NULL AND lesson_learned <> '' AND lower(lesson_learned) <> 'none'
      ${projectFilter}
  `).run(...baseParams).changes;
}

// Heal deferred_work rows whose closing observation / source prompt was hard-deleted while
// foreign_keys was OFF. The warm-start fast-path deliberately runs with FK disabled (schema.mjs
// early migrations require cascade off), so the column's `ON DELETE SET NULL` never fired and a
// dangling closed_by_obs_id / source_prompt_id survives — exactly what `PRAGMA foreign_key_check`
// flags. This applies the SET NULL the FK would have. Closure state lives in status/
// closed_at_epoch, NOT the back-ref, so nulling the id does NOT reopen a done item — it only drops
// a pointer to a row that no longer exists. NON-DESTRUCTIVE + idempotent (a no-op once no dangling
// refs remain), so safe to run unconditionally alongside recoverOrphanedChildren. (P3-5)
export function sweepDeferredWorkOrphans(db, { projectFilter = '', baseParams = [] } = {}) {
  const obs = db.prepare(`
    UPDATE deferred_work SET closed_by_obs_id = NULL
    WHERE closed_by_obs_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = deferred_work.closed_by_obs_id)
      ${projectFilter}
  `).run(...baseParams).changes;
  const prompt = db.prepare(`
    UPDATE deferred_work SET source_prompt_id = NULL
    WHERE source_prompt_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM user_prompts p WHERE p.id = deferred_work.source_prompt_id)
      ${projectFilter}
  `).run(...baseParams).changes;
  return obs + prompt;
}

export function cleanupBroken(db, { projectFilter, baseParams, opCap = OP_CAP }) {
  const doomed = db.prepare(`
    SELECT id FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
      -- A lesson-bearing row is NOT "broken" — it still carries the distilled value,
      -- so empty title+narrative isn't grounds to hard-delete it (a degenerate
      -- cluster-merge can write merged_title='' onto a row that kept a synthesized
      -- lesson). Parity with the "lessons never auto-GC" guards in
      -- decayAndMarkIdle / selectCompressionCandidates / findSmartCompressCandidates.
      AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      ${projectFilter} LIMIT ${opCap}
  `).all(...baseParams).map(r => r.id);
  if (!doomed.length) return 0;
  recoverChildrenOf(db, doomed); // empty-content row could still be a cluster keeper
  const ph = doomed.map(() => '?').join(',');
  return db.prepare(`DELETE FROM observations WHERE id IN (${ph})`).run(...doomed).changes;
}

/**
 * Decay importance of old, never-accessed, NEVER-INJECTED observations and mark the
 * importance-1 idle ones as pending-purge. injection_count>0 is protected as first-class
 * engagement alongside access_count (unified across all three paths).
 *
 * MARK-IDLE RUNS BEFORE DECAY (audit MED-1): if decay ran first, an imp-2 row would be
 * decayed 2→1 and then re-selected by the same call's mark-idle pass → hidden as
 * pending-purge in ONE pass, collapsing the per-tier grace cycle and over-marking vs what
 * `maintain scan` (stale = imp-1 only) forecasts. Marking first means each call only marks
 * rows that were ALREADY imp-1; a freshly-decayed imp-2→1 row waits for the next call,
 * so importance tiers each buy a grace cycle (imp3→2→1→pending across runs) and the scan
 * forecast matches what decay actually marks.
 */
export function decayAndMarkIdle(db, { projectFilter, baseParams, staleAge, opCap = OP_CAP }) {
  const idleMarked = db.prepare(`
    UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND COALESCE(importance, 1) = 1
        AND COALESCE(access_count, 0) = 0
        AND COALESCE(injection_count, 0) = 0
        -- v3.23: never mark a lesson-bearing row idle→pending-purge. A lesson is the
        -- distilled value of a lessons store; auto-GC must not silently purge it (parity
        -- with the compress lesson guards in hook.mjs + compress-core.mjs). Truly stale
        -- lessons are removed by explicit delete, not background decay.
        AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
        AND created_at_epoch < ?
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(staleAge, ...baseParams).changes;

  const decayed = db.prepare(`
    UPDATE observations SET importance = MAX(1, COALESCE(importance, 1) - 1)
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND COALESCE(importance, 1) > 1
        AND COALESCE(access_count, 0) = 0
        AND COALESCE(injection_count, 0) = 0
        AND created_at_epoch < ?
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(staleAge, ...baseParams).changes;

  return { decayed, idleMarked };
}

/** Boost importance of frequently-accessed observations. Returns rows boosted. */
export function boostAccessed(db, { projectFilter, baseParams, opCap = OP_CAP }) {
  return db.prepare(`
    UPDATE observations SET importance = MIN(3, COALESCE(importance, 1) + 1)
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND COALESCE(access_count, 0) > 3
        AND COALESCE(importance, 1) < 3
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(...baseParams).changes;
}

/**
 * Repair the citation-decay blind spot: heavy-injection + zero-citation rows that
 * decay protects (injection_count>0) stay pinned at max importance forever. Drop
 * them to importance 1 in one pass (injection priority is binary at >=2, so a
 * single step would not de-rank). Floor 1, not purge.
 */
export function demotePinned(db, { projectFilter, baseParams, opCap = OP_CAP }) {
  return db.prepare(`
    UPDATE observations SET importance = 1
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND COALESCE(injection_count, 0) >= ${PINNED_INJ_THRESHOLD}
        AND COALESCE(cited_count, 0) = 0
        AND COALESCE(importance, 1) > 1
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(...baseParams).changes;
}

/**
 * Merge explicit duplicate groups: each group is [keepId, removeId, …]. Marks the
 * removeIds compressed into keepId (only if not already compressed). Returns the
 * number of rows merged. Callers parse their own input (CLI string / MCP array).
 */
export function mergeDuplicates(db, groups) {
  // Resolve the WHOLE batch before writing so transitive merges can't orphan rows.
  // A row is hidden from every view by `compressed_into != 0`, so pointing it at a
  // keeper that is itself hidden buries it behind a hidden parent. Naively applying
  // groups one update at a time loses data in three ways the old 1-line self-merge
  // guard missed:
  //   - chain  [[A,B],[B,C]] -> C.compressed_into=B, but B is now hidden into A;
  //     if B is later purgeStale-deleted, C's keeper vanishes and C is unrecoverable.
  //   - mutual [[A,B],[B,A]] -> BOTH hidden, the cluster loses its live representative.
  //   - already-compressed keeper [E,F] when E was merged in a prior call -> F buried
  //     behind hidden E.
  // mem_maintain's "dedup" auto-suggests pairs that can form these chains (server.mjs),
  // so this is reachable in normal use, not just typos. Fix: build the redirect map,
  // collapse each removeId to a single live keeper (cycles -> smallest id as canonical),
  // and only write removeId -> keeper when that keeper is currently live. Shared core,
  // so CLI + MCP both inherit it.
  const redirect = new Map(); // removeId -> keepId (first writer wins, deterministic)
  for (const group of groups) {
    if (!group || group.length < 2) continue;
    const [keepId, ...removeIds] = group;
    for (const removeId of removeIds) {
      if (removeId === keepId) continue;            // self-merge typo: no-op
      if (!redirect.has(removeId)) redirect.set(removeId, keepId);
    }
  }
  if (redirect.size === 0) return 0;

  // Follow the redirect chain to the ultimate keeper. A cycle (mutual merge) collapses
  // to the smallest id among the cycle members so every member agrees on one survivor.
  const resolveKeeper = (start) => {
    const seen = [];
    let cur = start;
    while (redirect.has(cur)) {
      const at = seen.indexOf(cur);
      if (at !== -1) return Math.min(...seen.slice(at)); // cycle -> canonical = min member
      seen.push(cur);
      cur = redirect.get(cur);
    }
    return cur; // an id with no outgoing redirect is a keeper
  };

  const isLive = db.prepare('SELECT 1 FROM observations WHERE id = ? AND COALESCE(compressed_into, 0) = 0');
  const mergeStmt = db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ? AND COALESCE(compressed_into, 0) = 0');
  let merged = 0;
  for (const removeId of redirect.keys()) {
    const keeper = resolveKeeper(removeId);
    if (keeper === removeId) continue;              // cycle canonical: this row survives
    if (!isLive.get(keeper)) continue;              // keeper not live -> skip, never orphan
    merged += mergeStmt.run(keeper, removeId).changes;
  }
  return merged;
}

/**
 * Count rows a destructive maintenance run would hard-DELETE: pending-purge rows
 * (any age — a cheap proxy for "purge has something to remove", deliberately not
 * age-filtered so the guard never under-counts) and/or broken empty-content rows
 * (cleanupBroken's doomed set). Used by the maintenance entry points to decide
 * whether to VACUUM-snapshot the DB first (audit MED-2) — over-counting only costs
 * one extra bounded backup; under-counting would skip the safety net.
 */
export function hardDeleteCandidateCount(db, { projectFilter, baseParams }, { cleanup = false, purge = false } = {}) {
  let n = 0;
  if (purge) {
    n += db.prepare(
      `SELECT COUNT(*) AS c FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} ${projectFilter}`
    ).get(...baseParams).c;
  }
  if (cleanup) {
    n += db.prepare(
      `SELECT COUNT(*) AS c FROM observations
       WHERE COALESCE(compressed_into, 0) = 0
         AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '') ${projectFilter}`
    ).get(...baseParams).c;
  }
  return n;
}

/** Preview pending-purge candidates older than the retain cutoff (no deletion). */
export function purgeStalePreview(db, { projectFilter, baseParams }, retainCutoff) {
  return db.prepare(`
    SELECT COUNT(*) AS candidates, MIN(created_at_epoch) AS oldest, MAX(created_at_epoch) AS newest
    FROM observations
    WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ? ${projectFilter}
  `).get(retainCutoff, ...baseParams);
}

/** Delete pending-purge observations older than the retain cutoff. Returns rows deleted. */
export function purgeStale(db, { projectFilter, baseParams, opCap = OP_CAP }, retainCutoff) {
  // No lesson guard HERE by design: this hard-DELETE only touches rows already
  // marked COMPRESSED_PENDING_PURGE, and every writer of that sentinel is itself
  // lesson-guarded (decayAndMarkIdle above + search-scoring.runIdleCleanup), so a
  // lesson row can never reach here. INVARIANT: any NEW code that sets
  // compressed_into = COMPRESSED_PENDING_PURGE MUST carry the "lessons never auto-GC"
  // guard, or it re-opens the path that hard-deletes lessons through this DELETE.
  const doomed = db.prepare(`
    SELECT id FROM observations
    WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ?
      ${projectFilter} LIMIT ${opCap}
  `).all(retainCutoff, ...baseParams).map(r => r.id);
  if (!doomed.length) return 0;
  // A keeper that absorbed dups can later be marked idle (compressed_into=PENDING_PURGE)
  // and reach here; deleting it would orphan its children. Recover them first.
  recoverChildrenOf(db, doomed);
  const ph = doomed.map(() => '?').join(',');
  return db.prepare(`DELETE FROM observations WHERE id IN (${ph})`).run(...doomed).changes;
}

/**
 * Near-duplicate title detection: MinHash pre-filter → exact Jaccard. Returns
 * [{ a:{id,title,importance}, b:{…}, similarity:'0.NN' }, …].
 */
export function findDuplicates(db, { projectFilter, baseParams, limit = SCAN_LIMIT, dupLimit = DUPLICATE_LIMIT }) {
  const recent = db.prepare(`
    SELECT id, title, project, importance, access_count, created_at_epoch
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
    ORDER BY created_at_epoch DESC LIMIT ${limit}
  `).all(...baseParams);

  const titles = recent.map((r) => (r.title || '').trim());
  const minhashes = titles.map((t) => (t ? computeMinHash(t) : null));
  const duplicates = [];
  for (let i = 0; i < recent.length && duplicates.length < dupLimit; i++) {
    if (!titles[i] || !minhashes[i]) continue;
    for (let j = i + 1; j < recent.length; j++) {
      if (!titles[j] || !minhashes[j]) continue;
      if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < MINHASH_PRE_THRESHOLD) continue;
      const sim = jaccardSimilarity(titles[i], titles[j]);
      if (sim > SIMILARITY_THRESHOLD) {
        duplicates.push({
          a: { id: recent[i].id, title: recent[i].title, importance: recent[i].importance },
          b: { id: recent[j].id, title: recent[j].title, importance: recent[j].importance },
          similarity: sim.toFixed(2),
        });
      }
      if (duplicates.length >= dupLimit) break;
    }
  }
  return duplicates;
}

/** Single-scan maintenance counters (includes `pinned`; callers render what they show). */
export function maintenanceStats(db, { projectFilter, baseParams, staleAge }) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      -- injection_count=0 MUST mirror decayAndMarkIdle's mark-idle guard (#8614):
      -- the scan stat previews what decay will mark idle, and decay protects
      -- injected rows. Omitting it over-counted "stale" by the injected-but-decayed
      -- rows decay never touches (e.g. demote_pinned's output: imp=1 but inj>0).
      -- lesson_learned guard mirrors decayAndMarkIdle (:188) / cleanupBroken (:153): those
      -- ops NEVER touch a lesson-bearing row ("lessons never auto-GC"), so the scan preview
      -- must exclude them too or it over-forecasts "Stale"/"Broken" vs what execute does.
      COALESCE(SUM(CASE WHEN COALESCE(importance, 1) = 1 AND COALESCE(access_count, 0) = 0
                    AND COALESCE(injection_count, 0) = 0
                    AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
                    AND created_at_epoch < ? THEN 1 ELSE 0 END), 0) as stale,
      COALESCE(SUM(CASE WHEN (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
                    AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
               THEN 1 ELSE 0 END), 0) as broken,
      COALESCE(SUM(CASE WHEN COALESCE(access_count, 0) > 3 AND COALESCE(importance, 1) < 3
               THEN 1 ELSE 0 END), 0) as boostable,
      COALESCE(SUM(CASE WHEN COALESCE(injection_count, 0) >= ${PINNED_INJ_THRESHOLD}
                    AND COALESCE(cited_count, 0) = 0 AND COALESCE(importance, 1) > 1
               THEN 1 ELSE 0 END), 0) as pinned
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
  `).get(staleAge, ...baseParams);
  const pendingPurge = db.prepare(
    `SELECT COUNT(*) as count FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} ${projectFilter}`
  ).get(...baseParams);
  return { ...stats, pendingPurge: pendingPurge.count };
}

/** Rebuild the TF-IDF vocabulary + every active observation vector (own transaction). */
export function rebuildVectors(db) {
  if (!vectorsEnabled()) return { ok: false, reason: 'vector arm disabled (set CLAUDE_MEM_VECTORS=1 to re-enable)', updated: 0, total: 0 };
  _resetVocabCache();
  const vocab = rebuildVocabulary(db);
  if (!vocab) return { ok: false, reason: 'no observations to build vocabulary from' };
  const allObs = db.prepare(`
    SELECT id, title, narrative, concepts, lesson_learned, search_aliases FROM observations
    WHERE ${liveObsFilterSql('')}
  `).all();
  let updated = 0;
  const insertStmt = db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM observation_vectors').run();
    for (const obs of allObs) {
      const vec = computeVector(vecTextForRow(obs), vocab);
      if (vec) {
        insertStmt.run(obs.id, Buffer.from(vec.buffer), vocab.version, now);
        updated++;
      }
    }
  })();
  return { ok: true, terms: vocab.terms.size, updated, total: allObs.length };
}

/** VACUUM the whole DB, reporting freelist reclaim. Must run OUTSIDE any transaction. */
export function vacuum(db) {
  const pageSize = db.pragma('page_size', { simple: true });
  const freeBefore = db.pragma('freelist_count', { simple: true });
  db.exec('VACUUM');
  const freeAfter = db.pragma('freelist_count', { simple: true });
  const reclaimedMB = ((Math.max(0, freeBefore - freeAfter) * pageSize) / 1048576).toFixed(1);
  return { reclaimedMB, freeBefore, freeAfter };
}
