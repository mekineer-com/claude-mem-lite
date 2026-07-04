// claude-mem-lite shared utilities
// Used by server.mjs, hook.mjs, and tests


import { basename, dirname, resolve, sep } from 'path';
import { execSync } from 'child_process';
import { buildLowSignalRegex } from './lib/low-signal-patterns.mjs';

// ─── Re-exports from extracted modules ──────────────────────────────────────
// Backward compatibility: all consumers import from utils.mjs

export { DECAY_HALF_LIFE_BY_TYPE, DEFAULT_DECAY_HALF_LIFE_MS, OBS_BM25, SESS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE, OBS_FTS_COLUMNS, notLowSignalTitleClause, noisePenaltyClause } from './scoring-sql.mjs';
export { cjkBigrams, extractCjkSynonymTokens, extractCjkKeywords, extractCjkLikePatterns, SYNONYM_MAP, expandToken, sanitizeFtsQuery, relaxFtsQueryToOr, FTS_STOP_WORDS, CJK_COMPOUNDS } from './nlp.mjs';
export { resolveProject, _resetProjectCache } from './project-utils.mjs';
export { scrubSecrets, SECRET_PATTERNS } from './secret-scrub.mjs';
export { stripPrivate } from './lib/private-strip.mjs';
export { truncate, typeIcon, fmtDate, fmtTime, isoWeekKey, formatErrorRecallHints, neutralizeContextDelimiters } from './format-utils.mjs';
export { computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity } from './hash-utils.mjs';
export { detectBashSignificance, extractErrorKeywords, extractFilePaths, stripTestSuffix } from './bash-utils.mjs';

// Internal imports for functions that remain in this module
import { truncate } from './format-utils.mjs';
import { stripTestSuffix } from './bash-utils.mjs';

// ─── Sentinel Values ────────────────────────────────────────────────────────

/** compressed_into sentinel: auto-compressed without merge target */
export const COMPRESSED_AUTO = -1;
/** compressed_into sentinel: pending user-confirmed purge (marked by idle cleanup) */
export const COMPRESSED_PENDING_PURGE = -2;

// ─── Path Safety ──────────────────────────────────────────────────────────

/**
 * Check if a resolved path is confined within an allowed base directory.
 * Prevents path traversal attacks via '../' sequences.
 * @param {string} candidate Path to check
 * @param {string} allowedBase Base directory the path must stay within
 * @returns {boolean} true if safe
 */
export function isPathConfined(candidate, allowedBase) {
  const resolved = resolve(candidate);
  const base = resolve(allowedBase);
  return resolved === base || resolved.startsWith(base + sep);
}

// ─── Token Estimation ─────────────────────────────────────────────────────

/**
 * Estimate token count for a string.
 * Uses ~4 chars/token for ASCII, ~1.5 chars/token for CJK characters.
 * @param {string} text Input text
 * @returns {number} Estimated token count (minimum 1)
 */
export function estimateTokens(text) {
  const s = text || '';
  if (!s) return 1;
  // Count CJK characters (each ~1 token) vs ASCII (~4 chars/token)
  let cjkCount = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
        (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) ||
        (c >= 0xac00 && c <= 0xd7af)) {
      cjkCount++;
    }
  }
  const asciiLen = s.length - cjkCount;
  return Math.max(1, Math.ceil(asciiLen / 4) + Math.ceil(cjkCount / 1.5));
}

// ─── Importance ──────────────────────────────────────────────────────────────

/**
 * Clamp an importance value to the valid range [1, 3].
 * @param {*} val Raw importance value (may be non-numeric)
 * @returns {number} Clamped integer importance (1, 2, or 3)
 */
export function clampImportance(val) {
  // Coerce numeric strings: an LLM emitting "importance":"2" (quoted) would otherwise
  // collapse to 1, silently dropping its signal. Non-numeric strings → NaN → 1.
  const n = typeof val === 'number' ? val : (typeof val === 'string' ? Number(val) : NaN);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, Math.round(n)));
}

/**
 * Compute deterministic importance from episode entries using rule-based heuristics.
 * Checks file patterns (env, migrations, config) and bash significance signals.
 * @param {object} episode Episode with entries array
 * @returns {number} Rule-based importance (1, 2, or 3)
 */
// Tools that produce file edits (used for significance detection, feedback, importance)
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Low-signal degraded title patterns — shared by hook-llm.mjs (dedup + importance cap) and hook-handoff.mjs (decision filter)
// Two top-level alternatives:
//   1. ^(prefix1|prefix2|...) — title starts with one of the hook-llm fallback prefixes
//   2. \(error\)$              — title ends with '(error)' (Bug #2 fix: previously this was
//      inside the prefix group with a meaningless $, so only the exact title '(error)' matched.
//      Tool-fragment titles like 'gh release list ... (error)' leaked through.)
//
// β refactor (#7877 applied): derived from lib/low-signal-patterns.mjs so the
// regex path (this) and the SQL NOT LIKE path (scoring-sql.mjs::notLowSignalTitleClause)
// and pre-tool-recall.js inline SQL all share one authoritative pattern list.
// Previously these were hand-mirrored via "keep in sync" comments.
export const LOW_SIGNAL_TITLE = buildLowSignalRegex();

export function computeRuleImportance(episode) {
  let importance = 1;
  const toolTypes = new Set();
  let hasErrorThenEdit = false;
  let lastWasError = false;

  for (const entry of episode.entries) {
    const sig = entry.bashSig;
    const files = entry.files || [];
    toolTypes.add(entry.tool);

    // Track error→edit debug cycle pattern
    if (lastWasError && EDIT_TOOLS.has(entry.tool)) hasErrorThenEdit = true;
    lastWasError = entry.isError || sig?.isError;

    if (sig?.isError && (sig?.isTest || sig?.isBuild)) { importance = 3; break; }
    if (files.some(f => /\.(env|pem|key)$|\/auth\.|\/credential|\/password/i.test(f))) { importance = 3; break; }
    if (files.some(f => /migration|schema\.|prisma|alembic/i.test(f))) { importance = 3; break; }
    if (sig?.isError && importance < 2) importance = 2;
    if (sig?.isGit && importance < 2) importance = 2;
    if (sig?.isDeploy && importance < 2) importance = 2;
    if (files.some(f => /\.config\.|tsconfig|Dockerfile|docker-compose|package\.json|\.yml$|\.yaml$/i.test(basename(f))) && importance < 2) importance = 2;
  }

  // Debug cycle: error followed by edit = active debugging
  if (hasErrorThenEdit && importance < 2) importance = 2;
  // Broad change: many files touched (8+ indicates significant scope)
  if ((episode.files || []).length >= 8 && importance < 2) importance = 2;

  return importance;
}

// ─── Project Inference ───────────────────────────────────────────────────────

/**
 * Infer a sanitized project name from CLAUDE_PROJECT_DIR, PWD, or cwd.
 * Format: "parent--basename" with non-alphanumeric chars replaced by hyphens.
 * @returns {string} Sanitized project identifier safe for use in filenames
 */
export function inferProject() {
  const p = process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
  const base = basename(p);
  const parent = basename(dirname(p));
  const raw = parent && parent !== '.' && parent !== '/' ? `${parent}--${base}` : base;
  // Sanitize to prevent path traversal when used in filenames (ep-<project>.json)
  // Truncate to 100 chars to avoid exceeding filesystem name limits (255 bytes)
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
}

// ─── Episode Logic ───────────────────────────────────────────────────────────

/**
 * Check if new files are related to an existing episode's file set.
 * Considers exact match, directory overlap, and test-sibling relationships.
 * @param {object} episode Episode with files array
 * @param {string[]} newFiles Array of file paths to check
 * @returns {boolean} true if any file is related to the episode
 */
export function isRelatedToEpisode(episode, newFiles) {
  // No files (Bash, Grep without file context) → always related
  if (newFiles.length === 0) return true;
  if (episode.files.length === 0) return true;
  // Check file, directory, or test-sibling overlap
  for (const nf of newFiles) {
    for (const ef of episode.files) {
      if (nf === ef) return true;
      if (dirname(nf) === dirname(ef)) return true;
      // Test file ↔ source file (auth.ts ↔ auth.test.ts across directories)
      if (stripTestSuffix(nf) === stripTestSuffix(ef)) return true;
    }
  }
  return false;
}

// ─── Entry Description ──────────────────────────────────────────────────────

/**
 * Generate a human-readable description of a tool invocation for episode entries.
 * @param {string} toolName Name of the tool (Edit, Write, Bash, etc.)
 * @param {object} input Tool input parameters
 * @param {string} resp Tool response text
 * @param {object} [opts] Optional signals from detectBashSignificance
 * @param {boolean} [opts.isError] If provided, overrides inline error regex detection
 * @returns {string} Concise description of the action
 */
export function makeEntryDesc(toolName, input, resp, opts) {
  switch (toolName) {
    case 'Edit':
      return `${basename(input.file_path || '')}: "${truncate(input.old_string || '', 40)}" → "${truncate(input.new_string || '', 40)}"`;
    case 'Write':
      return `Created ${basename(input.file_path || '')} (${(input.content || '').length} chars)`;
    case 'NotebookEdit':
      return `Notebook cell: ${truncate(input.new_source || '', 60)}`;
    case 'Bash': {
      const cmd = truncate(input.command || '', 50);
      // Use caller-provided bashSig.isError (word-boundary aware) when available;
      // fall back to inline regex only for standalone callers (tests, etc.)
      const isErr = opts?.isError ?? (/\berror\b|\bfail(ed|ure)?\b|\bexception\b|\bpanic\b/i.test(resp) && resp.length > 30);
      const snippet = truncate(resp, 60);
      return isErr ? `${cmd} → ERROR: ${snippet}` : `${cmd} → ${snippet}`;
    }
    case 'Grep':
      return `Search "${truncate(input.pattern || '', 20)}" → ${truncate(resp, 60)}`;
    case 'LSP':
      return `${input.operation || ''} ${basename(input.filePath || '')}`;
    case 'Task': case 'Agent':
      return truncate(input.description || '', 60);
    case 'WebSearch':
      return `Web: ${truncate(input.query || '', 50)}`;
    case 'WebFetch':
      return `Fetch: ${truncate(input.url || '', 50)}`;
    default:
      return `${toolName}: ${truncate(resp, 50)}`;
  }
}

// ─── Structured Logging ──────────────────────────────────────────────────────

/**
 * Emit a structured log line gated by CLAUDE_MEM_DEBUG.
 * Format: [claude-mem-lite] [ISO timestamp] [LEVEL] context: message
 * @param {'DEBUG'|'WARN'|'ERROR'} level Log severity
 * @param {string} context Module or function name
 * @param {string} msg Human-readable message
 */
export function debugLog(level, context, msg) {
  if (!process.env.CLAUDE_MEM_DEBUG) return;
  const ts = new Date().toISOString();
  console.error(`[claude-mem-lite] [${ts}] [${level}] ${context}: ${msg}`);
}

/**
 * Log a caught error at ERROR level (includes stack trace when available).
 * Gated by CLAUDE_MEM_DEBUG for stderr output. Separately, if
 * `CLAUDE_MEM_CATCH_SAMPLE` (float 0..1) is set, a random fraction of caught
 * errors get appended to `$DB_DIR/errors/YYYY-MM-DD.jsonl` — observable
 * residue for otherwise-silent swallowed errors (see lib/err-sampler.mjs).
 * Use in catch blocks for non-fatal errors.
 * @param {Error|unknown} e The caught error
 * @param {string} context Module or function name for attribution
 */
export function debugCatch(e, context) {
  if (process.env.CLAUDE_MEM_DEBUG) {
    const ts = new Date().toISOString();
    console.error(`[claude-mem-lite] [${ts}] [ERROR] ${context}:`, e?.stack || e?.message || e);
  }
  // Sampled-to-disk surface for post-mortem. Lazy-loaded so fs-less paths
  // don't pay the module cost; wrapped in try so sampler faults never crash
  // the caller (debugCatch is the error-handler-of-last-resort path).
  if (process.env.CLAUDE_MEM_CATCH_SAMPLE) {
    (async () => {
      try {
        const [{ maybeSampleError }, { DB_DIR }] = await Promise.all([
          import('./lib/err-sampler.mjs'),
          import('./schema.mjs'),
        ]);
        maybeSampleError(e, context, DB_DIR);
      } catch { /* sampler dynamic-import fault must not propagate */ }
    })();
  }
}

// ─── JSON Parsing ────────────────────────────────────────────────────────────

/**
 * Extract the first brace-balanced JSON object substring from text, honoring strings
 * and escapes so braces inside string values don't throw off the depth count. Returns
 * null when there's no `{` or no balanced close. Used to recover a valid leading object
 * when the LLM wrapped it in prose that ALSO contains braces — the greedy `{[\s\S]*}`
 * fallback spans first-`{` to last-`}` and is defeated by an unrelated trailing `{…}`.
 */
function firstBalancedJsonObject(text) {
  // Anchor on whichever structural opener comes first — `{` (object) or `[` (array) —
  // so a prose-wrapped top-level array isn't truncated to its first inner object.
  const braceAt = text.indexOf('{');
  const brackAt = text.indexOf('[');
  let start, open, close;
  if (braceAt === -1 && brackAt === -1) return null;
  if (brackAt !== -1 && (braceAt === -1 || brackAt < braceAt)) { start = brackAt; open = '['; close = ']'; }
  else { start = braceAt; open = '{'; close = '}'; }
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Parse JSON from LLM output, handling markdown fences and embedded objects.
 * Tries: direct parse → fenced code block → first balanced object → greedy regex.
 * @param {string} text Raw LLM output text
 * @returns {object|null} Parsed JSON object or null on failure
 */
export function parseJsonFromLLM(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  // No `\s*` around the lazy capture: `\s*([\s\S]*?)\s*` catastrophically backtracks
  // (O(n²)) on a fence + long whitespace + no closing fence — a ~5KB partial buffer hung
  // the CLI-timeout salvage path for 10+s (round-5 review). `([\s\S]*?)```` is a single
  // O(n) lazy scan; JSON.parse tolerates the surrounding whitespace the trim used to strip.
  const fenced = text.match(/```(?:json)?([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  // First balanced object — survives unfenced output wrapped in brace-containing prose.
  const balanced = firstBalancedJsonObject(text);
  if (balanced) try { return JSON.parse(balanced); } catch {}
  // Last-resort greedy span (handles a payload that isn't the FIRST balanced object).
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) try { return JSON.parse(obj[0]); } catch {}
  return null;
}

// ─── Handoff Utilities ──────────────────────────────────────────────────────

/** Stop words for handoff keyword extraction (broader than ERROR_STOP_WORDS). */
export const HANDOFF_STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'been', 'have', 'has', 'had', 'does', 'did', 'will', 'would', 'should', 'could',
  'can', 'may', 'must', 'not', 'but', 'its', 'all', 'any', 'each', 'some',
  'into', 'over', 'after', 'before', 'between', 'about', 'also', 'just', 'then',
  'than', 'when', 'where', 'how', 'what', 'which', 'who', 'why', 'here', 'there',
  'more', 'very', 'only', 'still', 'now', 'new', 'old', 'get', 'got', 'set',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'const', 'let', 'var',
  'import', 'export', 'default', 'class', 'async', 'await', 'try', 'catch',
]);

/**
 * Tokenize text for handoff keyword matching.
 * Splits on whitespace/punctuation, lowercases, filters short tokens.
 * @param {string} text Input text
 * @returns {string[]} Array of lowercase tokens (length >= 3)
 */
export function tokenizeHandoff(text) {
  if (!text) return [];
  return text
    .split(/[\s,;:.()[\]{}'"`<>→|/\\#@!?=+*&^%$~]+/)
    .map(w => w.toLowerCase().replace(/^[.-]+|[.-]+$/g, ''))
    .filter(w => w.length >= 3);
}

/**
 * Check if a token is a "specific" term (file name, identifier, etc.)
 * that should get double weight in intent matching.
 * @param {string} token Lowercase token
 * @returns {boolean}
 */
export function isSpecificTerm(token) {
  if (!token || token.length < 3) return false;
  if (token.includes('_') || token.includes('-')) return true;
  if (HANDOFF_STOP_WORDS.has(token)) return false;
  return token.length >= 4 && !/^\d+$/.test(token);
}

/**
 * Detect prompts whose content is purely workflow/control language with no
 * subject substance — "继续", "提交代码", "/exit", "commit and push", etc.
 *
 * Rationale: `buildAndSaveHandoff` writes user-prompt text into `working_on`
 * verbatim. When a session's only prompt is a meta-trigger, the resumed
 * session sees `Working On: 继续前面的工作` — self-referential garbage. This
 * detector lets the writer filter such prompts before they pollute the field.
 *
 * Strategy: strip a curated set of trigger keywords (zh + en) plus
 * punctuation; if <4 chars of substantive content remain, the prompt is meta.
 * Threshold tuned against real `user_prompts` samples — keeps prompts like
 * "提交代码，发新版本，检查线上有没有错误" (real verification subject) while
 * dropping bare "/exit" / "继续" / "commit".
 *
 * @param {string} text Prompt text
 * @returns {boolean} true if the prompt is meta-trigger only
 */
export function isMetaTriggerPrompt(text) {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  const stripped = trimmed
    .replace(/继续(前面|之前|刚才|上次)?(的)?(工作|任务|话题|讨论)?/g, '')
    .replace(/提交(代码|了|完|过)?(并)?(发布)?/g, '')
    .replace(/退出/g, '')
    .replace(/发(布|新版本|个新版本)/g, '')
    .replace(/新开(了)?(一个)?(会话|session)?/g, '')
    .replace(/保存(进度|状态|工作|代码)?/g, '')
    .replace(/接着(干|做|来|继续)?/g, '')
    .replace(/上次(到哪了|说到哪了)?/g, '')
    .replace(/总结一下|复盘一下/g, '')
    .replace(/前面(的)?(工作|话题|讨论|内容)/g, '')
    .replace(/\/?(clear|exit)\b/gi, '')
    .replace(/\b(commit|continue|resume|push|save|restart|exit|next)\b/gi, '')
    .replace(/[，,。.!！?？:：;；()（）【】[\]\s/\\-]+/g, '')
    .trim();

  return stripped.length < 4;
}

/**
 * Extract match keywords from text and file paths for handoff intent matching.
 * @param {string} text Combined text from prompts, observations, etc.
 * @param {string[]} files Array of file paths
 * @returns {string} Space-separated keywords
 */
export function extractMatchKeywords(text, files) {
  const terms = new Set();
  for (const f of files) {
    const base = basename(f).replace(/\.[^.]+$/, '');
    if (base.length >= 3) terms.add(base.toLowerCase());
  }
  const words = tokenizeHandoff(text);
  for (const w of words) {
    if (!HANDOFF_STOP_WORDS.has(w)) terms.add(w);
  }
  return [...terms].join(' ');
}

// ─── Git Branch Detection ──────────────────────────────────────────────────

let _cachedBranch;
let _branchCacheTime = 0;
const BRANCH_CACHE_TTL = 60000; // 60s TTL for long-running MCP server process
export function getCurrentBranch() {
  const now = Date.now();
  if (_cachedBranch !== undefined && (now - _branchCacheTime) < BRANCH_CACHE_TTL) return _cachedBranch;
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    _cachedBranch = (result && result !== 'HEAD') ? result : null;
  } catch {
    _cachedBranch = null;
  }
  _branchCacheTime = now;
  return _cachedBranch;
}

/** Reset cached branch (for testing or after git checkout) */
export function _resetBranchCache() { _cachedBranch = undefined; _branchCacheTime = 0; }
