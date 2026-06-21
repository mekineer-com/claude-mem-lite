// lib/lesson-idents.mjs — pure, zero-dependency extractor of code identifiers a
// lesson names, for the bind-salience PostToolUse "dropped a required reference"
// check (scripts/post-tool-recall.js). Imported by hot standalone hooks → NO
// heavy imports (lesson #8447): regex over a string only.
//
// Identifier shapes: backtick-quoted, camelCase, snake_case, length >= MIN_LEN.
// These name functions/columns a lesson tells you to keep (recoverChildrenOf,
// compressed_into). Plain prose ("recover", "delete") is intentionally excluded.

const MIN_LEN = 5;
const BACKTICK = /`([A-Za-z_][A-Za-z0-9_]*)`/g;
const CAMEL = /\b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g;
const SNAKE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

export function extractIdents(text) {
  const s = text || '';
  if (!s) return [];
  const out = new Set();
  for (const re of [BACKTICK, CAMEL, SNAKE]) {
    for (const m of s.matchAll(re)) if (m[1].length >= MIN_LEN) out.add(m[1]);
  }
  return [...out];
}

// Of the identifiers a lesson names, keep only those literally present in the
// pre-edit file — so the PostToolUse check flags "you removed X" and never
// "you didn't add X that was never here" (the false positive). '' content → [].
export function presentIdents(lessonText, content) {
  const c = content || '';
  if (!c) return [];
  return extractIdents(lessonText).filter((id) => c.includes(id));
}
