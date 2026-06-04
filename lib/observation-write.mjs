// Single source of truth for the observations-table write surface. Two ingest
// paths previously hand-wrote divergent INSERTs — lib/save-observation.mjs (manual
// mem_save, 16 cols, omitted subtitle/search_aliases) and hook-llm.mjs (LLM
// auto-ingest, 18 cols) — the exact column-drift hazard the compress/maintain
// single-source cores were extracted to eliminate (see #8614). Add a column HERE
// and both ingest paths pick it up; neither can silently fall out of sync again.
//
// Statement-only: callers own the transaction boundary (both wrap the row + files
// + vector writes in one db.transaction so a failure can't leave a partial row).

import { getVocabulary, computeVector } from '../tfidf.mjs';
import { debugCatch } from '../utils.mjs';

// Canonical column order — must mirror the observations schema (schema.mjs).
const OBS_COLUMNS = [
  'memory_session_id', 'project', 'text', 'type', 'title', 'subtitle',
  'narrative', 'concepts', 'facts', 'files_read', 'files_modified',
  'importance', 'minhash_sig', 'lesson_learned', 'search_aliases', 'branch',
  'created_at', 'created_at_epoch',
];
// Defaults for columns a caller omits. NULL-default columns (subtitle,
// search_aliases) match the schema DEFAULT, so omitting == the old short INSERT.
// concepts/facts/files_read default to the empty literals the manual path used.
const OBS_DEFAULTS = {
  subtitle: null, narrative: '', concepts: '', facts: '',
  files_read: '[]', files_modified: '[]', search_aliases: null, importance: 1,
};

/**
 * Insert one observations row from a {column: value} map and return its id.
 * Omitted columns fall back to OBS_DEFAULTS (or NULL). The column list lives only
 * here, so a schema column can never drift between the two ingest paths again.
 */
export function insertObservationRow(db, fields) {
  const values = OBS_COLUMNS.map(c =>
    Object.prototype.hasOwnProperty.call(fields, c) ? fields[c]
      : (c in OBS_DEFAULTS ? OBS_DEFAULTS[c] : null)
  );
  const placeholders = OBS_COLUMNS.map(() => '?').join(', ');
  const result = db
    .prepare(`INSERT INTO observations (${OBS_COLUMNS.join(', ')}) VALUES (${placeholders})`)
    .run(...values);
  return Number(result.lastInsertRowid);
}

/** Populate the observation_files junction (skips non-string / empty entries). */
export function insertObservationFiles(db, obsId, files) {
  if (!obsId || !Array.isArray(files) || files.length === 0) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
  for (const f of files) if (typeof f === 'string' && f.length > 0) stmt.run(obsId, f);
}

/**
 * Best-effort TF-IDF vector write. Non-critical: vocab may be uninitialized on a
 * fresh DB, so failures are swallowed (caller's transaction must NOT roll back the
 * observation over a missing vector).
 */
export function insertObservationVector(db, obsId, vecText) {
  try {
    const vocab = getVocabulary(db);
    if (!vocab) return;
    const vec = computeVector(vecText, vocab);
    if (!vec) return;
    db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
      .run(obsId, Buffer.from(vec.buffer), vocab.version, Date.now());
  } catch (e) { debugCatch(e, 'insertObservationVector'); }
}
