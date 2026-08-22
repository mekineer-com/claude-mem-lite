// claude-mem-lite — Semantic Memory Injection
// Search past observations for relevant memories to inject as context at user-prompt time.

import { relaxFtsQueryToOr, debugCatch, truncate, OBS_BM25, notLowSignalTitleClause, noisePenaltyClause, tokenizeHandoff, HANDOFF_STOP_WORDS, extractCjkKeywords, neutralizeContextDelimiters } from './utils.mjs';
import { upsFtsQuery } from './lib/ups-query.mjs';
import { citeFactorJs, TYPE_QUALITY, TYPE_QUALITY_DEFAULT } from './scoring-sql.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';
import { recordMetric } from './lib/metrics.mjs';
import { DB_DIR } from './schema.mjs';
import { extractIdents } from './lib/lesson-idents.mjs';
import { formatSubagentContext } from './lib/task-imperative.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
const MAX_MEMORY_INJECTIONS = 3;
const MEMORY_LOOKBACK_MS = 60 * DAY_MS; // 60 days
// Type weights come from scoring-sql.mjs — this was a hand-copy kept equal by an
// "aligned with (R2)" comment (audit 2026-08-22, P2-10).
// lesson_learned boost (1.5×) stacks for entries with a real takeaway.
// Adaptive BM25 thresholds — scale with corpus size to filter noise.
// Larger corpora produce more weak matches from common words.
const BM25_THRESHOLD = { TINY: 0, SMALL: 1.5, MEDIUM: 2.5, LARGE: 3.5 };
// OR fallback max token count — when an AND query returns nothing, retry as OR
// only if the query has at most this many significant terms. Natural-language
// user prompts ("how did we fix the parser null deref bug?") almost always
// exceed this after synonym expansion, so the old hard 2 silently denied them
// the OR rescue and the UPS injection path returned 0 results for real prompts
// (semantic-keyed recall measured at 26%, #8255; 0/11 on a realistic NL corpus).
// Precision for OR results is already enforced downstream by three independent
// gates — the 0.4x OR penalty, the adaptive BM25 threshold, and the 40%
// term-coverage filter (v27) — so the token gate is a redundant, overly-strict
// fourth guard predating term-coverage. Default raised to 8 (covers typical NL
// prompts); env override `MEM_OR_FALLBACK_MAX_TOKENS` ∈ [0, 50], invalid → 8.
function getOrFallbackMaxTokens() {
  const raw = process.env.MEM_OR_FALLBACK_MAX_TOKENS;
  if (raw === undefined || raw === '') return 8;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 50 ? n : 8;
}

// v27: term-coverage post-filter. Drops high-BM25 candidates whose visible
// fields (title + lesson_learned) cover <N% of the query's significant terms.
// Catches the failure mode where FTS tokenization reduces a rich query to a
// sparse token set and rows sharing only one common word get ranked high.
// Default 0.4 (≥40% term coverage). Env override `MEM_COVERAGE_THRESHOLD` ∈ [0,1];
// set to 0 to disable entirely.
const COVERAGE_MIN_QUERY_TERMS = 2;
function getCoverageThreshold() {
  const raw = process.env.MEM_COVERAGE_THRESHOLD;
  if (raw === undefined || raw === '') return 0.4;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.4;
}

// v2.41: cross-project boost (applied to decisions/discoveries from other
// projects). Default 0.4 = 60% penalty vs same-project hits. Was 0.7 (30%), but
// a cross-project audit found that a 30% discount let strongly-matching but
// off-topic decisions still win injection slots in unrelated projects (e.g. an
// FTS5 SQL gotcha surfacing in a UI session). Transferable insights are the
// minority of cross-project matches, so the penalty should be steep; raise it
// back via env for installs that want more sharing.
// Env override `MEM_CROSS_PROJECT_BOOST` ∈ [0, 1]; clamped, invalid → default.
function getCrossProjectBoost() {
  const raw = process.env.MEM_CROSS_PROJECT_BOOST;
  if (raw === undefined || raw === '') return 0.4;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.4;
}
function extractQueryTerms(text) {
  if (!text) return [];
  const ascii = tokenizeHandoff(text).filter(t => !HANDOFF_STOP_WORDS.has(t));
  let cjk = [];
  try { cjk = extractCjkKeywords(text) || []; } catch { /* CJK extraction best-effort */ }
  return [...new Set([...ascii, ...cjk.map(t => String(t).toLowerCase())])];
}
// v2.41: hay spans every FTS column whose BM25 weight is >=5 in OBS_BM25
// (title=10, subtitle=5, narrative=5, lesson_learned=8). Pre-v2.41 was only
// title + lesson_learned — rows that matched on narrative but happened to
// omit the term from title/lesson were dropped by the 0.4 threshold even
// though FTS ranked them strongly. Narrative is clipped to its first 400 chars
// because coverage is a membership check, not a frequency count; the tail
// rarely adds new terms and the worst-case string concatenation stays small.
const COVERAGE_NARRATIVE_PREFIX = 400;
function candidateCoverage(row, queryTerms) {
  if (queryTerms.length === 0) return 1.0;
  const narrativeHead = (row.narrative || '').slice(0, COVERAGE_NARRATIVE_PREFIX);
  const hay = `${row.title || ''} ${row.subtitle || ''} ${row.lesson_learned || ''} ${narrativeHead}`.toLowerCase();
  let hits = 0;
  for (const t of queryTerms) {
    if (/[^ -~]/.test(t)) {
      // Non-ASCII (CJK etc): no word boundary semantics, substring match is correct.
      if (hay.includes(t)) hits++;
    } else {
      // ASCII: require word-boundary match so "race" doesn't match "trace".
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(hay)) hits++;
    }
  }
  return hits / queryTerms.length;
}


// P1: stale-obs verify-before-use threshold. An injected obs older than this
// AND carrying file paths is flagged so Claude is reminded to grep/Read the
// referenced code before applying the lesson — code may have moved or been
// renamed since capture. Pure-decision/architecture obs (no file_paths)
// don't get the hint: their drift is text-only and Claude already verifies
// at consumption time per the project mem-usage contract.
const STALE_OBS_THRESHOLD_MS = 30 * DAY_MS;

/**
 * Format a single line for the <memory-context> block emitted by
 * handleUserPrompt. Pure function — exported for unit testing.
 *
 * @param {object} obs Row with {id, type, title, lesson_learned,
 *   created_at_epoch, files_modified}. files_modified is a JSON-encoded
 *   string array (column shape) or null.
 * @returns {string} `- [type] title[ | Lesson: X] (#id)[ [verify-before-use]]`
 */
export function formatMemoryLine(obs) {
  // truncate (not raw): caps the per-hit token cost (an unbounded lesson bloated every
  // memory-context line) AND collapses newlines — a multi-line lesson pushed the trailing
  // "(#NN)" onto a later physical line that failed the "- [" prefix gate in
  // citation-tracker's UserPromptSubmit extractor, so the obs never entered the
  // citation-decay denominator (its promote/demote loop was silently dead).
  const lessonTag = obs.lesson_learned ? ` | Lesson: ${truncate(obs.lesson_learned, 200)}` : '';
  let staleHint = '';
  if (typeof obs.created_at_epoch === 'number'
    && Date.now() - obs.created_at_epoch > STALE_OBS_THRESHOLD_MS
    && hasFilePaths(obs.files_modified)) {
    staleHint = ' [verify-before-use]';
  }
  // Defang any literal block-delimiter tag in title/lesson so it can't prematurely close
  // the <memory-context> block this line is injected into (parity with hook-context's
  // <claude-mem-context> defense).
  return neutralizeContextDelimiters(`- [${obs.type}] ${truncate(obs.title, 80)}${lessonTag} (#${obs.id})${staleHint}`);
}

function hasFilePaths(filesModified) {
  if (!filesModified || typeof filesModified !== 'string') return false;
  try {
    const arr = JSON.parse(filesModified);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/**
 * Search for relevant past observations to inject as memory context.
 * Quality gates: importance>=1 (with 0.6x penalty), type-boosted, lesson-boosted, BM25-thresholded (adaptive: 0 for <5 obs, 1.5 otherwise).
 * @param {import('better-sqlite3').Database} db Memory database
 * @param {string} userPrompt User's prompt text
 * @param {string} project Current project
 * @param {number[]} excludeIds Observation IDs already in Key Context
 * @returns {object[]} Top memories (max 3) with {id, type, title, lesson_learned}
 */
export function searchRelevantMemories(db, userPrompt, project, excludeIds = []) {
  // Min-length guard is English-centric: 5 chars ≈ one short English word. A CJK
  // query is meaningful at 2 chars (状态/架构) and most real Chinese queries are
  // 2-4 chars (状态管理, 召回率, 熔断降级) — the bare `.length < 5` silently
  // rejected ALL of them, so a Chinese-primary user got zero memory injection.
  // Apply the 5-char floor only to non-CJK queries; CJK needs ≥2.
  if (!db || !userPrompt) return [];
  const queryHasCjk = /[一-鿿㐀-䶿]/.test(userPrompt);
  if (userPrompt.length < (queryHasCjk ? 2 : 5)) return [];
  // CJK-DOMINANT (not merely CJK-containing) gates the OR-fallback bypass below.
  // A substring test would let one incidental CJK char — an IME-leaked particle,
  // a 中文 noun in an otherwise-English prompt — flip OR-fallback on and inject
  // off-topic noise (a real precision regression for bilingual users). Require
  // CJK chars to be at least as many as ASCII letters so only genuinely-Chinese
  // queries (优化召回率) get the bigram-inflation rescue, not "fix the bug 啊".
  const _cjkChars = (userPrompt.match(/[一-鿿㐀-䶿]/g) || []).length;
  const _asciiLetters = (userPrompt.match(/[A-Za-z]/g) || []).length;
  const queryIsCjkDominant = _cjkChars > 0 && _cjkChars >= _asciiLetters;

  // v2.41 metrics: record timing + candidate/filter/return counts per call.
  // Gated by CLAUDE_MEM_METRICS=1 — no-op when disabled (zero hot-path cost).
  const _t0 = Date.now();
  let _candidates = 0, _aboveThreshold = 0, _returned = 0, _orFired = false;
  const _emit = () => {
    try {
      recordMetric(DB_DIR, {
        event: 'inject',
        durationMs: Date.now() - _t0,
        candidates: _candidates,
        aboveThreshold: _aboveThreshold,
        returned: _returned,
        orFallback: _orFired,
      });
    } catch { /* metric record must not crash the caller */ }
  };

  try {
    // upsFtsQuery, not bare sanitizeFtsQuery: this is the SECOND hook UserPromptSubmit
    // fires, and v3.75.0 capped only the first. This one is the worse half — its stdin
    // ceiling is MAX_HOOK_STDIN_BYTES (256KB) against path A's 64KB, and nothing
    // truncates between stdin and here. The caps are shared, not copied, so the two
    // faces of one event cannot drift apart again.
    const ftsQuery = upsFtsQuery(userPrompt);
    if (!ftsQuery) return [];

    const cutoff = Date.now() - MEMORY_LOOKBACK_MS;
    const excludeSet = new Set(excludeIds);

    // Phase 1: Same-project search (highest priority)
    // R1: notLowSignalTitleClause() excludes hook-llm fallback titles
    // ("Modified X", "Worked on X", "Reviewed N files:", raw error logs, etc.)
    // that almost never get referenced (3.3% access rate) but compete for BM25 rank.
    // v26 P0: noise_penalty is multiplied AFTER sort-BM25 so the column used
    // for ORDER BY stays the penalty-adjusted `relevance` applied downstream
    // in JS (scored.sort). SELECT exposes both raw BM25 (for sort) and the
    // penalty factor (for the final JS score).
    const selectStmt = db.prepare(`
      SELECT o.id, o.type, o.title, o.subtitle, o.narrative, o.importance, o.lesson_learned, o.project,
             o.created_at_epoch, o.files_modified,
             o.cited_count, o.uncited_streak,
             ${OBS_BM25} as relevance,
             ${noisePenaltyClause('o')} as noise_penalty
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project = ?
        AND o.importance >= 1
        AND o.created_at_epoch > ?
        AND ${liveObsFilterSql('o')}
        AND ${notLowSignalTitleClause('o')}
      ORDER BY ${OBS_BM25}
      LIMIT 10
    `);
    let rows = selectStmt.all(ftsQuery, project, cutoff);
    let usedOrFallback = false;

    // OR fallback when AND returns nothing — only for short queries (specific enough).
    // 3+ token queries that fail AND are likely off-topic; OR would match individual common words.
    // Count original search terms (AND-separated groups), not expanded synonym tokens.
    const queryTokenCount = ftsQuery.includes(' AND ')
      ? ftsQuery.split(' AND ').length
      : ftsQuery.split(/\s+/).filter(t => t && !t.startsWith('(') && !t.endsWith(')')).length;
    // CJK-dominant queries bypass the token-count gate: a single CJK word becomes
    // 2-N overlapping bigrams (优化召回率 → 优化/召回/回率), inflating
    // queryTokenCount past the gate, so the AND-too-strict query never gets the OR
    // rescue that CJK retrieval relies on. The CLI/hybrid path relaxes CJK to OR
    // unconditionally; mirror that here. Noise is contained downstream (0.4x OR
    // penalty + BM25 threshold + term-coverage filter). queryIsCjkDominant (not
    // mere CJK presence) is the gate — see its definition at the function top.
    const orFallbackMaxTokens = getOrFallbackMaxTokens();
    if (rows.length === 0) {
      const orQuery = relaxFtsQueryToOr(ftsQuery);
      if (orQuery && (queryIsCjkDominant || queryTokenCount <= orFallbackMaxTokens)) {
        // debugCatch, not a bare swallow: this is the injection chain's LAST query, and
        // an FTS5 fault here (corrupt index, malformed relaxed query) degrades to an
        // EMPTY injection that reads exactly like "nothing matched" — invisible to
        // stats and doctor alike. Still non-fatal; the prompt must go through.
        // (The two bare catches further down, around the per-row access bumps, are
        // deliberately left bare: they are write-path and per-row, so logging them would
        // flood the debug stream on the same corruption this one reports once.)
        try { rows = selectStmt.all(orQuery, project, cutoff); usedOrFallback = true; }
        catch (e) { debugCatch(e, 'injectMemory:orFallback'); }
      }
    }

    // Phase 2: Cross-project search for high-value decisions/discoveries
    // These are transferable insights (debugging patterns, architectural reasons, gotchas)
    let crossRows = [];
    let crossUsedOr = false;
    try {
      const crossStmt = db.prepare(`
        SELECT o.id, o.type, o.title, o.subtitle, o.narrative, o.importance, o.lesson_learned, o.project,
               o.created_at_epoch, o.files_modified,
               o.cited_count, o.uncited_streak,
               ${OBS_BM25} as relevance,
               ${noisePenaltyClause('o')} as noise_penalty
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.project != ?
          AND o.type IN ('decision', 'discovery')
          AND o.importance >= 2
          AND o.created_at_epoch > ?
          AND ${liveObsFilterSql('o')}
          AND ${notLowSignalTitleClause('o')}
        ORDER BY ${OBS_BM25}
        LIMIT 5
      `);
      crossRows = crossStmt.all(ftsQuery, project, cutoff);
      if (crossRows.length === 0) {
        const orQuery = relaxFtsQueryToOr(ftsQuery);
        if (orQuery && (queryIsCjkDominant || queryTokenCount <= orFallbackMaxTokens)) {
          // Same reasoning as the same-project OR fallback above: a fault here silently
          // drops the cross-project half of the injection.
          try { crossRows = crossStmt.all(orQuery, project, cutoff); crossUsedOr = true; }
          catch (e) { debugCatch(e, 'injectMemory:crossOrFallback'); }
        }
      }
    } catch (e) { debugCatch(e, 'crossProjectSearch'); }

    // Merge and score: same-project full weight, cross-project (default 0.7x).
    // v2.41: cross-project penalty is env-overridable via MEM_CROSS_PROJECT_BOOST
    // (0..1). Default 0.7 — tuned for typical multi-project installs where
    // transferable decisions/discoveries are a minority of matches. Set to 1.0
    // for single-project users (no effective penalty); set lower to tighten
    // same-project focus in noisy cross-project environments.
    //
    // OR-fallback results get 0.4x penalty — they matched individual words, not the full intent
    // v26 P0: noise_penalty (from SQL) shrinks high-inject/low-cite rows.
    const crossPenalty = getCrossProjectBoost();
    const allRows = [...rows.map(r => ({ ...r, _or: usedOrFallback })), ...crossRows.map(r => ({ ...r, _or: crossUsedOr }))];
    const scored = allRows
      .filter(r => !excludeSet.has(r.id))
      .map(r => {
        const crossProjectPenalty = r.project === project ? 1.0 : crossPenalty;
        const orFallbackPenalty = r._or ? 0.4 : 1.0;
        const noisePenalty = typeof r.noise_penalty === 'number' ? r.noise_penalty : 1.0;
        const citeFactor = citeFactorJs(r);
        return {
          ...r,
          score: Math.abs(r.relevance)
            * (TYPE_QUALITY[r.type] || TYPE_QUALITY_DEFAULT)
            * (r.lesson_learned ? 1.5 : 1.0)
            * (r.importance >= 2 ? 1.0 : 0.6)
            * crossProjectPenalty
            * orFallbackPenalty
            * noisePenalty
            * citeFactor,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Adaptive threshold: scales with corpus size to filter noise.
    // Each result must individually exceed the threshold (not just the top one).
    const obsCount = db.prepare(
      `SELECT COUNT(*) as c FROM observations WHERE project = ? AND ${liveObsFilterSql('')}`,
    ).get(project)?.c || 0;
    const { TINY, SMALL, MEDIUM, LARGE } = BM25_THRESHOLD;
    const threshold = obsCount < 5 ? TINY : obsCount < 100 ? SMALL : obsCount < 500 ? MEDIUM : LARGE;
    _candidates = scored.length;
    _orFired = usedOrFallback || crossUsedOr;
    const aboveThreshold = scored.filter(r => r.score >= threshold);
    _aboveThreshold = aboveThreshold.length;
    if (aboveThreshold.length === 0) { _emit(); return []; }

    // v27: term-coverage filter — drop candidates whose title+lesson_learned
    // covers <threshold of the query's significant terms. Skipped for
    // single-term queries (coverage signal is meaningless) and when the env
    // override disables it.
    let coverageFiltered = aboveThreshold;
    const coverageThreshold = getCoverageThreshold();
    if (coverageThreshold > 0) {
      const queryTerms = extractQueryTerms(userPrompt);
      if (queryTerms.length >= COVERAGE_MIN_QUERY_TERMS) {
        coverageFiltered = aboveThreshold.filter(r => candidateCoverage(r, queryTerms) >= coverageThreshold);
        if (coverageFiltered.length === 0) { _emit(); return []; }
      }
    }

    // v26 P0: bump injection_count (NOT access_count) for injected rows.
    // Before v26 this was bumping access_count, which conflated auto-injection
    // with real cites/recalls/opens — polluting the noise-ratio signal the
    // penalty clause now depends on.
    //
    // The two counters are NOT a metering pair, and reading them as one is how
    // 2026-08-22 produced a wrong diagnosis off this very comment. Enumerated
    // from the write sites rather than from memory:
    //   access_count    — lib/recall-core.mjs (mem_recall / CLI recall),
    //                     lib/get-core.mjs (mem_get), lib/timeline-core.mjs
    //                     (timeline anchor), lib/citation-tracker.mjs (CITED
    //                     ids only). All explicit. This comment used to list
    //                     "pre-tool-recall" here too; scripts/pre-tool-recall.js
    //                     bumps NOTHING, and the only code that would have was
    //                     the unreferenced `recallForFile` twin deleted below.
    //   injection_count — this line and scripts/user-prompt-search.js only, and
    //                     deliberately so: scoring-sql.mjs noisePenaltyClause
    //                     reads it as a NOISE signal (x0.5 at >=4, x0.2 at >=8),
    //                     so it is valid only on QUERY-CONDITIONED faces. v3.66.0
    //                     added an unconditional Key Context bump "mirroring"
    //                     this one and v3.66.1 reverted it — an always-rendered
    //                     face measures elapsed sessions, not noise (D#124,
    //                     lib/keyctx-marker.mjs:53). The complete per-face
    //                     denominator is citation_surface_log, not this column.
    // Per-row try/catch for FTS trigger safety (project_non_obvious.md).
    const result = coverageFiltered.slice(0, MAX_MEMORY_INJECTIONS);
    const now = Date.now();
    const bumpStmt = db.prepare(
      'UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1, last_injected_at = ? WHERE id = ?'
    );
    for (const r of result) {
      try { bumpStmt.run(now, r.id); } catch {}
    }

    _returned = result.length;
    _emit();
    return result;
  } catch (e) {
    debugCatch(e, 'searchRelevantMemories');
    _emit();
    return [];
  }
}

// `recallForFile` lived here until 2026-08-22: an in-process file-recall
// implementation with ZERO production callers, superseded by the standalone
// scripts/pre-tool-recall.js hook (which owns the cooldown, scope filter,
// edge-decay filter and event leg this function never had). Five test files
// asserted against it, which made it look alive and cost real money twice:
//   - its bare `%<basename>` LIKE lacked the path-boundary arms that
//     lib/file-edge-match.mjs added for the bash-utils.mjs/utils.mjs collision;
//   - it was the ONLY code splitting basenames on either separator, so the six
//     Windows-path tests aimed at it went green while the shipped predicate
//     carried the gap (fixed in lib/file-edge-match.mjs, same round).
// Those suites now run through `fileEdgeMatchOnly` (tests/test-helpers.mjs),
// which calls the shipped MATCH clause — and only that clause; the rest of the
// injection query is guarded by the subprocess cases in
// tests/pre-tool-recall.test.mjs. Do not reintroduce an in-process twin here.

/**
 * Phase-2 task-imperative ranking (spec 2026-06-29 §4.1): score every candidate lesson
 * relevant to THIS prompt (importance>=2 + non-empty lesson + identifier overlap with the
 * prompt), sorted best-first — deliberately independent of searchRelevantMemories' coverage/
 * BM25 filters so a high-value lesson is not dropped by the context-list scoring.
 * `epochTo` (optional) restricts the pool to observations created at/before that epoch —
 * for offline point-in-time replay (benchmark use); a no-op at every production call site,
 * which never passes it.
 * @returns {Array<{id:number, lesson_learned:string, importance:number, overlap:number, score:number}>}
 */
export function rankImperativeCandidates(db, userPrompt, project, excludeIds = [], { epochTo = null } = {}) {
  if (!db || !userPrompt) return [];
  const promptIdents = new Set(extractIdents(userPrompt));
  if (promptIdents.size === 0) return []; // no symbol anchor → no imperative (precision-first)
  const exclude = new Set(excludeIds);
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, title, lesson_learned, importance
      FROM observations
      WHERE project = ?
        AND ${liveObsFilterSql('')}
        AND COALESCE(importance, 1) >= 2
        AND lesson_learned IS NOT NULL
        AND TRIM(lesson_learned) != ''
        AND LOWER(TRIM(lesson_learned)) != 'none'
        AND (? IS NULL OR created_at_epoch <= ?)
      ORDER BY importance DESC, created_at_epoch DESC
      LIMIT 50
    `).all(project, epochTo, epochTo);
  } catch { return []; }
  const out = [];
  for (const r of rows) {
    if (exclude.has(r.id)) continue;
    const overlap = extractIdents(`${r.lesson_learned} ${r.title || ''}`).filter((id) => promptIdents.has(id)).length;
    if (overlap === 0) continue;
    const score = (r.importance || 2) * overlap;
    out.push({ id: r.id, lesson_learned: r.lesson_learned, importance: r.importance || 2, overlap, score });
  }
  // Array.prototype.sort is spec-guaranteed stable (ES2019+) — ties keep the pool's
  // ORDER BY importance DESC, created_at_epoch DESC relative order, matching the old
  // loop's strict `score > bestScore` (first-max-wins) tie-break exactly.
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Phase-2 task-imperative selection: the single highest-value lesson relevant to THIS
 * prompt — top-1 of rankImperativeCandidates, mapped to the pre-existing return shape.
 * @returns {{id:number, lesson_learned:string}|null}
 */
export function selectImperativeLesson(db, userPrompt, project, excludeIds = []) {
  const top = rankImperativeCandidates(db, userPrompt, project, excludeIds)[0];
  return top ? { id: top.id, lesson_learned: top.lesson_learned } : null;
}

// P0 (2026-07-03): compose the subagent-dispatch injection. Given a PreToolUse
// Agent/Task tool_input, pick ONE project-scoped high-value lesson whose identifiers
// overlap the SUBAGENT's task prompt (precision-first via selectImperativeLesson:
// no overlap -> null -> no injection) and return a NEW tool_input with the
// safe-framed context appended to `prompt`. Returns null when there is nothing to
// inject. Pure over (db, toolInput, project) so it unit-tests without the subprocess.
export function buildSubagentInjection(db, toolInput, project) {
  if (!db || !toolInput || typeof toolInput.prompt !== 'string' || !toolInput.prompt.trim()) return null;
  const pick = selectImperativeLesson(db, toolInput.prompt, project);
  if (!pick || !pick.lesson_learned) return null;
  const block = formatSubagentContext(pick.lesson_learned, pick.id);
  if (!block) return null;
  return { ...toolInput, prompt: `${toolInput.prompt}\n${block}` };
}
