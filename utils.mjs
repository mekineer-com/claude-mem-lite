// claude-mem-lite shared utilities
// Used by server.mjs, hook.mjs, and tests


import { basename, dirname, resolve, sep } from 'path';
import { execSync } from 'child_process';

// ─── Re-exports from extracted modules ──────────────────────────────────────
// Backward compatibility: all consumers import from utils.mjs

export { DECAY_HALF_LIFE_BY_TYPE, DEFAULT_DECAY_HALF_LIFE_MS, OBS_BM25, SESS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE, OBS_FTS_COLUMNS, notLowSignalTitleClause } from './scoring-sql.mjs';
export { cjkBigrams, extractCjkSynonymTokens, extractCjkKeywords, extractCjkLikePatterns, SYNONYM_MAP, expandToken, sanitizeFtsQuery, relaxFtsQueryToOr, FTS_STOP_WORDS, CJK_COMPOUNDS } from './nlp.mjs';
export { resolveProject, _resetProjectCache } from './project-utils.mjs';
export { scrubSecrets, SECRET_PATTERNS } from './secret-scrub.mjs';
export { truncate, typeIcon, fmtDate, fmtTime, isoWeekKey } from './format-utils.mjs';
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
  if (typeof val !== 'number' || isNaN(val)) return 1;
  return Math.max(1, Math.min(3, Math.round(val)));
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
// Keep in sync with notLowSignalTitleClause() in scoring-sql.mjs.
export const LOW_SIGNAL_TITLE = /^(Error (while working|in)|Error: |Modified |Worked on |Reviewed \d+ files:|# |node |npm |npx |\(no description\))|\(error\)$/;

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
 * Gated by CLAUDE_MEM_DEBUG. Use in catch blocks for non-fatal errors.
 * @param {Error|unknown} e The caught error
 * @param {string} context Module or function name for attribution
 */
export function debugCatch(e, context) {
  if (process.env.CLAUDE_MEM_DEBUG) {
    const ts = new Date().toISOString();
    console.error(`[claude-mem-lite] [${ts}] [ERROR] ${context}:`, e?.stack || e?.message || e);
  }
}

// ─── JSON Parsing ────────────────────────────────────────────────────────────

/**
 * Parse JSON from LLM output, handling markdown fences and embedded objects.
 * Tries: direct parse → fenced code block → regex object extraction.
 * @param {string} text Raw LLM output text
 * @returns {object|null} Parsed JSON object or null on failure
 */
export function parseJsonFromLLM(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
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
