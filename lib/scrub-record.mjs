// claude-mem-lite: per-table scrub helper. Applies scrubSecrets to the known
// text fields of a table row. Numeric / JSON-blob / id fields are passed
// through untouched.
//
// Failsafe policy: when the table is unknown, scrub every string field by
// default. Newly added tables stay safe even before TEXT_FIELDS_BY_TABLE is
// updated — over-scrubbing is the safe direction; under-scrubbing leaks.
//
// JSON-stringified array fields (e.g. session_handoffs.key_files,
// session_handoffs.match_keywords-when-array) are NOT listed here — running
// scrubSecrets over the JSON string can rewrite quoted values and break
// downstream JSON.parse. Pre-scrub each element upstream of the
// JSON.stringify call instead, via `scrubFilePaths` below.
//
// D#44: that instruction sat here for four releases and exactly ONE call site
// followed it (hook-handoff.mjs, session_handoffs.key_files). observations
// .files_modified / .files_read, observation_files.filename and events
// .file_paths all stored raw paths while the title DERIVED FROM THE SAME PATH
// was scrubbed. A prescription in a comment is not a mechanism; the helper is.

import { scrubSecrets } from '../secret-scrub.mjs';

export const TEXT_FIELDS_BY_TABLE = {
  observations: [
    'title',
    'subtitle',
    'text',
    'narrative',
    'concepts',
    'facts',
    'lesson_learned',
    'search_aliases',
  ],
  // events: the auto-captured bugfix/lesson/decision path (saveEvent) and the
  // CLI /bug + /lesson commands both land here. title/body carry LLM output and
  // user-pasted repro text verbatim, so they must scrub like observations do —
  // event_type/project/git_sha are enums/identifiers/hash, left untouched.
  events: ['title', 'body'],
  session_summaries: [
    'request',
    'investigated',
    'learned',
    'completed',
    'next_steps',
    'remaining_items',
    'notes',
    'lessons',
    'key_decisions',
  ],
  session_handoffs: [
    'working_on',
    'completed',
    'unfinished',
    // Excluded:
    //   key_files       — JSON.stringify(array); pre-scrub elements at call site
    //   match_keywords  — currently a space-joined plain string; keeping it
    //                     here would scrub safely, but the value is built from
    //                     tokenizeHandoff() output (alphanumeric tokens only),
    //                     so secrets cannot survive the upstream tokenizer.
    //                     Excluded to avoid double-work + future-proof against
    //                     a refactor that switches to JSON.stringify.
    // key_decisions is kept: call site uses '\n'.join (plain string), and
    // decision titles can carry secrets verbatim (LLM output).
    'key_decisions',
  ],
  // deferred_work: the `mem_defer` free-text surface. R10 P1-5 — this table was absent,
  // and insertDeferred never called scrubRecord at all, so neither the listed path nor
  // the unknown-table failsafe ever ran. title/detail are written verbatim by the agent
  // ("rotate ghp_… before release", a connection string in detail) and replayed into
  // model context by the SessionStart dashboard, mem_defer_list and mem_get D#N.
  //   files — JSON.stringify(array); pre-scrubbed element-wise at insertDeferred via
  //           `scrubFilePaths`. It needed to be: `mem_defer` and `defer add --files` both
  //           take agent-supplied paths, and this line prescribed the remedy for four
  //           releases while the call site stored them raw.
  //   project / status — identifiers and an enum.
  deferred_work: ['title', 'detail', 'drop_reason'],
};

/**
 * Scrub one filesystem path — for PERSISTENCE and for KEY DERIVATION, which is
 * why this is a named export and not an inline `scrubSecrets(f)` at each site.
 *
 * `observation_files.filename` is both a stored value and the recall key
 * (lib/file-edge-match.mjs binds it four ways). If the write side scrubs and the
 * read side does not, the two derive different keys from the same path and a
 * lesson becomes unreachable through the very file it is about. Both sides call
 * THIS, so they cannot drift apart — the same rule this repo already enforces
 * for `fileMatchClause`'s two consumers.
 *
 * Total by construction: it never throws, because one caller is a hook on the
 * PreToolUse path. Nullish becomes '' (`p ?? ''`); anything else becomes its
 * String() form, so 42 yields '42', not ''.
 */
export function scrubFilePath(p) {
  // SEGMENT-WISE, and that is the whole point rather than a micro-optimisation.
  // Eight SECRET_PATTERNS carry a value class that does not exclude `/`
  // (secret-scrub.mjs:33/74/78/83/98/109/259/260). On prose that is correct; run
  // whole-path, the match eats the separator and everything after it, so
  // `/repo/token=<secret>/notes.mjs` became `/repo/token=***` — the filename
  // destroyed at WRITE time and unrecoverable, and every file under such a
  // directory collapsing onto one recall key (measured: an untouched `gamma.mjs`
  // recalled another file's observations). Splitting first bounds every pattern to
  // the segment it matched in.
  //
  // The trade, stated rather than glossed: a credential whose own syntax spans a
  // separator is no longer caught here — the Slack webhook path and the
  // `scheme://user:pass@host` arms both need their `/` characters. Those are URL
  // shapes, and these columns hold filesystem paths; `scrubSecrets` still runs
  // whole-string on every prose field, which is where a URL actually lands.
  // Preserving path structure wins because the path IS the recall key.
  //
  // The capture group keeps the separators in the split output, so join()
  // reconstructs the original byte-for-byte when nothing matches.
  return String(p ?? '')
    .split(/([/\\])/)
    .map((part) => (part === '/' || part === '\\' ? part : scrubSecrets(part)))
    .join('');
}

/**
 * Element-wise scrub for a path ARRAY, to be called upstream of the
 * `JSON.stringify` / junction INSERT this module's header points at.
 *
 * A non-array flows through UNTOUCHED, mirroring scrubRecord's own contract for
 * non-string fields. That is load-bearing rather than defensive: call sites pass
 * `undefined` on purpose (`JSON.stringify(undefined)` is `undefined`, which is
 * how a column stays NULL), and coercing it to `[]` here would quietly rewrite
 * NULL to '[]' in columns other code tests with `IS NULL` / `NOT IN (NULL,'[]')`.
 */
export function scrubFilePaths(paths) {
  return Array.isArray(paths) ? paths.map(scrubFilePath) : paths;
}

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
