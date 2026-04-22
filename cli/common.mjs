// cli/common.mjs — shared helpers used by every per-command file under cli/.
// Extracted from mem-cli.mjs (v2.41) as first step in the god-module split.
//
// Scope: pure utilities only. No DB, no imports from other cli/ files. This
// module is the single source of truth for stdout/stderr framing, arg parsing,
// ID-token parsing, and relative-time formatting — every command imports from
// here so the CLI stays consistent.

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

// ─── ID Token Parsing ────────────────────────────────────────────────────────

/**
 * Parse an ID token from a command positional argument.
 * Accepts: `123`, `#123`, `P#123` / `p123` (prompt), `S#123` / `s123` (session).
 * @returns {{ source: 'obs'|'session'|'prompt'|null, id: number } | null}
 *   source===null means no explicit prefix — caller picks default (typically 'obs').
 */
export function parseIdToken(raw) {
  const m = /^([PpSs]?)#?(\d+)$/.exec(String(raw).trim());
  if (!m) return null;
  const p = m[1].toUpperCase();
  const id = parseInt(m[2], 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const source = p === 'P' ? 'prompt' : p === 'S' ? 'session' : null;
  return { source, id };
}

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
