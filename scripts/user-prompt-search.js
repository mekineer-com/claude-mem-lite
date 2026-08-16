#!/usr/bin/env node
// claude-mem-lite: Auto-search memory on user prompt
// Runs as UserPromptSubmit hook — injects relevant memories before Claude sees the prompt
// Lightweight: only imports schema.mjs and utils.mjs, no MCP SDK

import { ensureDb, DB_DIR, REGISTRY_DB_PATH } from '../schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, OBS_BM25, notLowSignalTitleClause, stripPrivate, neutralizeContextDelimiters, MAX_UPS_PROMPT_BYTES } from '../utils.mjs';
import { liveObsFilterSql, injectionRelevanceSql } from '../lib/inject-search-core.mjs';
import { cjkPrecisionOk } from '../nlp.mjs';
import { writeFileSync, readFileSync, existsSync, renameSync } from 'fs';
import { join, sep } from 'path';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import { shouldSkip, computeEffectiveLen, detectIntent, shouldSkipByDedup, extractFiles, extractErrorSignature, extractDeferredRefs, DEDUP_STALE_MS, matchRegistrySkillName, detectMemOverride } from './prompt-search-utils.mjs';
import { injectedIdsFileName } from '../lib/injected-ids.mjs';
import { getDeferredByIds } from '../lib/deferred-work.mjs';
import { recommendSkill } from '../registry-recommend.mjs';
import { recordHookError } from '../lib/hook-telemetry.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

import { DAY_MS } from '../lib/time-constants.mjs';
// ─── Constants ──────────────────────────────────────────────────────────────

// Telemetry sink (lib/hook-telemetry.mjs contract): env override for tests, else
// <data-dir>/runtime — the same dir the sibling hook scripts + `stats` read.
const RUNTIME_DIR = process.env.CLAUDE_MEM_RUNTIME_DIR || join(DB_DIR, 'runtime');
// D#120: one marker file per CC session — payload-only session keying (M-6) let
// two concurrent windows full-replace each other's marker, killing dedup between
// them and resetting `count` on every alternation. Derived per invocation once
// the session id is parsed from stdin; no session id → legacy project-keyed file.
const injectedIdsFileFor = (sessionId) =>
  join(DB_DIR, 'runtime', injectedIdsFileName(inferProject(), sessionId));
// Per-prompt UPS cap. Cut from 5 → 3 after the 2026-05-09 per-hook recall
// scan (#8255): UPS contributed 74% of silent injected IDs (131/177) at 26%
// recall, vs PreToolUse:Read at 94% recall on a tighter file-keyed set.
// Hypothesis: fewer candidates → each one more relevant → cite-rate up.
// useRecent intent path is unaffected (it uses intent.limit=5 directly,
// gated by explicit "before/previously/记得" prompts where breadth is the
// point). Env override for projects that want broader recall or to A/B.
const MAX_RESULTS = Number(process.env.CLAUDE_MEM_UPS_MAX_RESULTS || 3);
const LOOKBACK_MS = 60 * DAY_MS; // 60 days

// v2.56.x: Past-similar-questions fallback row cap. Cut from 3 → 1 after
// 30d transcript scan (#8062 follow-up, 2026-05-09) showed UPS prompt-fallback
// path contributing ~24% of session injection budget with near-zero cite-recall.
// Unlike the obs FTS path (TOP_REL_FLOOR + BM25 gates), prompt-fallback has no
// quality gate — only BM25 ordering — so additional rows inflate noise without
// improving signal. Env-overridable for projects that want broader prompt recall.
const PROMPT_FALLBACK_LIMIT = Number(process.env.CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT || 1);

// T3 (v2.31): per-row BM25 magnitude floor. OBS_BM25 (in scoring-sql.mjs)
// returns the raw bm25() value — negative, smaller = better. Multiplied by
// decay × type-quality × (0.5+0.5·importance), sign stays negative. We
// compare against Math.abs(relevance).
//
// v2.34.3 note: the historic comment claimed |rel| falls in 3e-6..5e-5 range.
// Re-measured against real data (see v2.34.3 CHANGELOG probe), actual scores
// span ~6..133 across SIGNAL / META / NOISE prompts — the scoring expression
// was revised in later versions and this constant was never retuned. 1e-5 now
// acts as a NULL-rel guard, not a real noise filter. The primary noise gate
// is TOP_REL_FLOOR below, which drops the whole FTS set when the best match
// is weak.
const BM25_MIN_SCORE = Number(process.env.CLAUDE_MEM_UPS_BM25_MIN || 1e-5);
// CJK-weighted minimum length for the prompt. Catches medium-short Latin
// prompts ("run tests", "fix bug now") that survive `shouldSkip`'s weaker 8-unit
// floor but carry too few tokens to justify an FTS lookup.
// v2.34.4: applied to `computeEffectiveLen(prompt)`, not raw char count — a
// 14-char CJK prompt ("优化 hook 性能降低延迟") scores 30 effective units and
// now reaches FTS, matching shouldSkip's CJK-weighted gate rather than silently
// failing the raw-char one.
const PROMPT_MIN_LENGTH = 15;

// v2.33.1: follow-up prompts ("前面那个", "继续 X", "再看看 Y") are short by
// nature but semantically depend on prior turns. Once a session has injected
// memory at least once, relax gates so short follow-ups still get recall.
// Detection: injected-ids marker count > 0 within DEDUP_STALE_MS window.
const FOLLOWUP_PROMPT_MIN_LENGTH = 8;
const FOLLOWUP_BM25_MIN_SCORE = Number(process.env.CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP || 5e-6);

// v2.34.3: top-|rel| sanity gate. BM25_MIN_SCORE filters per-row; this floor
// gates the entire FTS set. Noise prompts ("today's date", "current time")
// produce OR-fallback leakage where every hit shares one tangential stem and
// per-row filtering leaves all of them through. When the best match scores
// below this floor, the whole FTS result set is dropped.
//
// Empirical distribution (v2.34.3 probe, 12 prompts):
//   SIGNAL top-|rel|   60..133
//   NOISE  top-|rel|   25..48
//   WEAK-META          6.86..33
// Default 50 sits in the clean 48→60 gap. Env override for project tuning.
// Error-signature hits (sigRows) and file-recall (fileRows) bypass this gate —
// both are precision passes with independent relevance signal.
//
// Note: no follow-up halving (unlike PROMPT_MIN_LENGTH / BM25_MIN_SCORE).
// Those lower the length/per-row bar to let short context-dependent prompts
// through, but the top-|rel| gap is an absolute distribution separator —
// lowering it in follow-up mode re-admits the 37..48 noise band that the
// gate exists to drop.
const TOP_REL_FLOOR = Number(process.env.CLAUDE_MEM_UPS_TOP_MIN || 50);

// v2.43.x: OR-fallback raw BM25 magnitude floor. The composite TOP_REL_FLOOR
// above gates on `bm25 × importance × type_quality × decay × noise_penalty`.
// For importance=3 bugfix obs, those multipliers compound to ~6×, so a modest
// BM25 of -17..-22 can clear a composite floor of 50 via inflation alone.
// When the FTS query relaxes to OR (AND returned 0), a single strongly-
// matching stem on a big multi-topic prompt leaks through — observed
// failure mode: broad Chinese prompts surfacing unrelated importance=3
// bugfix obs whose concepts share exactly one stem with the prompt.
//
// Empirical OR-mode distribution (11-prompt probe, 2026-04-23):
//   real signal      top-|bm25_raw| ≥ 41
//   broad/meta noise top-|bm25_raw| ≤ 22
//   below threshold  top-|bm25_raw| < 12
// Default 30 sits in the clean 22→41 gap. AND mode bypasses this gate —
// AND's all-stems-must-match constraint is already a precision signal,
// and there are legitimate AND hits (GOOD-narrow probe: bm25_raw=19.3,
// rel=81) that we must not drop.
//
// CLAUDE_MEM_UPS_TOP_MIN=0 disables this too: on small test corpora (1–2
// seeded obs) absolute BM25 magnitudes collapse to near-zero (observed
// |bm25|≈4e-6) because FTS5 IDF normalization needs a real document
// distribution. The existing TOP_REL_FLOOR knob already encodes the
// "seed-mode: kill absolute floors" semantic for integration tests, so
// we piggy-back on it rather than introducing a second override env.
const OR_TOP_BM25_FLOOR = TOP_REL_FLOOR === 0
  ? 0
  : Number(process.env.CLAUDE_MEM_UPS_OR_BM25_MIN || 30);

// ─── Corpus-size normalization of the absolute floors (v3.61.0) ─────────────
//
// Both floors above are ABSOLUTE magnitudes, but the quantity they gate is not
// scale-free: FTS5 bm25 carries an IDF term ≈ ln(N/df), so the SAME hit scores
// higher on a bigger index. Measured on one fixed query + one fixed target row,
// padding the corpus with distinct filler (2026-08-13 dogfood):
//
//   totalObs   10     40     100    300
//   top|bm25|  10.0   18.6   24.2   30.7      ← same row, same query
//
// The floors were calibrated at `projects--mem, 584 obs` (CHANGELOG v2.43.x /
// v2.34.3). Comparing a log-N quantity against that constant therefore does not
// mean "weak match" on a small index — it means "small index". A brand-new
// install measured 0/8 injections on a realistic first-day corpus (10 memories,
// 8 recall questions whose correct target ranked #1 in 4/5 scored cases): every
// one was dropped by the OR floor at |bm25| 3.8–15.2 < 30. The plugin is inert
// during exactly the window where a new user decides whether it earns its keep.
//
// Fix: scale both floors by ln(N+1)/ln(N_REF+1), capped at 1.0 — the same log
// shape the IDF term has, so the SIGNAL↔NOISE separation the maintainer measured
// (signal ≥41, noise ≤22 at N_REF) is preserved proportionally at any N. At
// N ≥ N_REF the factor is exactly 1.0, so every established install keeps
// byte-identical behavior; only genuinely-new installs relax.
//
// N counts the WHOLE observations table, not the project: FTS5 computes IDF over
// the entire index and `o.project = ?` is a post-MATCH filter. Verified — a
// 2-row project on a 302-row install scores 31.5, matching the 300-row global
// baseline, not the 10-row one. So a new project on an established install is
// (correctly) unaffected by this ramp.
const FLOOR_REF_CORPUS = Number(process.env.CLAUDE_MEM_UPS_FLOOR_REF_CORPUS || 584);

/**
 * Scale factor in (0, 1] for the absolute score floors, by total corpus size.
 *
 * Short-circuits with a bounded probe: if a row exists at offset N_REF-1 the
 * corpus is at or above the reference and the factor is 1.0 — no COUNT scan on
 * the large corpora where the answer is always 1.0 anyway.
 *
 * @param {object} db Open better-sqlite3 handle.
 * @returns {number} Multiplier for TOP_REL_FLOOR / OR_TOP_BM25_FLOOR.
 */
export function corpusFloorScale(db) {
  if (FLOOR_REF_CORPUS <= 1) return 1;
  try {
    const atRef = db.prepare('SELECT 1 FROM observations LIMIT 1 OFFSET ?').get(FLOOR_REF_CORPUS - 1);
    if (atRef) return 1;
    const { c = 0 } = db.prepare('SELECT count(*) AS c FROM observations').get() || {};
    return Math.min(1, Math.log(c + 1) / Math.log(FLOOR_REF_CORPUS + 1));
  } catch {
    // Any probe failure → behave exactly as before the ramp existed.
    return 1;
  }
}

function isFollowUpSession(injectedIdsFile) {
  try {
    const raw = readFileSync(injectedIdsFile, 'utf8');
    const { ts, count = 0 } = JSON.parse(raw);
    if (!ts || Date.now() - ts > DEDUP_STALE_MS) return false;
    return count > 0;
  } catch { return false; }
}

// ─── Explicit-signal gate (v2.57.x) ─────────────────────────────────────────
//
// Upstream gate that decides whether the FTS / prompt-fallback paths run at
// all. Per cite-recall baseline 2026-04-22 → 2026-05-09 (29 sessions),
// UserPromptSubmit injection cite-recall = 25.8% (132/178 silent injections)
// vs PreToolUse:Read/Edit at 94.1/94.2%. The gap is the always-search policy
// burning tokens on prompts the model never refers back to.
//
// Retreat: only inject when the prompt carries a signal that names something
// concrete. Four orthogonal channels:
//   (1) error-signature  — extractErrorSignature() typed exception match
//   (2) file-reference   — extractFiles() basename.ext or path separator
//   (3) detected intent  — detectIntent() catches recall words ("记得", "之前",
//                          "previously") + actionable keywords (bugfix/test/
//                          decision/refactor/perf/schema/implement/...)
//   (4) tech identifier  — CamelCase / snake_case / ALL_CAPS_CONST /
//                          kebab-case (≥3 segments). Conservative — drops
//                          single-lowercase-word identifiers ("mem", "fix")
//                          since those are 99% prose noise.
//
// "No signal" prompts ("does this work?", "how is it going") return no
// injection. PreToolUse file-keyed hook is independent (94% recall track,
// fires on Edit/Read/Write file paths) — not affected.
//
// Env override: CLAUDE_MEM_UPS_REQUIRE_SIGNAL=0 restores always-search.
// Default ON.
//
// Note for OR-fallback gate (#8144) interaction: this gate is upstream of
// score-quality gates (OR_TOP_BM25_FLOOR / TOP_REL_FLOOR). They compose:
// presence-gate decides whether to search at all; score-gate trims the
// returned set. Orthogonal layers — turning REQUIRE_SIGNAL off restores
// the previous behavior where score-gates alone control noise.
//
// Regex post-review (Important #1): bare-acronym ALL_CAPS arm `[A-Z]{2,}…`
// false-positived on common English prose (IBM, NPM, THE, BSD, ASCII).
// camelCase arm `[a-z][a-z0-9]*[A-Z]…` false-positived on iOS, eBay.
// Five-arm tightening:
//   • snake_case      — requires `_` between lowercase tokens
//   • CONST_CASE      — requires `_` between uppercase tokens (catches
//                       MAX_RESULTS, CLAUDE_MEM_DIR, OBS_BM25)
//   • ACRONYM_w_digit — bare 2+-cap run with at least one digit (catches
//                       FTS5, MD5, HTML5, OAUTH2, HTTP2; rejects IBM/NPM/
//                       THE/BSD/ASCII which never carry digits in prose)
//   • camelCase       — requires ≥2 lowercase before the first cap
//                       (excludes iOS, eBay; allows getUserById, parseJsonFromLLM)
//   • kebab-case      — ≥3 segments (pre-tool-use; excludes "easy-to-use")
// Bare digitless acronyms (URL, JWT, JSON, HTTP) no longer match — they
// typically appear alongside intent keywords or files anyway, so the gate
// catches the prompt via those channels rather than the identifier itself.
const TECH_IDENTIFIER_RE = /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z]{2,}[0-9][A-Z0-9_]*|[a-z]{2,}[A-Z][a-zA-Z0-9]+|[a-z]+(?:-[a-z]+){2,})\b/;

// Reviewer #2 (v3.25.0): the kebab (≥3-seg) and camelCase arms above structurally
// match a handful of ordinary English phrases / product names that are NOT code
// identifiers — `up-to-date`, `state-of-the-art`, `macOS`, etc. Left unfiltered they
// (a) widen the default-ON hasExplicitSignal gate on prose-only prompts and (b) let
// such a token drive the opt-in identifier bypass. Stop-list them (lowercased). Real
// 3-segment kebab identifiers (`pre-tool-use`, `user-prompt-search`) are deliberately
// NOT here — only attested non-identifier prose.
const IDENTIFIER_STOPWORDS = new Set([
  'up-to-date', 'out-of-date', 'up-to-speed', 'out-of-the-box', 'state-of-the-art',
  'end-to-end', 'off-by-one', 'easy-to-use', 'day-to-day', 'step-by-step',
  'face-to-face', 'one-to-one', 'one-on-one', 'back-to-back', 'side-by-side',
  'apples-to-apples', 'macos',
]);

// CJK presence channel (Important #2): bilingual users (project memory
// `feedback_*` calls this out explicitly) ask CJK questions that may carry
// genuine debug intent without containing an English identifier. CJK is
// information-dense — an 8-effective-unit prompt rarely encodes "how is it
// going"-style noise. Threshold mirrors shouldSkip's CJK floor.
const CJK_CHAR_RE = /[一-鿿぀-ヿ]/;
const CJK_MIN_EFFECTIVE_LEN = 8;

const REQUIRE_EXPLICIT_SIGNAL = process.env.CLAUDE_MEM_UPS_REQUIRE_SIGNAL !== '0';

export function hasExplicitSignal(text, { errSig, files, intent } = {}) {
  if (!text) return false;
  if (errSig) return true;
  if (Array.isArray(files) && files.length > 0) return true;
  if (intent) return true;
  // Recompute path — fires only when the caller passes `text` alone (test
  // entry point); production caller in main() always pre-computes all three.
  if (errSig === undefined && extractErrorSignature(text)) return true;
  if (files === undefined && extractFiles(text).length > 0) return true;
  if (intent === undefined && detectIntent(text)) return true;
  if (extractTechIdentifiers(text).length > 0) return true;
  if (CJK_CHAR_RE.test(text) && computeEffectiveLen(text) >= CJK_MIN_EFFECTIVE_LEN) return true;
  return false;
}

// ─── Identifier-exact-match precision bypass (default ON since v3.26.0) ──────
//
// Set CLAUDE_MEM_UPS_IDENTIFIER_BYPASS=0 to disable. Rationale: the score-floors below
// (OR_TOP_BM25_FLOOR / TOP_REL_FLOOR) drop the WHOLE FTS set when the top row's
// magnitude is weak. But a rare code identifier (camelCase / snake_case / CONST_CASE
// / kebab≥3) match has high *semantic* precision even at modest BM25 — a df=1 term
// like `sanitizeFtsQuery` scores only ~23 raw yet is an unambiguous hit. So an obs
// whose title/lesson EXACT-matches an identifier the prompt names is a precision pass
// — the same independent-signal rationale that already exempts sigRows (error
// signatures) and fileRows (file names) from these floors. Such rows are restored
// after the floors run.
//
// Default ON — flipped in v3.26.0 after a corrected benchmark/ups-ab.mjs re-measurement
// (#8858 two-bucket: TRUE off-topic FP isolated from on-topic eagerness). Over 12
// positives / 7 true-precision hard-negatives: recall up, TRUE off-topic FP = 0 (stable
// ×3 runs) → VERDICT NET-POSITIVE. The only behavior delta is on-topic eagerness (naming
// an identifier surfaces its obs) — the highest-precision injection trigger there is. The
// prose stop-list (IDENTIFIER_STOPWORDS) keeps the extractor off ordinary English.
export const IDENTIFIER_BYPASS = process.env.CLAUDE_MEM_UPS_IDENTIFIER_BYPASS !== '0';
const TECH_IDENTIFIER_RE_G = new RegExp(TECH_IDENTIFIER_RE.source, 'g');

// All tech-identifier tokens in `text`, lowercased + de-duped (for case-insensitive
// row matching). Empty array when none — callers treat that as "no bypass candidates".
export function extractTechIdentifiers(text) {
  return [...new Set((String(text || '').match(TECH_IDENTIFIER_RE_G) || []).map(s => s.toLowerCase()))]
    .filter(s => !IDENTIFIER_STOPWORDS.has(s));
}

// True when the obs row's title or lesson contains any of `idsLower` as a standalone
// token (not embedded in a longer identifier). Title/lesson only — the searchByFts
// SELECT carries no narrative, and requiring the hit in the title/lesson is the
// stricter, higher-precision condition (intentional).
export function rowMatchesIdentifier(row, idsLower) {
  if (!idsLower || idsLower.length === 0) return false;
  const hay = `${row.title || ''} ${row.lesson_learned || ''}`.toLowerCase();
  const isWordChar = (c) => c !== undefined && /[a-z0-9_]/.test(c);
  return idsLower.some((id) => {
    let from = 0, i;
    while ((i = hay.indexOf(id, from)) >= 0) {
      if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + id.length])) return true;
      from = i + 1;
    }
    return false;
  });
}

// ─── DB Query Functions ─────────────────────────────────────────────────────

// Returns { rows, mode } where mode is 'AND' (initial pass), 'OR' (fallback
// after AND returned 0), or null (no FTS query / sanitize rejected). Callers
// use `mode` to apply OR-specific gates — see OR_TOP_BM25_FLOOR rationale.
// Each row includes `bm25_raw` (pre-multiplier bm25 magnitude) alongside the
// composite `relevance`, so callers can distinguish raw-match strength from
// importance/type/decay inflation.
export function searchByFts(db, queryText, project, limit, typeFilter,
                            { nowT = Date.now(), epochTo = null } = {}) {
  const ftsQuery = sanitizeFtsQuery(queryText);
  if (!ftsQuery) return { rows: [], mode: null };

  const cutoff = nowT - LOOKBACK_MS;

  const typeClause = typeFilter ? 'AND o.type = ?' : '';
  const now = nowT;
  // R1: notLowSignalTitleClause() excludes hook-llm degraded titles
  // ("Modified X", "Worked on X", "Reviewed N files:", raw error logs).
  // v26 P0: noise penalty shrinks relevance magnitude for obs with high
  // inject:access ratio (auto-injected often, never cited/opened). See
  // docs/p0-injection-noise-baseline.txt.
  // A1 (v2.83): cite_factor closes the citation-decay → ranking loop. Obs the
  // assistant cited in past sessions (cited_count > 0) get boosted; obs with
  // accumulating uncited_streak get dampened upstream of importance-decay.
  // Disjoint signal from noise_penalty (which uses injection_count vs
  // access_count) — see scoring-sql.mjs::citeFactorClause for the math.
  const sql = `
    SELECT o.id, o.type, o.title, o.lesson_learned,
           ${OBS_BM25} as bm25_raw,
           ${injectionRelevanceSql('o')} as relevance
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ?
      AND o.project = ?
      AND o.importance >= 1
      AND o.created_at_epoch > ?
      AND (? IS NULL OR o.created_at_epoch <= ?)
      AND ${liveObsFilterSql('o')}
      AND ${notLowSignalTitleClause('o')}
      ${typeClause}
    ORDER BY relevance
    LIMIT ?
  `;

  const params = [now, ftsQuery, project, cutoff, epochTo, epochTo];
  if (typeFilter) params.push(typeFilter);
  params.push(limit);

  let rows = db.prepare(sql).all(...params);
  let mode = 'AND';

  // OR fallback if AND query returned nothing
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      params[1] = orQuery;
      rows = db.prepare(sql).all(...params);
      mode = 'OR';
    }
  }

  return { rows, mode };
}

function searchByFile(db, files, project, limit) {
  if (files.length === 0) return [];

  const cutoff = Date.now() - LOOKBACK_MS;
  const results = [];

  for (const file of files.slice(0, 3)) {
    const basename = file.split('/').pop();
    if (!basename || basename.length < 2) continue;
    const escaped = basename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;

    // R1: exclude LOW_SIGNAL degraded titles from file-level recall.
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 1
        AND ${liveObsFilterSql('o')}
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        AND ${notLowSignalTitleClause('o')}
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(project, cutoff, file, likePattern, limit);

    results.push(...rows);
  }

  // Deduplicate by id
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

// v2.34.5 Gap 1: prompts-table fallback. When observations-based paths
// (FTS / file-recall / sigRows / recent) all return empty, scan the user's
// own past prompts — meta/UX/"did we discuss this" questions often match
// prior prompts even when no observation was saved. Uses a simpler BM25
// ranking with no scoring multipliers and no top-|rel| gate (prompts are
// sparser and more surface-form than observations; the gate would rarely
// fire and mostly kill real hits).
function searchByUserPrompts(db, queryText, project, limit) {
  const ftsQuery = sanitizeFtsQuery(queryText);
  if (!ftsQuery) return [];

  const cutoff = Date.now() - LOOKBACK_MS;
  // Exclude <task-notification> internal protocol messages — parity with
  // server.mjs mem_search + mem-cli.mjs search (see lesson #8139: read-path
  // parity across paths querying the same table).
  const sql = `
    SELECT up.id, up.prompt_text, up.created_at_epoch,
           bm25(user_prompts_fts) as relevance
    FROM user_prompts_fts
    JOIN user_prompts up ON up.id = user_prompts_fts.rowid
    JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
    WHERE user_prompts_fts MATCH ?
      AND s.project = ?
      AND up.created_at_epoch > ?
      AND up.prompt_text NOT LIKE '<task-notification>%'
    ORDER BY relevance
    LIMIT ?
  `;

  let rows = db.prepare(sql).all(ftsQuery, project, cutoff, limit);

  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      try { rows = db.prepare(sql).all(orQuery, project, cutoff, limit); } catch {}
    }
  }

  // CJK precision filter (parity with server.mjs + mem-cli.mjs): unicode61
  // FTS degrades CJK bigram queries to single-char AND, letting any prose
  // sharing common chars leak through. Drop rows that miss < 20% of query
  // bigrams/keywords as contiguous substrings. Non-CJK queries bypass.
  return rows.filter(r => cjkPrecisionOk(queryText, r.prompt_text));
}

function searchRecent(db, project, limit) {
  const cutoff = Date.now() - LOOKBACK_MS;
  // R1: exclude LOW_SIGNAL degraded titles from "recent" recall intent
  // (e.g. when user asks "what did I do earlier"). Unqualified alias because
  // this query selects directly from observations with no join.
  return db.prepare(`
    SELECT id, type, title, lesson_learned
    FROM observations
    WHERE project = ?
      AND importance >= 1
      AND ${liveObsFilterSql('')}
      AND created_at_epoch > ?
      AND ${notLowSignalTitleClause('')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, cutoff, limit);
}

// ─── stdin Reader ───────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      reject(new Error('timeout'));
    }, 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      // Cap the prompt (#9494 huge-prompt guard) — deliberately tighter than the
      // 256KB full-payload tier; both tiers live in utils.mjs (G19).
      if (data.length > MAX_UPS_PROMPT_BYTES) {
        process.stdin.destroy();
        clearTimeout(timeout);
        resolve(data.slice(0, MAX_UPS_PROMPT_BYTES));
      }
    });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
    process.stdin.on('error', err => { clearTimeout(timeout); reject(err); });
    process.stdin.resume();
  });
}

// ─── Format Output ──────────────────────────────────────────────────────────

// Phase A (v2.31.3+): drop lesson suffix when MEM_QUIET_HOOKS=1; users on invited-memory
// path can mem_get the ID for full detail.
const QUIET_HOOKS = process.env.MEM_QUIET_HOOKS === '1';

function formatResults(rows) {
  if (!rows || rows.length === 0) return null;

  const lines = ['[mem] FYI — Related memories (continue your task):'];
  for (const r of rows) {
    const icon = typeIcon(r.type);
    // Defang replayed obs text before truncation: a poisoned title/lesson carrying tool-XML
    // or a forged authority tag must not render as a live delimiter in this injected block.
    const title = truncate(neutralizeContextDelimiters(r.title || ''), 70);
    const lesson = !QUIET_HOOKS && r.lesson_learned ? ` — ${truncate(neutralizeContextDelimiters(r.lesson_learned), 50)}` : '';
    lines.push(`#${r.id} ${icon} ${title}${lesson}`);
  }
  return lines.join('\n');
}

// v2.34.5 Gap 1: distinct header signals to Claude that these are prior
// *user questions*, not codebase lessons — helps the reader interpret the
// row correctly (surface-form match, not a saved insight). Truncate to 80
// chars (slightly longer than obs titles because prompts carry more context).
function formatPromptResults(rows) {
  if (!rows || rows.length === 0) return null;
  const lines = ['[mem] FYI — Past similar questions (continue your task):'];
  for (const r of rows) {
    // prompt_text is a raw prior USER prompt — the highest-risk replayed class (this is
    // exactly the column that carried malformed tool-XML into the handoff bug). Defang the
    // delimiters, then collapse whitespace + truncate.
    const text = truncate(neutralizeContextDelimiters(r.prompt_text || '').replace(/\s+/g, ' '), 80);
    lines.push(`P#${r.id} 💬 ${text}`);
  }
  return lines.join('\n');
}

// ─── Registry Skill Pointer (T4 v2.31) ─────────────────────────────────────
// Formerly "auto-load": we used to read the full SKILL.md body (up to 16KB)
// and inject it into stdout on keyword match. Now we only emit a short
// pointer line so Claude can decide to invoke via SkillTool. The cooldown
// and match mechanics below are unchanged.

const SKILL_COOLDOWN_FILE = join(DB_DIR, 'runtime', `.skill-cooldown-${inferProject()}`);
const SKILL_COOLDOWN_MS = 300_000; // 5 minutes

function loadManagedSkillNames() {
  if (!existsSync(REGISTRY_DB_PATH)) return new Set();
  try {
    const rdb = new Database(REGISTRY_DB_PATH, { readonly: true });
    rdb.pragma('busy_timeout = 500');
    try {
      // D#29: derive the managed marker from the env-aware data dir, not a hardcoded
      // homedir literal — under CLAUDE_MEM_DIR relocation the stored local_path lives at
      // DB_DIR/managed, so the old literal matched nothing and dropped every managed skill
      // from injection. Coarse LIKE prefilter; resource names are re-validated downstream.
      // D#29: derive the managed marker from the env-aware data dir, not a hardcoded
      // homedir literal — under CLAUDE_MEM_DIR relocation the stored local_path lives at
      // DB_DIR/managed, so the old literal matched nothing and dropped every managed skill
      // from injection. Coarse LIKE prefilter; resource names are re-validated downstream.
      const rows = rdb.prepare(`
        SELECT name FROM resources
        WHERE status = 'active' AND local_path LIKE ?
      `).all(`%${join(DB_DIR, 'managed') + sep}%`);
      return new Set(rows.map(r => r.name.toLowerCase()));
    } finally { rdb.close(); }
  } catch { return new Set(); }
}

function getSkillCooldown() {
  try {
    const raw = readFileSync(SKILL_COOLDOWN_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (now - v < SKILL_COOLDOWN_MS) cleaned[k] = v;
    }
    return cleaned;
  } catch { return {}; }
}

function setSkillCooldown(name) {
  try {
    const data = getSkillCooldown();
    data[name] = Date.now();
    const tmp = SKILL_COOLDOWN_FILE + `.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, SKILL_COOLDOWN_FILE);
  } catch { /* silent */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Prevent recursion from background claude -p calls
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) return;

  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw); } catch { return; }
  // JSON.parse('null'/'42'/'"x"') succeeds with a non-object; dereferencing .prompt on
  // it threw a raw TypeError → unhandled rejection → exit 1 (this was the lone hook
  // script without an exit-0 safety net, violating the "hooks never exit non-zero"
  // invariant — exit 2 on UserPromptSubmit would even block the user's prompt).
  if (!hookData || typeof hookData !== 'object') return;

  const rawPrompt = hookData.prompt || hookData.user_prompt;
  if (!rawPrompt || typeof rawPrompt !== 'string') return;

  // Skip internal protocol messages (check on raw text — protocol sentinel
  // would never legitimately be wrapped in <private>).
  if (rawPrompt.startsWith('<task-notification>')) return;

  // D#120: session-keyed dedup marker — every read/write below uses this path.
  const injectedIdsFile = injectedIdsFileFor(hookData.session_id);

  // Strip <private>...</private> blocks before length gates and FTS query
  // construction — private content must not pad effective length nor leak
  // into the FTS MATCH query terms. Mirrors hook.mjs handleUserPrompt.
  const promptText = stripPrivate(rawPrompt);

  // P0: User-explicit "ignore memory" override (mirrors CC built-in
  // memoryTypes.ts:215). Moved ABOVE the deterministic D# path so it
  // short-circuits ALL injection surfaces (previously ran after shouldSkip —
  // same outcome there, both return without output).
  if (detectMemOverride(promptText)) return;

  // ─── Deterministic D#N deferred-detail injection (v3.50) ──────────────────
  // A prompt naming D#N ("D#92 批准，进 writing-plans") is the highest-precision
  // trigger this hook has: the user is resuming a deferred item whose FULL
  // detail no list surface renders (defer list / dashboard are title-only —
  // the 2026-07-18 D#92 post-/clear failure chain). Runs BEFORE shouldSkip /
  // length gates: short approval prompts are the common case here, and the
  // trigger is exact-reference, not relevance-scored.
  let db = null;
  try {
    const deferredRefs = extractDeferredRefs(promptText);
    if (deferredRefs.length > 0) {
      db = ensureDb();
      const project = inferProject();
      const openRows = getDeferredByIds(db, deferredRefs)
        .filter(r => r.status === 'open' && r.project === project);
      // Namespace dedup ids as "D<id>" (parity with the "P<id>" prompt-corpus
      // convention) so obs ids can't collide in the shared injected-ids file.
      const dedupIds = openRows.map(r => `D${r.id}`);
      if (openRows.length > 0 && !shouldSkipByDedup(dedupIds, injectedIdsFile, hookData.session_id)) {
        const lines = ['[mem] Deferred work referenced in prompt (open items, full detail):'];
        for (const r of openRows) {
          const pTag = r.priority === 3 ? '🔴' : r.priority === 1 ? '⚪' : '🟡';
          lines.push(`D#${r.id} ${pTag} [P${r.priority}] ${neutralizeContextDelimiters(r.title || '')}`);
          if (r.detail) {
            // Full detail, defanged, never truncated — the point of this surface.
            for (const dl of neutralizeContextDelimiters(r.detail).split('\n')) lines.push(`  ${dl}`);
          }
        }
        process.stdout.write(lines.join('\n') + '\n');
        // Merge into the dedup file so a re-referencing prompt within the stale
        // window skips re-injection. A later FTS-path write replaces ids wholesale
        // (accepted: worst case is one cheap re-injection after an obs-emitting
        // prompt inside the same 5-min window).
        try {
          let prevIds = [];
          let prevCount = 0;
          try {
            const prev = JSON.parse(readFileSync(injectedIdsFile, 'utf8'));
            // M-6: inherit only same-session (or legacy) state — another session's
            // ids/count must not carry over. Atomic write below: a torn concurrent
            // write left the shared marker as invalid JSON (dedup silently off).
            if (prev.ts && Date.now() - prev.ts < DEDUP_STALE_MS
                && !(prev.session && hookData.session_id && prev.session !== hookData.session_id)) {
              prevIds = Array.isArray(prev.ids) ? prev.ids : [];
              prevCount = prev.count || 0;
            }
          } catch {}
          atomicWriteFileSync(injectedIdsFile, JSON.stringify({
            ids: [...new Set([...prevIds.map(String), ...dedupIds])],
            ts: Date.now(),
            count: prevCount + 1,
            ...(hookData.session_id ? { session: hookData.session_id } : {}),
          }));
        } catch {}
      }
    }
  } catch { /* deterministic path must never block the main flow */ }

  // Skip short/confirmation/slash-command/simple-op prompts
  if (shouldSkip(promptText)) { try { db?.close(); } catch {} return; }

  // T3 (v2.31): additional raw-length gate on top of shouldSkip's CJK-weighted
  // effective-length check. Suppresses medium-short Latin prompts ("run tests",
  // "fix bug now") that carry too few content tokens for a meaningful FTS lookup.
  // v2.33.1: follow-up prompts in an already-active session get a lower gate —
  // short continuations ("前面那个?", "does it work?") depend on prior context.
  const followUp = isFollowUpSession(injectedIdsFile);
  const promptMinLen = followUp ? FOLLOWUP_PROMPT_MIN_LENGTH : PROMPT_MIN_LENGTH;
  if (computeEffectiveLen(promptText.trim()) < promptMinLen) { try { db?.close(); } catch {} return; }
  const bm25Floor = followUp ? FOLLOWUP_BM25_MIN_SCORE : BM25_MIN_SCORE;

  // db may already be open from the deterministic D# path above.
  if (!db) {
    try {
      db = ensureDb();
    } catch (e) {
      // A failed DB open silently kills EVERY prompt-time injection while `stats`
      // reads zero errors (audit 2026-08-14 M-5) — record before the mandatory
      // swallow. Exact blindness class of the 2026-08-13 pre-recall:db-open outage.
      recordHookError('ups:db-open', e, RUNTIME_DIR);
      return;
    }
  }

  try {
    const project = inferProject();
    const intent = detectIntent(promptText);
    let rows = [];

    // A (v2.32.8): precision pass for named errors. When the prompt contains
    // a typed exception signature (TypeError/ValueError/ReferenceError/...),
    // seed results with exact-match bugfix observations before the intent-
    // based FTS flow runs. These hits are the most directly relevant and
    // take priority slots in the merged output.
    const errSig = extractErrorSignature(promptText);
    const sigRows = errSig
      ? searchByFts(db, errSig.signature, project, 2, 'bugfix').rows.filter(r =>
          typeof r.relevance === 'number' && Math.abs(r.relevance) >= bm25Floor
        )
      : [];

    // v2.57.x explicit-signal gate. Compute files once for both the gate and
    // the file-recall path below — extractFiles is regex over the prompt,
    // safe to call eagerly. errSig + intent already computed above.
    const filesForGate = extractFiles(promptText);
    const signalPresent = hasExplicitSignal(promptText, {
      errSig, files: filesForGate, intent,
    });
    // Identifier tokens the prompt names (for the precision bypass below). Empty only
    // when CLAUDE_MEM_UPS_IDENTIFIER_BYPASS=0 (bypass is default-on), then it is a no-op.
    const promptIdentifiers = IDENTIFIER_BYPASS ? extractTechIdentifiers(promptText) : [];

    if (intent?.useRecent) {
      // Recall intent: show recent observations
      rows = searchRecent(db, project, intent.limit);
    } else if (REQUIRE_EXPLICIT_SIGNAL && !signalPresent) {
      // No explicit signal — skip FTS pipeline + prompt-fallback. sigRows
      // is already empty (errSig was null else signalPresent would be true).
      // Registry skill pointer below remains unaffected (its own name match).
      rows = [];
    } else {
      // FTS search: use the prompt as query, optionally type-filtered
      const files = filesForGate;
      let ftsResult = searchByFts(db, promptText, project, intent?.limit || MAX_RESULTS, intent?.type || null);
      // Fallback: if typed search returned nothing, retry without type filter
      if (ftsResult.rows.length === 0 && intent?.type) {
        ftsResult = searchByFts(db, promptText, project, intent.limit || MAX_RESULTS, null);
      }
      let ftsRows = ftsResult.rows;
      const ftsMode = ftsResult.mode;
      const fileRows = files.length > 0 ? searchByFile(db, files, project, 2) : [];

      // T3 (v2.31): BM25 magnitude threshold — drop FTS hits whose relevance
      // magnitude doesn't clear the floor. This targets OR-fallback leakage
      // where a single-stem match surfaces tangential observations. Only FTS
      // rows carry a `relevance` column; file-recall rows (searchByFile) have
      // no relevance and are always kept — file-scoped recall is presumed
      // intentional and has its own relevance signal (the file name match).
      ftsRows = ftsRows.filter(r =>
        typeof r.relevance === 'number' && Math.abs(r.relevance) >= bm25Floor
      );

      // Identifier-exact-match precision bypass (default on — see IDENTIFIER_BYPASS).
      // Capture rows that exact-match a prompt identifier BEFORE the set-floors below;
      // they carry independent precision signal (sigRows/fileRows rationale) and are
      // restored after the floors so a low top-score can't drop a named-identifier hit.
      const bypassRows = (IDENTIFIER_BYPASS && promptIdentifiers.length > 0)
        ? ftsRows.filter(r => rowMatchesIdentifier(r, promptIdentifiers))
        : [];

      // v2.43.x: OR-mode raw-BM25 floor. In OR-fallback mode the composite
      // TOP_REL_FLOOR below is inflated by importance × type_quality × decay
      // multipliers — a weak single-stem hit on an importance=3 bugfix obs
      // can reach composite rel=66 while raw |bm25|=19. Gate on raw bm25
      // magnitude for OR mode only; AND mode's all-stems-match constraint
      // is a precision signal and routinely produces legitimate AND hits
      // below raw |bm25|=20 that we do not want to drop (see GOOD-narrow
      // probe). Skip gate when OR_TOP_BM25_FLOOR is set to 0 (test hook).
      // Both absolute floors are normalized by corpus size (corpusFloorScale) —
      // factor 1.0 for any install at/above the calibration corpus, so this is a
      // no-op for established users and a proportional relaxation for new ones.
      const floorScale = corpusFloorScale(db);
      const orFloor = OR_TOP_BM25_FLOOR * floorScale;
      if (ftsMode === 'OR' && orFloor > 0 && ftsRows.length > 0) {
        const topBm25 = Math.abs(ftsRows[0].bm25_raw || 0);
        if (topBm25 < orFloor) ftsRows = [];
      }

      // v2.34.3: top-|rel| sanity gate. Per-row filtering above leaves noise
      // prompts intact when many rows share a weak stem (all in 25..48 range).
      // If the best remaining FTS match is below the top floor, drop the
      // whole FTS set — noise prompts should produce no FTS injection.
      // Query orders by `relevance` ASC; negative values → ftsRows[0] has the
      // largest magnitude (strongest match) in this scoring expression.
      if (ftsRows.length > 0 && Math.abs(ftsRows[0].relevance) < TOP_REL_FLOOR * floorScale) {
        ftsRows = [];
      }

      // Restore identifier-matched precision rows the set-floors above dropped.
      // No-op when the bypass is off (bypassRows is []) or when the floors kept the
      // rows anyway (dedup by id). Re-sort so the merged set stays relevance-ordered.
      if (bypassRows.length > 0) {
        const kept = new Set(ftsRows.map(r => r.id));
        for (const r of bypassRows) if (!kept.has(r.id)) ftsRows.push(r);
        ftsRows.sort((a, b) => (a.relevance ?? 0) - (b.relevance ?? 0));
      }

      // Merge: FTS results first, then file results, deduplicated
      const seen = new Set(ftsRows.map(r => r.id));
      rows = [...ftsRows];
      for (const r of fileRows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          rows.push(r);
        }
      }
      rows = rows.slice(0, MAX_RESULTS);
    }

    // A (v2.32.8): prepend error-signature hits (higher precision), dedup, cap.
    if (sigRows.length > 0) {
      const sigIds = new Set(sigRows.map(r => r.id));
      rows = [...sigRows, ...rows.filter(r => !sigIds.has(r.id))].slice(0, MAX_RESULTS);
    }

    // v2.34.5 Gap 1: if observations-based search drew a blank, try the
    // user_prompts corpus. Only fires when `rows` is empty (obs hits
    // suppress the fallback to avoid noise). Namespace prompt IDs with
    // a "P" prefix so shouldSkipByDedup's Set comparison doesn't collide
    // with future observation IDs.
    //
    // v2.57.x: also gated by signalPresent. The prompt-fallback path has
    // no quality gate (only BM25 ordering — see PROMPT_FALLBACK_LIMIT
    // rationale at top), so injecting it on no-signal prompts is the
    // single highest-noise UPS path. Restored when REQUIRE_SIGNAL=0.
    let promptRows = [];
    if (rows.length === 0 && (!REQUIRE_EXPLICIT_SIGNAL || signalPresent)) {
      promptRows = searchByUserPrompts(db, promptText, project, PROMPT_FALLBACK_LIMIT);
    }

    const candidateIds = rows.length > 0
      ? rows.map(r => r.id)
      : promptRows.map(r => `P${r.id}`);
    const dedupSkip = shouldSkipByDedup(candidateIds, injectedIdsFile, hookData.session_id);

    const output = !dedupSkip
      ? (rows.length > 0 ? formatResults(rows) : formatPromptResults(promptRows))
      : null;
    if (output) {
      process.stdout.write(output + '\n');
      // Write injected IDs for dedup with hook.mjs handleUserPrompt + self-dedup
      try {
        let prevCount = 0;
        try {
          const prev = JSON.parse(readFileSync(injectedIdsFile, 'utf8'));
          // M-6: same-session (or legacy) count only; atomic write (torn-write guard).
          if (prev.ts && Date.now() - prev.ts < DEDUP_STALE_MS
              && !(prev.session && hookData.session_id && prev.session !== hookData.session_id)) {
            prevCount = prev.count || 0;
          }
        } catch {}
        atomicWriteFileSync(injectedIdsFile, JSON.stringify({
          ids: candidateIds,
          ts: Date.now(),
          count: prevCount + 1,
          ...(hookData.session_id ? { session: hookData.session_id } : {}),
        }));
      } catch {}
      // v26 P0: bump injection_count for obs-based emits only (prompt-corpus
      // rows have "P<id>" string IDs; skip those — they live in user_prompts).
      // Per-row try/catch: observations_au trigger reinserts FTS on any UPDATE
      // (project_non_obvious.md); an FTS corruption on one row must not abort
      // counter bumps for other rows.
      if (rows.length > 0) {
        try {
          const now = Date.now();
          const bumpStmt = db.prepare(
            'UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1, last_injected_at = ? WHERE id = ?'
          );
          for (const r of rows) {
            try { bumpStmt.run(now, r.id); } catch {}
          }
        } catch {}
      }
    }

    // ─── L1: Registry skill pointer (T4 v2.31) ──────────────────────────
    // Previously this block injected the full skill body (up to 16KB) on
    // keyword match, silently inflating every matched prompt. We now emit a
    // single pointer line so Claude can decide to invoke via SkillTool on
    // demand — the cooldown and match preconditions stay identical.
    try {
      const skillNames = loadManagedSkillNames();
      const matched = matchRegistrySkillName(promptText, skillNames);
      if (matched) {
        const cooldown = getSkillCooldown();
        if (!cooldown[matched]) {
          // Registry skill names come from third-party repos (tools/adopt import) — an
          // untrusted boundary like every other DB-derived string on this surface.
          const safeName = neutralizeContextDelimiters(matched);
          process.stdout.write(
            `\n[mem] Skill "${safeName}" may apply — invoke via SkillTool or run: claude-mem-lite registry show ${safeName}\n`
          );
          setSkillCooldown(matched);
        }
      }
    } catch { /* silent — never block on registry failure */ }

    // ─── L2: Intent-based skill recommendation (shadow-first, v3.12) ─────
    // Distinct from L1 (explicit-name pointer): fires on intent even when the
    // user did not name a skill. Phase 1 = shadow only (logs, never emits).
    // Reuses a readonly registry DB; cooldown/shadow writes go to the FS.
    try {
      if (existsSync(REGISTRY_DB_PATH)) {
        // #8259: explicit-signal presence is the decisive lever for UPS injection
        // quality (UPS cite-recall was 25.8% until gated on it). Logged in shadow so
        // Phase 2 can decide whether live injection gates on it. Shadow measures broadly.
        const hasSignal = !!(extractErrorSignature(promptText) || extractFiles(promptText).length > 0 || detectIntent(promptText));
        const rdb = new Database(REGISTRY_DB_PATH, { readonly: true });
        rdb.pragma('busy_timeout = 500');
        // CC session_id (hook stdin) is the cross-hook pairing key: PostToolUse adoptions
        // in this same session join back to this reco for matched precision (B1).
        try { recommendSkill(rdb, promptText, inferProject(), { hasSignal, sessionId: hookData.session_id }); }
        finally { rdb.close(); }
      }
    } catch { /* silent — never block on recommendation failure */ }
  } catch (e) {
    // Hooks must never break Claude Code — swallow, but RECORD: this catch wraps
    // every FTS query on the surface, so a schema/FTS drift here would zero out
    // prompt-time injection with no trace anywhere (audit 2026-08-14 M-5).
    recordHookError('ups:search', e, RUNTIME_DIR);
  } finally {
    try { db.close(); } catch {}
  }
}

// Swallow any rejection so the hook can never surface a non-zero exit (the invariant
// every sibling hook script upholds). Deliberately NOT `.finally(process.exit(0))` —
// this hook detaches a background `claude -p` search and a forced exit would kill it;
// letting the loop drain naturally exits 0 once the detached child is unref'd.
// Import guard (mirrors benchmark/longmemeval.mjs): only auto-run when this file is
// executed directly as the UserPromptSubmit hook, not when a benchmark/test harness
// imports it to call searchByFts() offline (see tests/adoption-searchbyfts-snapshot.test.mjs).
//
// Exported as a pure predicate (side-effect-free) so a regression test can
// exercise it directly without triggering main(). hook-launcher.mjs's
// self-heal retry (runEntry({ bustCache: true })) re-imports this entry with
// a cache-buster query appended (`?t=<ts>`) so Node's ESM cache doesn't
// return the earlier ERR_MODULE_NOT_FOUND rejection, while process.argv[1]
// stays query-less — a strict `===` here evaluated false on that retry,
// silently skipping main() so the healed hook fire did no memory search.
// Stripping the query before comparing fixes that without weakening the
// normal-launcher / execFileSync direct-invocation checks (both still match
// exactly, query or no query).
export function isDirectInvocation(metaUrl, argv1) {
  if (!argv1) return false;
  return metaUrl.split('?')[0] === pathToFileURL(argv1).href;
}
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  // Last-resort telemetry for anything that escapes main()'s own catches (e.g. a
  // throw between the entry and the guarded body). Recorder never throws; the
  // outer catch keeps the never-non-zero-exit invariant regardless.
  main().catch((e) => { try { recordHookError('ups:main', e, RUNTIME_DIR); } catch { /* never */ } });
}
