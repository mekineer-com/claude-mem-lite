// claude-mem-lite: Strip <private>...</private> blocks from user-supplied text
// before any persistence or downstream processing.
//
// Use case: user wraps sensitive content (test fixtures, internal IDs, draft
// secrets that scrubSecrets misses) in <private>X</private> to opt out of
// memory capture. Replaces each well-formed pair with [redacted] to preserve
// surrounding grammar and FTS bigram boundaries.
//
// Mirrors thedotmack/claude-mem v13's <private> primitive (referenced in
// observation #8252 follow-up scope) — same syntax for cross-tool familiarity.
//
// Intentionally does NOT strip:
//   - Open-without-close (`<private>...` with no `</private>`): user may still
//     be typing; aggressive strip-to-EOL would surprise. Caller can chain a
//     length cap (`promptText.slice(0, 10000)`) after this for safety.
//   - Stray `</private>` with no opener: same reasoning, leave intact.
// Both gaps are documented for callers to layer additional guards if needed.
//
// Case-insensitive on the tag (`<PRIVATE>`, `<Private>` all work) since users
// type by hand. Non-greedy match handles multiple blocks correctly.

const PRIVATE_BLOCK_RE = /<private>([\s\S]*?)<\/private>/gi;
const REDACTION_MARKER = '[redacted]';

/**
 * Replace each well-formed <private>...</private> block with [redacted].
 * Returns input unchanged if no closed block is present.
 *
 * @param {unknown} text Input string (non-string passes through)
 * @returns {string|unknown} Stripped text, or input unchanged if not a string
 */
export function stripPrivate(text) {
  if (typeof text !== 'string') return text;
  if (!text.includes('<')) return text; // fast path — most prompts have no tags
  return text.replace(PRIVATE_BLOCK_RE, REDACTION_MARKER);
}
