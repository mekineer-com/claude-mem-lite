// Single source of truth for file-keyed recall: the observation_files junction
// query, LIKE-wildcard escaping, noise filtering, and the access-count bump.
// cmdRecall (mem-cli.mjs) and mem_recall (server.mjs) previously hand-copied all
// four — the drift class that produced the mem_get formatter drift (#8678) and
// the maintain hand-sync drift (#8614). Renderers stay per-surface; the data
// contract lives here.

import { notLowSignalTitleClause } from '../utils.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';
import { fileMatchClause, fileMatchParams, basenameAnySep } from './file-edge-match.mjs';

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
export function recallByFile(
  db,
  file,
  { limit = 10, includeNoise = false, project = null, currentProject = null } = {},
) {
  // Shared predicate, not a hand-rolled one (pre-tag review of v3.76.2, SF-1/S3).
  // This face carried BOTH defects v3.76.2 fixed in the injection path: node:path
  // `basename` (so a Windows-shaped argument derived to the whole string and matched
  // nothing) and a bare `%<basename>` suffix LIKE with no path boundary (so recalling
  // `utils.mjs` returned `bash-utils.mjs` lessons). recallByFile is mem_recall (MCP)
  // AND the CLI `recall` command, so both surfaces were wrong. fileMatchClause's
  // four arms and fileMatchParams' escaping are the single home for this.
  const filename = basenameAnySep(file);
  const noiseClause = includeNoise ? '' : `AND ${notLowSignalTitleClause('o')}`;
  // D11: the match is by basename (fileMatchClause), so without an ordering of its own
  // `recall packages/alpha/index.mjs` led with packages/BETA's lesson and, from project B,
  // with project A's rows. Ranked now: the current project first, then a row whose stored
  // path IS the path asked for — equal, or either one ending in the other at a separator —
  // then importance. `project` scopes the answer to one project outright.
  const [p1, p2, p3, p4] = fileMatchParams(file);
  const fp = p1; // the scrubbed path, as the junction stores it
  const sameEnd = (a, b) =>
    `(length(${a}) > length(${b}) AND substr(${a}, -length(${b})) = ${b} COLLATE NOCASE ` +
    `AND substr(${a}, -length(${b}) - 1, 1) IN ('/', '\\'))`;
  const exactPath = `(of2.filename = :fp COLLATE NOCASE OR ${sameEnd('of2.filename', ':fp')} OR ${sameEnd(':fp', 'of2.filename')})`;
  const pathRank = /[\\/]/.test(fp) ? `MIN(CASE WHEN ${exactPath} THEN 0 ELSE 1 END)` : '1';
  let mi = 0; // fileMatchClause emits positional `?`s; renamed to :m1..:m4 to mix with the named params
  const rows = db
    .prepare(
      `
    SELECT o.id, o.type, o.title, o.lesson_learned, o.importance,
           o.created_at, o.created_at_epoch, o.project, ${pathRank} AS path_rank
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE ${liveObsFilterSql('o')}
      AND ${fileMatchClause('of2').replace(/\?/g, () => ':m' + ++mi)}
      ${noiseClause}
      ${project ? 'AND o.project = :project' : ''}
    GROUP BY o.id
    ORDER BY (o.project = :current) DESC, path_rank ASC, o.importance DESC, o.created_at_epoch DESC, o.id DESC
    LIMIT :limit
  `,
    )
    .all({
      fp,
      m1: p1,
      m2: p2,
      m3: p3,
      m4: p4,
      current: currentProject ?? project ?? '',
      limit,
      ...(project ? { project } : {}),
    })
    .map(({ path_rank: _pathRank, ...r }) => r);

  if (rows.length > 0) {
    const ph = rows.map(() => '?').join(',');
    try {
      db.prepare(
        `UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${ph})`,
      ).run(Date.now(), ...rows.map((r) => r.id));
    } catch {
      /* non-critical: FTS5 trigger may fail on corrupted index */
    }
  }

  return { filename, rows };
}

/**
 * Does a file-keyed recall have anything for `file`? COUNT only — no rows, and
 * deliberately NO access_count/last_accessed_at bump.
 *
 * The bump in recallByFile above is correct there because a recall IS engagement and the
 * tier/decay system feeds on it. This helper exists for the opposite situation: `search`
 * wants to know, on a zero-result query that looks like a path, whether `recall` would
 * have answered — a question ABOUT the store, asked on the user's behalf but not by them.
 * Answering it through recallByFile would push the counters of rows nobody read, i.e. a
 * measurement writing to what it measures. It shares the predicate rather than re-typing
 * it, so `search`'s hint and `recall`'s answer can never disagree about what matches.
 *
 * `superseded_at IS NULL` and the LOW_SIGNAL filter come along for the same reason: a hint
 * must promise only what the default `recall` will actually print.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} file Path or filename, same forms recallByFile accepts.
 * @returns {number}
 */
export function countRecallableByFile(db, file) {
  const { c = 0 } =
    db
      .prepare(
        `
    SELECT COUNT(DISTINCT o.id) AS c
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE ${liveObsFilterSql('o')}
      AND ${fileMatchClause('of2')}
      AND ${notLowSignalTitleClause('o')}
  `,
      )
      .get(...fileMatchParams(file)) || {};
  return c;
}
