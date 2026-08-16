// Single source of truth for file-keyed recall: the observation_files junction
// query, LIKE-wildcard escaping, noise filtering, and the access-count bump.
// cmdRecall (mem-cli.mjs) and mem_recall (server.mjs) previously hand-copied all
// four — the drift class that produced the mem_get formatter drift (#8678) and
// the maintain hand-sync drift (#8614). Renderers stay per-surface; the data
// contract lives here.

import { basename } from 'path';
import { notLowSignalTitleClause } from '../utils.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';

/**
 * Recall observations linked to a file (basename or full path). Returns
 * { filename, rows } where rows carry the column superset both surfaces render.
 * Side effect: bumps access_count / last_accessed_at on every returned row —
 * recall IS engagement, and the tier/decay system feeds on these counters.
 *
 * `superseded_at IS NULL` is load-bearing twice over (audit B2, 2026-08-14): recall was
 * the ONE retrieval path missing it, so a lesson a later save explicitly retracted
 * (`--supersedes N`) was still served to an agent about to edit that very file — and the
 * access-count bump below runs over exactly these rows, so the tombstone was ALSO pushed
 * back up the decay/tier system on every read. `includeNoise` is about LOW_SIGNAL titles
 * and must not reach this clause: nobody asks for retracted content.
 */
export function recallByFile(db, file, { limit = 10, includeNoise = false } = {}) {
  const filename = basename(file);
  const escaped = filename.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const likePattern = `%${escaped}`;
  const noiseClause = includeNoise ? '' : `AND ${notLowSignalTitleClause('o')}`;
  const rows = db.prepare(`
    SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned, o.importance,
                    o.created_at, o.created_at_epoch, o.project
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE ${liveObsFilterSql('o')}
      AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
      ${noiseClause}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(filename, likePattern, limit);

  if (rows.length > 0) {
    const ph = rows.map(() => '?').join(',');
    try {
      db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${ph})`)
        .run(Date.now(), ...rows.map(r => r.id));
    } catch { /* non-critical: FTS5 trigger may fail on corrupted index */ }
  }

  return { filename, rows };
}
