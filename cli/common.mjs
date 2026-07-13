// cli/common.mjs — shared helpers used by every per-command file under cli/.
// Extracted from mem-cli.mjs (v2.41) as first step in the god-module split.
//
// Scope: pure utilities only. No DB, no imports from other cli/ files; only
// `lib/` leaf utilities may be re-exported through here (currently:
// parseIdToken). This module is the single source of truth for stdout/stderr
// framing, arg parsing, ID-token parsing, and relative-time formatting —
// every command imports from here so the CLI stays consistent.

// ─── Argument Parsing ────────────────────────────────────────────────────────

/**
 * Parse argv-style array into { positional, flags }.
 * `--key value` → flags.key = value; `--flag` (no value) → flags.key = true.
 * `-h` → flags.help = true.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      // `--key=value` (GNU long-option form). Split on the FIRST '=' so values that
      // themselves contain '=' (e.g. `--from=2026-01-01`, a token with '=') stay intact.
      // Without this, `--type=feature` parsed as a boolean flag literally named
      // "type=feature"; the real `--type` stayed undefined and the default silently
      // applied — a save landed in the wrong project / type with no error.
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        i++;
        continue;
      }
      const key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && (!next.startsWith('-') || /^-\d/.test(next))) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg === '-h') {
      flags.help = true;
      i++;
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

/** Write a line to stdout. */
export function out(text) {
  process.stdout.write(text + '\n');
}

/** Write a line to stderr and mark process for non-zero exit. */
export function fail(text) {
  process.stderr.write(text + '\n');
  process.exitCode = 1;
}

/**
 * Reject value-less `--flag` for string-valued flags. A bare trailing flag (or one
 * immediately followed by another `--flag`) parses to boolean `true` (parseArgs above);
 * that `true` then slips into code expecting a string and surfaces a raw
 * `flags.x.split is not a function` / `SQLite3 can only bind ...` stacktrace (#8470).
 * Returns true (and emits a clean `fail()`) when any listed key is a bare flag — the
 * caller should `return` on true. Single source of the guard the update/registry paths
 * previously inlined, so new string-flag commands stay consistent.
 *
 * @param {object} flags Parsed flags from parseArgs.
 * @param {string[]} keys String-valued flag names to guard (without leading dashes).
 * @returns {boolean} true if a bare flag was found and rejected.
 */
export function rejectBareStringFlags(flags, keys) {
  for (const key of keys) {
    if (flags[key] === true) {
      fail(`[mem] --${key} requires a value (received a bare flag with no value).`);
      return true;
    }
  }
  return false;
}

// ─── Unknown-flag typo guard ─────────────────────────────────────────────────

/**
 * Union of every flag name any CLI command reads (parseArgs silently drops the rest).
 * Over-inclusive BY DESIGN: a flag listed here that a given command ignores just means
 * "no typo warning for it" — harmless. The only real risk is OMITTING a valid flag, and
 * the edit-distance gate in suggestUnknownFlags() makes even that non-fatal (a distinct
 * real flag rarely lands within distance 2 of another). Add new flags here when adding
 * them to a command — same maintenance contract as JSON_SUPPORTED_CMDS in mem-cli.
 */
export const KNOWN_CLI_FLAGS = new Set([
  'after', 'age-days', 'all', 'anchor', 'batch', 'before', 'benchmark', 'body', 'branch',
  'capability-summary', 'category', 'closes-deferred', 'concepts', 'confirm', 'days', 'deep',
  'detail', 'domain-tags', 'dry-run', 'enrich', 'execute', 'fields', 'file', 'files', 'floors',
  'force', 'format', 'from', 'has', 'help', 'importance', 'include-compressed', 'include-noise',
  'intent-tags', 'invocation-name', 'json', 'key', 'keywords', 'lesson', 'lesson-learned', 'limit',
  'local-path', 'margins', 'max', 'memdir', 'merge-ids', 'metrics', 'name', 'narrative', 'no-deep',
  'offset', 'ops', 'or', 'out', 'priority', 'project', 'quality', 'query', 'reason', 'repo-url',
  'rerank', 'resource-type', 'retain-days', 'retry', 'run', 'run-all', 'scope', 'session-audit',
  'sidechain', 'since', 'sort', 'source', 'status', 'sweep', 'task', 'tech-stack', 'tier', 'title',
  'to', 'trigger-patterns', 'type', 'use-cases', 'verbose',
]);

/** Levenshtein distance, early-exit past `max` (cheap enough for a handful of flags). */
function editDistance(a, b, max = 2) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1; // whole row already past budget → give up
    prev = cur;
  }
  return prev[n];
}

/**
 * Detect likely-typo flags: names NOT in KNOWN_CLI_FLAGS but within edit distance 2 of
 * a known flag. parseArgs silently drops unknown flags, so `save --improtance 3` used to
 * persist the DEFAULT importance and `recent --projcte X` silently queried the inferred
 * project — a typo produced a wrong result with zero signal. Returns [{flag, suggestion}].
 * Unknown flags with NO close match are omitted: they may be a valid flag we didn't
 * catalog, so silence beats a false alarm. Warning-only by contract — never fails.
 * @param {object} flags Parsed flags from parseArgs.
 * @returns {Array<{flag: string, suggestion: string}>}
 */
export function suggestUnknownFlags(flags) {
  const result = [];
  for (const key of Object.keys(flags)) {
    if (!key || KNOWN_CLI_FLAGS.has(key)) continue;
    let best = null, bestDist = 3;
    for (const known of KNOWN_CLI_FLAGS) {
      const d = editDistance(key, known);
      if (d < bestDist) { bestDist = d; best = known; }
    }
    if (best && bestDist <= 2) result.push({ flag: key, suggestion: best });
  }
  return result;
}

// ─── Time Formatting ─────────────────────────────────────────────────────────

/** "just now" / "5m ago" / "3h ago" / "2d ago" relative to now. */
export function relativeTime(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** ISO date string → "YYYY-MM-DD" prefix. */
export function fmtDateShort(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

// Integer epoch-ms time fields on the observations table that `get`/`mem_get`
// render. Shared by the CLI (mem-cli.mjs) and the MCP server (server.mjs) so the
// two `get` paths can't drift — pre-2.97 the MCP path printed bare ms
// (`last_accessed_at: 1781024049720`) while the CLI showed `<ms> (<relative>)`,
// because the formatter lived only in mem-cli.mjs.
export const OBS_TIME_FIELDS = ['superseded_at', 'last_accessed_at'];

// Pure formatter — null/undefined/non-time pass through; integer time fields
// render as `<raw> (<relative>)` so callers get both an audit value and a
// human/LLM-scannable hint, mirroring `recent`/`timeline`/`recall`.
export function formatObsFieldValue(field, val) {
  if (val === null || val === undefined) return val;
  if (OBS_TIME_FIELDS.includes(field) && typeof val === 'number') {
    return `${val} (${relativeTime(val)})`;
  }
  return val;
}

// ─── ID Token Parsing ────────────────────────────────────────────────────────
// Re-exported from lib/id-routing.mjs so CLI and MCP (server.mjs) share a single
// parser — parity per #8050. Keep this re-export for back-compat with the
// 5 CLI call sites that already import parseIdToken from cli/common.mjs.
export { parseIdToken } from '../lib/id-routing.mjs';

/**
 * Format the shared `probeIdSources` output as CLI hint strings.
 * Example: ["#5419 (obs)", "P#5417 (prompt)"] — callers join with "; ".
 */
export function formatProbeHints(probe) {
  const hints = [];
  if (probe.obs.length > 0)     hints.push(`#${probe.obs.join(', #')} (obs)`);
  if (probe.session.length > 0) hints.push(`S#${probe.session.join(', S#')} (session)`);
  if (probe.prompt.length > 0)  hints.push(`P#${probe.prompt.join(', P#')} (prompt)`);
  if (probe.event?.length > 0)  hints.push(`E#${probe.event.join(', E#')} (event)`);
  return hints;
}
