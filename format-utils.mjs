// claude-mem-lite: String formatting and display utilities
// Extracted from utils.mjs for focused responsibility

/**
 * Truncate a string to a maximum length, replacing newlines with spaces.
 * @param {string} str Input string
 * @param {number} [max=80] Maximum character length
 * @returns {string} Truncated string with ellipsis if needed
 */
export function truncate(str, max = 80) {
  if (!str) return '';
  // Defense-in-depth: a non-string (e.g. an LLM that returned title as an array/number)
  // would throw `str.replace is not a function` and abort the caller. Coerce to '' rather
  // than crash; the real type-guarding happens at the call site.
  if (typeof str !== 'string') return '';
  str = str.replace(/\n/g, ' ').trim();
  if (str.length <= max) return str;
  // Never split a UTF-16 surrogate pair: slicing between the high and low half emits a
  // lone surrogate (invalid UTF-16) that then gets persisted to the DB. If the last kept
  // code unit is a high surrogate, drop it so we cut on a code-point boundary.
  let end = max - 1;
  const last = str.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end--;
  return str.slice(0, end) + '\u2026';
}

/**
 * Render the PostToolUse error-recall hint block (hook.mjs::triggerErrorRecall).
 * The single most-relevant hit (rows[0]) that carries a lesson_learned gets its
 * lesson INLINED, so the agent can act with zero follow-up round-trips: the old
 * "pointer + mem_get for details" form cost a deferred mem_get (2 model turns in
 * tool-heavy sessions, where mem_* is gated behind ToolSearch) at the exact
 * moment a fix is needed. Later rows stay as #ID pointers to keep the injected
 * payload bounded (one body, not three). Upstream noise gating (low-signal title
 * exclusion) is the SELECT's job (see triggerErrorRecall).
 * @param {Array<{id:number,type:string,title:string,lesson_learned?:string}>} rows
 * @returns {string} stdout block (trailing newline) or '' when there are no rows
 */
export function formatErrorRecallHints(rows) {
  if (!rows || rows.length === 0) return '';
  const lines = rows.map((r, i) => {
    const head = `  #${r.id} [${r.type}] ${truncate(r.title, 60)}`;
    // Inline the lesson body for the single most-relevant hit only (bounded payload).
    if (i === 0 && typeof r.lesson_learned === 'string' && r.lesson_learned.trim()) {
      return `${head} \u2014 ${truncate(r.lesson_learned.trim(), 200)}`;
    }
    return head;
  });
  const ids = rows.map(r => r.id).join(',');
  return `[claude-mem-lite] Related memories found for this error:\n${lines.join('\n')}\n  \u2192 Use mem_get(ids=[${ids}]) for details.\n`;
}

/**
 * Map observation type to its display emoji icon.
 * @param {string} type Observation type (decision, bugfix, feature, etc.)
 * @returns {string} Emoji icon for the type
 */
export function typeIcon(type) {
  const icons = { decision: '\uD83D\uDFE1', bugfix: '\uD83D\uDD34', feature: '\uD83D\uDFE2', refactor: '\uD83D\uDD35', discovery: '\uD83D\uDD0D', change: '\uD83D\uDCDD' };
  return icons[type] || '\u26AA';
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Format an ISO date string as "Mon DD HH:MM" for compact display.
 * @param {string} iso ISO 8601 date string
 * @returns {string} Formatted date or empty string
 */
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mon = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${h}:${m}`;
}

/**
 * Format an ISO date string as "HH:MM" for time-only display.
 * @param {string} iso ISO 8601 date string
 * @returns {string} Formatted time or empty string
 */
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  // Guard against an unparseable timestamp (e.g. corrupt/imported created_at):
  // a bare new Date('garbage') yields Invalid Date → getUTCHours() is NaN →
  // "NaN:NaN" leaking into the SessionStart Recent table. Degrade to '' like the
  // falsy-input case above.
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ─── ISO Week ────────────────────────────────────────────────────────────────

/**
 * Convert an epoch timestamp to an ISO week key string (e.g. "2026-W06").
 * @param {number} epochMs Epoch timestamp in milliseconds
 * @returns {string} ISO week key in format "YYYY-Wnn"
 */
export function isoWeekKey(epochMs) {
  const d = new Date(epochMs);
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  const isoYear = tmp.getUTCFullYear();
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}
