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
      const key = arg.slice(2);
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
  return hints;
}
