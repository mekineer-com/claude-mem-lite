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
