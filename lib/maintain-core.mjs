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
import { rebuildVocabulary, computeVector, _resetVocabCache } from '../tfidf.mjs';

export const STALE_AGE_MS = 30 * 86400000;
export const OP_CAP = 1000;
export const SCAN_LIMIT = 500;
export const DUPLICATE_LIMIT = 50;
export const SIMILARITY_THRESHOLD = 0.7;
export const MINHASH_PRE_THRESHOLD = 0.5;
// A memory injected this many times with zero citations is "pinned noise" that
// the regular decay op can't touch (decay protects injection_count>0).
export const PINNED_INJ_THRESHOLD = 8;

/** Delete broken observations (no title AND no narrative). Returns rows deleted. */
export function cleanupBroken(db, { projectFilter, baseParams, opCap = OP_CAP }) {
  return db.prepare(`
    DELETE FROM observations WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(...baseParams).changes;
}

/**
 * Decay importance of old, never-accessed, NEVER-INJECTED observations, then mark
 * the importance-1 idle ones as pending-purge. injection_count>0 is protected as
 * first-class engagement alongside access_count (unified across all three paths).
 */
export function decayAndMarkIdle(db, { projectFilter, baseParams, staleAge, opCap = OP_CAP }) {
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

  const idleMarked = db.prepare(`
    UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND COALESCE(importance, 1) = 1
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
  let merged = 0;
  const mergeStmt = db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ? AND COALESCE(compressed_into, 0) = 0');
  for (const group of groups) {
    if (!group || group.length < 2) continue;
    const [keepId, ...removeIds] = group;
    for (const removeId of removeIds) merged += mergeStmt.run(keepId, removeId).changes;
  }
  return merged;
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
  return db.prepare(`
    DELETE FROM observations WHERE id IN (
      SELECT id FROM observations
      WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ?
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(retainCutoff, ...baseParams).changes;
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
      COALESCE(SUM(CASE WHEN COALESCE(importance, 1) = 1 AND COALESCE(access_count, 0) = 0
                    AND created_at_epoch < ? THEN 1 ELSE 0 END), 0) as stale,
      COALESCE(SUM(CASE WHEN (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
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
  _resetVocabCache();
  const vocab = rebuildVocabulary(db);
  if (!vocab) return { ok: false, reason: 'no observations to build vocabulary from' };
  const allObs = db.prepare(`
    SELECT id, title, narrative, concepts FROM observations
    WHERE COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
  `).all();
  let updated = 0;
  const insertStmt = db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM observation_vectors').run();
    for (const obs of allObs) {
      const text = [obs.title || '', obs.narrative || '', obs.concepts || ''].filter(Boolean).join(' ');
      const vec = computeVector(text, vocab);
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
