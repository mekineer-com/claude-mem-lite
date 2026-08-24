// Error-triggered recall — the SELECTION half of the surface.
//
// Why this is a shared core and not left inline in hook.mjs (project convention
// "shared by two or more faces → lib/"): the offline calibration suite
// (benchmark/error-recall-suite.mjs) must score THE QUERY THIS SURFACE ACTUALLY
// RUNS. A benchmark that re-types the SQL measures a second program that merely
// looks like the first — the failure mode recorded in
// reference_verify_cc_host_behavior_in_bundle ("copy a call, swap one argument,
// and you have measured something else"). One body, two consumers: the hook
// injects from it, the suite scores it.
//
// hook.mjs keeps what is genuinely its own: project inference, rendering
// (formatErrorRecallHints), metering, and the stdout envelope.

import { planErrorRecall } from '../bash-utils.mjs';
import { OBS_BM25, notLowSignalTitleClause } from '../scoring-sql.mjs';
import { liveObsFilterSql, recencyDecaySql } from './inject-search-core.mjs';
import { corpusFloorScale } from './relevance-floor.mjs';

/** Rows injected per fired error-recall. Historically a bare `LIMIT 3`. */
export const ERROR_RECALL_LIMIT = 3;

/**
 * Floor default. **0 = OFF**, and that is a measured decision, not an oversight.
 * The calibrated value if you want to enable it is 10.5 (`CLAUDE_MEM_ERROR_RECALL_BM25_MIN`).
 * See errorRecallBm25Floor for the numbers behind both halves of that sentence.
 */
export const DEFAULT_ERROR_RECALL_BM25_FLOOR = 0;

/** The value calibrated for this face, used when the floor is switched on. */
export const CALIBRATED_ERROR_RECALL_BM25_FLOOR = 10.5;

/**
 * Set-level |bm25| floor for this surface. **Default 0 = off.**
 *
 * WHY IT IS BUILT, CALIBRATED, AND STILL OFF. Short version: measured, the lever is
 * small where it is safe and large where it is unmeasured, so nothing justifies moving
 * it into everyone's default path. Long version, because whoever reaches for this next
 * needs the numbers rather than the conclusion:
 *
 * The DISTRIBUTION suggested a floor, and then stopped suggesting it once the fixture
 * got more honest. Measured over 7 well-served cases (618 rows), |bm25_raw| by class:
 *
 *   class      n    min    p25    med    p75    max
 *   relevant   9   10.93  11.17  20.75  30.27  42.97
 *   negative   9   11.28  22.35  24.39  27.28  31.89
 *   filler    19    8.33   8.51   9.55  10.13  29.57
 *
 * 10.5 sits in that gap — filler p75 10.13, relevant min 10.93 — which is how the UPS
 * face's OR floor got its 30 in its own 22->41 gap. But adding two NO-GOOD-MATCH cases
 * (real failures the corpus cannot explain, which is the common case in production and
 * which the fixture originally lacked entirely) moves it (9 cases, 620 rows):
 *
 *   class      n    min    p25    med    p75    max
 *   relevant   9   10.93  11.18  20.77  29.99  43.00
 *   negative  11   10.59  20.87  24.41  29.25  31.91
 *   filler    30    8.16   8.89   9.56  10.99  29.25
 *
 * filler's p75 is now 10.99, ABOVE relevant's min of 10.93: the gap is gone. It was an
 * artifact of a fixture where every case had something good to find. Note too that
 * `relevant` and `negative` overlap almost entirely in both tables — per #8858 a
 * magnitude gate can remove genuinely off-topic rows and cannot tell an explaining row
 * from a merely topical one.
 *
 * The SWEEP says the achievable gain is small, because a floor only affects rows that
 * reach the injection cap and weak rows mostly do not. On the 7-case fixture a PER-ROW
 * floor at 10.5 moved 20 -> 18 injected rows, both removed rows off-topic filler,
 * relevant and hit-rate unchanged: +3.3pp precision. That was the best case for this
 * lever and it is worth 2 rows.
 *
 * The LIVE DATABASE says the cost is neither small nor measured. Pre-release review ran
 * the per-row form over 8 projects x 10 real hard-error shapes on the maintainer's own
 * DB: injected rows 221 -> 112 (-49%), and 25 of 80 firing cases (31%) went to
 * injecting nothing at all. The loss sits entirely in SMALL projects (under ~500
 * observations: -47..-87%; above ~800: -0..-3%), and corpusFloorScale cannot correct it
 * — it normalises over the WHOLE observations table, which is right for FTS5's IDF and
 * deliberately project-blind, whereas what collapses on a small project is how good the
 * best available memory is. That is v3.61.0's failure mode relocated from install scope
 * to project scope.
 *
 * The obvious repair — make the gate SET-LEVEL, matching what UPS actually does (read
 * the top row, drop the whole set on failure) so a case with one strong row keeps its
 * supporting rows — is the form implemented in selectErrorRecall. AND THE FIXTURE SAYS
 * IT IS FREE, WHICH IS ALSO WRONG. On the ruler it is a no-op at 10.5 (26 injected rows
 * at every floor from 0 to 20; it only bites at 25, costing hit-rate 85.7% -> 42.9%).
 * On the live DB, same threshold, 8 projects x 9 shapes, 69 firing cases:
 *
 *   base (off)        201 rows
 *   set-level 10.5    126 rows  (-37%)   27 of 69 cases silenced (39%)
 *   per-row   10.5     97 rows  (-52%)   26 of 69 cases silenced (38%)
 *
 * The set-level form trims fewer rows in the cases it spares, and silences just as many
 * cases. The fixture cannot see this because ITS hard negatives are constructed to score
 * high — every fixture case, including the no-good-match ones, has a top row above 10.5,
 * while real small projects frequently have nothing above it. That is the same failure
 * as the per-row measurement one level up: a fixture number standing in for a live one.
 *
 * So the per-row form buys +3.3pp on a fixture at a live cost nothing has shown to be
 * noise (citation_surface_log stores counts, not ids, so the |bm25| of the 15 cited rows
 * is unrecoverable), and the set-level form costs a third of the face for a benefit
 * measured nowhere. Neither earns a default. The defect this face actually has is that
 * command words dominate BM25 — semantic, and out of reach of any magnitude gate (D#167).
 *
 * Enable with CLAUDE_MEM_ERROR_RECALL_BM25_MIN=10.5 (see CALIBRATED_… above). Read at
 * call time so tests and a redirected environment both take effect.
 */
export function errorRecallBm25Floor() {
  const raw = process.env.CLAUDE_MEM_ERROR_RECALL_BM25_MIN;
  if (raw === undefined || raw === '') return DEFAULT_ERROR_RECALL_BM25_FLOOR;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ERROR_RECALL_BM25_FLOOR;
}

/**
 * Fixed 14d half-life: for a failure, recency matters more than observation
 * type, so this surface deliberately does NOT use TYPE_DECAY_CASE.
 */
const ERROR_RECALL_HALF_LIFE_MS = '1209600000.0';

/**
 * Build the error-recall SELECT. Exported so the calibration suite can assert it
 * is scoring the same statement the hook runs, and so a future floor lands in
 * exactly one place.
 *
 * @param {number} limit Row cap; coerced to a safe integer before interpolation.
 * @returns {string} SQL taking NAMED parameters @q (MATCH), @project, @now
 *   (decay reference) and @floor (|bm25| minimum). Named rather than positional
 *   so the binding cannot silently renumber when the statement is rearranged.
 */
export function errorRecallSql(limit = ERROR_RECALL_LIMIT) {
  // Number.isFinite before trunc: `Number('Infinity')` is a number and truncates to
  // Infinity, which interpolates as `LIMIT Infinity` and throws at prepare(). Not an
  // injection (every string form coerces to the default) but a crash where a fallback
  // belongs.
  const asNum = Number(limit);
  const n = Number.isFinite(asNum) && asNum >= 1
    ? Math.max(1, Math.trunc(asNum))
    : ERROR_RECALL_LIMIT;
  // No floor in the SQL: the gate is SET-LEVEL and lives in selectErrorRecall. See
  // its docblock for why. This statement is the pre-floor one plus a bm25_raw column.
  return `
    SELECT o.id, o.type, o.title, o.lesson_learned,
      -- Raw match quality, exposed so the set-level floor can read the top row.
      -- Deliberately the UNDECAYED bm25: an old-but-exact row should be able to clear
      -- the floor, and gating on the decayed score would make the floor an age cutoff.
      -- Note the gate reads the RANK-top row (ordered by bm25 x decay below), not the
      -- highest |bm25| in the set — see selectErrorRecall.
      ${OBS_BM25} AS bm25_raw
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH @q AND o.project = @project
      -- Live-row invariant, same as every other model-facing retrieval path
      -- (hook-context obsPool/fallbackObs/keyObs, hook-memory, search-engine,
      -- recent/search/timeline/recall-core, pre-tool-recall, user-prompt-search).
      -- This surface INLINES rows[0].lesson_learned into the model context, so an
      -- unfiltered SELECT handed a retracted lesson to the agent verbatim while its
      -- correction trailed as a bare pointer. compressed_into is filtered too, not
      -- only for symmetry: the block's own footer is a mem_get(ids=...) pointer, and a
      -- COMPRESSED_PENDING_PURGE row is queued for deletion by maintain purge_stale,
      -- so that pointer would resolve to nothing.
      AND ${liveObsFilterSql('o')}
      AND ${notLowSignalTitleClause('o')}
    -- Decay via the shared core (P2-11): the M-1 MAX(0,…) age clamp lives there.
    ORDER BY ${OBS_BM25}
      * ${recencyDecaySql({
    tsExpr: 'o.created_at_epoch',
    halfLifeSql: ERROR_RECALL_HALF_LIFE_MS,
    // NAMED, not positional. The statement binds @q and @project ahead of this
    // expression, and better-sqlite3 forbids mixing the two styles; an earlier
    // revision moved this expression into the SELECT list with a positional `?`
    // and MATCH silently received the project name (FTS5: `no such column`).
    nowParam: '@now',
  })}
    LIMIT ${n}
  `;
}

/**
 * Turn planErrorRecall's terms into the OR-query this surface matches on.
 * @returns {string} FTS5 MATCH expression, or '' when there is nothing to run.
 */
export function errorRecallFtsQuery(terms) {
  return (terms || []).map((t) => `"${String(t).replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Decide whether error-recall fires, and select its rows.
 *
 * Returns null — meaning DO NOT INJECT — in the two cases the surface already
 * treated as silence: planErrorRecall found no usable error term (see its own
 * docblock for why silence beats querying the command's topic), or the terms
 * produced an empty MATCH expression.
 *
 * @param {object} db Open better-sqlite3 handle.
 * @param {{cmd: string, response: string, project: string, now?: number,
 *          limit?: number}} opts
 * @returns {{rows: object[], terms: string[], ftsQuery: string}|null}
 */
export function selectErrorRecall(db, {
  cmd, response, project, now = Date.now(), limit = ERROR_RECALL_LIMIT, floor,
}) {
  const plan = planErrorRecall(cmd, response);
  if (!plan) return null;

  const ftsQuery = errorRecallFtsQuery(plan.terms);
  if (!ftsQuery) return null;

  // A null / NaN / '' floor means "not specified", same as omitting it — NOT "no
  // floor". Disabling the gate must take an explicit 0. The env reader above is
  // hardened the same way, and the asymmetry between the two was a review finding.
  // Only a real, finite, non-negative NUMBER counts as specified. Coercing first would
  // make `''` mean 0 — Number('') is 0 and is finite — i.e. an empty string would
  // silently disable the gate. Same posture as the env reader above.
  const base = (typeof floor === 'number' && Number.isFinite(floor) && floor >= 0)
    ? floor
    : errorRecallBm25Floor();
  // Scale by corpus size for the same reason UPS does: bm25 carries IDF, so a fixed
  // magnitude means "weak match" on an established index and "small index" on a new
  // one. v3.61.0 shipped an unscaled floor and injected 0/8 on fresh installs.
  const effective = base > 0 ? base * corpusFloorScale(db) : 0;

  const rows = db.prepare(errorRecallSql(limit)).all({ q: ftsQuery, project, now });

  // SET-LEVEL gate, the shape UPS already uses (read the top row; on failure drop the
  // WHOLE set) rather than filtering row by row.
  //
  // Why not per-row: measured in pre-release review against the maintainer's live DB,
  // a per-row floor cut injected rows 221 → 112 (−49%) across 8 projects, and the loss
  // was concentrated entirely in SMALL ones — projects under ~500 observations lost
  // 47–87%, those above ~800 lost 0–3%. corpusFloorScale cannot see that by design: it
  // normalises over the WHOLE observations table, which is correct for FTS5's IDF and
  // is documented as deliberately project-blind. But what collapses on a small project
  // is not IDF, it is how good the best available memory is. So a per-row floor also
  // shortened sets that DID have a good top row — a different and unjustified
  // behaviour from "this failure has nothing worth recalling".
  //
  // The set-level shape says exactly the intended thing and nothing more: if the best
  // match is not about the failure, stay silent (D#136's stance); otherwise inject the
  // set unchanged. Rows 2..n are never judged on their own, so a case with one strong
  // row keeps its supporting rows.
  //
  // `rows[0]` is the RANK-top row (ordered by bm25 x decay), NOT the highest |bm25|.
  // Those differ: with a 14-day half-life the multiplier reaches 2x, so a fresh weaker
  // row can outrank an older stronger one and veto a set the stronger row would have
  // admitted. Measured, this is why the set-level form silences marginally MORE cases
  // than the per-row one (27 vs 26 of 69 on the live DB). Kept as-is rather than
  // switched to max(): UPS gates on `ftsRows[0]` the same way, and one face quietly
  // disagreeing with the other about what "the top hit" means is worse than the
  // occasional veto. Stated here because the comment above used to claim otherwise.
  if (effective > 0 && rows.length && Math.abs(rows[0].bm25_raw) < effective) {
    return {
      rows: [], terms: plan.terms, ftsQuery, floor: effective, suppressed: rows.length,
    };
  }
  return { rows, terms: plan.terms, ftsQuery, floor: effective, suppressed: 0 };
}
