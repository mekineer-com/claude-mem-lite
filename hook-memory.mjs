// claude-mem-lite — Semantic Memory Injection
// Search past observations for relevant memories to inject as context at user-prompt time.

import { sanitizeFtsQuery, relaxFtsQueryToOr, debugCatch, truncate, OBS_BM25, notLowSignalTitleClause, noisePenaltyClause, tokenizeHandoff, HANDOFF_STOP_WORDS, extractCjkKeywords } from './utils.mjs';
import { citeFactorJs } from './scoring-sql.mjs';
import { recordMetric } from './lib/metrics.mjs';
import { DB_DIR } from './schema.mjs';

const MAX_MEMORY_INJECTIONS = 3;
const MEMORY_LOOKBACK_MS = 60 * 86400000; // 60 days
// Aligned with TYPE_QUALITY_CASE in scoring-sql.mjs (R2 rebalance).
// Weights calibrated to empirical avg access_count:
//   decision 6.05, discovery 3.32, bugfix 2.24, feature 2.04, change 0.93, refactor 0.54.
// lesson_learned boost (1.5×) stacks for entries with a real takeaway.
const MEMORY_TYPE_BOOST = { decision: 1.5, discovery: 1.3, bugfix: 1.1, feature: 1.0, refactor: 0.6, change: 0.5 };
// Adaptive BM25 thresholds — scale with corpus size to filter noise.
// Larger corpora produce more weak matches from common words.
const BM25_THRESHOLD = { TINY: 0, SMALL: 1.5, MEDIUM: 2.5, LARGE: 3.5 };
// OR fallback max token count — queries with 3+ tokens that fail AND are likely off-topic
const OR_FALLBACK_MAX_TOKENS = 2;

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

const FILE_RECALL_LOOKBACK_MS = 60 * 86400000; // 60 days
const MAX_FILE_RECALL = 2;

// P1: stale-obs verify-before-use threshold. An injected obs older than this
// AND carrying file paths is flagged so Claude is reminded to grep/Read the
// referenced code before applying the lesson — code may have moved or been
// renamed since capture. Pure-decision/architecture obs (no file_paths)
// don't get the hint: their drift is text-only and Claude already verifies
// at consumption time per the project mem-usage contract.
const STALE_OBS_THRESHOLD_MS = 30 * 86400000;

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
  const lessonTag = obs.lesson_learned ? ` | Lesson: ${obs.lesson_learned}` : '';
  let staleHint = '';
  if (typeof obs.created_at_epoch === 'number'
    && Date.now() - obs.created_at_epoch > STALE_OBS_THRESHOLD_MS
    && hasFilePaths(obs.files_modified)) {
    staleHint = ' [verify-before-use]';
  }
  return `- [${obs.type}] ${truncate(obs.title, 80)}${lessonTag} (#${obs.id})${staleHint}`;
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
    const ftsQuery = sanitizeFtsQuery(userPrompt);
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
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
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
      : ftsQuery.split(/\s+/).filter(t => t && !t.startsWith('(') || !t.endsWith(')')).length;
    // CJK-dominant queries bypass the token-count gate: a single CJK word becomes
    // 2-N overlapping bigrams (优化召回率 → 优化/召回/回率), inflating
    // queryTokenCount past the gate, so the AND-too-strict query never gets the OR
    // rescue that CJK retrieval relies on. The CLI/hybrid path relaxes CJK to OR
    // unconditionally; mirror that here. Noise is contained downstream (0.4x OR
    // penalty + BM25 threshold + term-coverage filter). queryIsCjkDominant (not
    // mere CJK presence) is the gate — see its definition at the function top.
    if (rows.length === 0) {
      const orQuery = relaxFtsQueryToOr(ftsQuery);
      if (orQuery && (queryIsCjkDominant || queryTokenCount <= OR_FALLBACK_MAX_TOKENS)) {
        try { rows = selectStmt.all(orQuery, project, cutoff); usedOrFallback = true; } catch {}
      }
    }

    // Phase 2: Cross-project search for high-value decisions/discoveries
    // These are transferable insights (debugging patterns, architectural reasons, gotchas)
    let crossRows = [];
    let crossUsedOr = false;
    try {
      const crossStmt = db.prepare(`
        SELECT o.id, o.type, o.title, o.subtitle, o.narrative, o.importance, o.lesson_learned, o.project,
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
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND ${notLowSignalTitleClause('o')}
        ORDER BY ${OBS_BM25}
        LIMIT 5
      `);
      crossRows = crossStmt.all(ftsQuery, project, cutoff);
      if (crossRows.length === 0) {
        const orQuery = relaxFtsQueryToOr(ftsQuery);
        if (orQuery && (queryIsCjkDominant || queryTokenCount <= OR_FALLBACK_MAX_TOKENS)) {
          try { crossRows = crossStmt.all(orQuery, project, cutoff); crossUsedOr = true; } catch {}
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
            * (MEMORY_TYPE_BOOST[r.type] || 1.0)
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
      'SELECT COUNT(*) as c FROM observations WHERE project = ? AND COALESCE(compressed_into, 0) = 0',
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
    // penalty clause now depends on. access_count is reserved for explicit
    // access (cmdRecall/cmdGet/cmdTimeline/pre-tool-recall/citation-tracker).
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

/**
 * Recall observations related to a specific file being edited.
 * Useful for surfacing past bugfixes / decisions when revisiting a file.
 * @param {import('better-sqlite3').Database} db Memory database
 * @param {string} filePath File path (absolute or relative)
 * @param {string} project Current project
 * @returns {object[]} Up to MAX_FILE_RECALL observations with {id, type, title, importance, lesson_learned}
 */
export function recallForFile(db, filePath, project) {
  if (!db || !filePath) return [];
  try {
    const basename = filePath.split('/').pop();
    const cutoff = Date.now() - FILE_RECALL_LOOKBACK_MS;
    // Escape SQL LIKE wildcards in filename to prevent injection
    const escaped = basename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.importance, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 2
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(project, cutoff, filePath, likePattern, MAX_FILE_RECALL);
    const now = Date.now();
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?');
    for (const r of rows) updateStmt.run(now, r.id);
    return rows;
  } catch (e) {
    debugCatch(e, 'recallForFile');
    return [];
  }
}
