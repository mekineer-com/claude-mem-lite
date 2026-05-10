// claude-mem-lite: per-table scrub helper. Applies scrubSecrets to the known
// text fields of a table row. Numeric / JSON-blob / id fields are passed
// through untouched. Failing closed (unknown table -> scrub everything that
// is a string) keeps new tables safe by default.

import { scrubSecrets } from '../secret-scrub.mjs';

export const TEXT_FIELDS_BY_TABLE = {
  observations: [
    'title', 'subtitle', 'text', 'narrative',
    'concepts', 'facts', 'lesson_learned', 'search_aliases',
  ],
  session_summaries: [
    'request', 'investigated', 'learned',
    'completed', 'next_steps', 'remaining_items', 'notes',
    'lessons', 'key_decisions',
  ],
  session_handoffs: [
    'working_on', 'completed', 'unfinished',
    'key_files', 'key_decisions', 'match_keywords',
  ],
  user_prompts: ['prompt_text'],
};

/**
 * Scrub the text fields of a record before INSERT.
 * Returns a shallow copy with string text-fields scrubbed; the input object
 * is left untouched. Non-string values (numbers, null, JSON blobs the caller
 * has already stringified) flow through unchanged.
 */
export function scrubRecord(table, row) {
  if (!row || typeof row !== 'object') return row;
  const fields = TEXT_FIELDS_BY_TABLE[table];
  const out = { ...row };
  if (fields) {
    for (const f of fields) {
      if (typeof out[f] === 'string') out[f] = scrubSecrets(out[f]);
    }
  } else {
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string') out[k] = scrubSecrets(out[k]);
    }
  }
  return out;
}
