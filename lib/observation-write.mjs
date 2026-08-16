// Single source of truth for the observations-table write surface. Two ingest
// paths previously hand-wrote divergent INSERTs — lib/save-observation.mjs (manual
// mem_save, 16 cols, omitted subtitle/search_aliases) and hook-llm.mjs (LLM
// auto-ingest, 18 cols) — the exact column-drift hazard the compress/maintain
// single-source cores were extracted to eliminate (see #8614). Add a column HERE
// and both ingest paths pick it up; neither can silently fall out of sync again.
//
// Statement-only: callers own the transaction boundary (both wrap the row + files
// + vector writes in one db.transaction so a failure can't leave a partial row).

import { getVocabulary, computeVector, vectorsEnabled } from '../tfidf.mjs';
import { debugCatch, cjkBigrams, scrubSecrets } from '../utils.mjs';

// Canonical column order — must mirror the observations schema (schema.mjs).
const OBS_COLUMNS = [
  'memory_session_id', 'project', 'text', 'type', 'title', 'subtitle',
  'narrative', 'concepts', 'facts', 'files_read', 'files_modified',
  'importance', 'minhash_sig', 'lesson_learned', 'search_aliases', 'branch',
  'created_at', 'created_at_epoch', 'scope',
];

// P3 (D#78): lesson applicability scope. Hard whitelist — Haiku output is
// untrusted; anything outside the enum (including case variants) becomes NULL,
// which every scope-aware read path treats as "unclassified, do not filter".
const VALID_SCOPES = new Set(['file', 'module', 'project', 'environment']);

/** Validate an LLM-emitted scope value against the enum; invalid → null. */
export function normalizeScope(value) {
  return typeof value === 'string' && VALID_SCOPES.has(value) ? value : null;
}
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
  if (!vectorsEnabled()) return;  // Phase-1: vector arm disabled by default (audit 2026-06-27)
  try {
    const vocab = getVocabulary(db);
    if (!vocab) return;
    const vec = computeVector(vecText, vocab);
    if (!vec) return;
    db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
      .run(obsId, Buffer.from(vec.buffer), vocab.version, Date.now());
  } catch (e) { debugCatch(e, 'insertObservationVector'); }
}

/**
 * Rebuild an observation's derived columns after a field UPDATE: the FTS `text`
 * column (incl. CJK bigrams + search_aliases, matching the ingest paths) and the
 * TF-IDF vector. cmdUpdate (CLI) and mem_update (MCP) previously hand-copied this
 * block — the same drift class #8614/#8639 closed for compress/maintain. Caller
 * owns the transaction (vector write is internally non-critical).
 */
// P2-12: internal-only since applyObsUpdate became the single update choke point
// (both faces previously imported this directly; un-exported per knip discipline).
function rebuildObservationDerived(db, obsId) {
  const row = db.prepare('SELECT title, subtitle, narrative, concepts, facts, lesson_learned, search_aliases FROM observations WHERE id = ?').get(obsId);
  if (!row) return;
  const base = [row.title, row.subtitle, row.narrative, row.concepts, row.facts, row.lesson_learned, row.search_aliases].filter(Boolean).join(' ');
  const bigrams = cjkBigrams((row.title || '') + ' ' + (row.narrative || ''));
  const textField = bigrams ? base + ' ' + bigrams : base;
  db.prepare('UPDATE observations SET text = ? WHERE id = ?').run(textField, obsId);
  insertObservationVector(db, obsId, textField);
}

// P2-12 (audit 2026-08-14): shared update mutation for the CLI `update` / MCP
// `mem_update` twin. Both faces previously built the SET list + ran the
// transaction + rebuild inline (byte-equivalent copies); each keeps its own
// validation front-end (CLI flag guards / MCP zod) and passes only the fields
// it accepted. String values are secret-scrubbed here — the single choke point,
// so a new face can't forget it (concepts had already slipped through once).
const UPDATABLE_OBS_COLS = ['title', 'narrative', 'type', 'importance', 'lesson_learned', 'concepts'];

/**
 * Apply a validated field patch to one observation: UPDATE + derived-column
 * rebuild (FTS text + vector) in one transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id - observation id (caller has verified existence)
 * @param {object} fields - subset of {title, narrative, type, importance, lesson_learned, concepts}
 * @returns {string[]} column names actually updated ([] = nothing to do, no write)
 */
export function applyObsUpdate(db, id, fields) {
  const updates = [];
  const params = [];
  for (const col of UPDATABLE_OBS_COLS) {
    if (fields[col] !== undefined) {
      updates.push(`${col} = ?`);
      params.push(typeof fields[col] === 'string' ? scrubSecrets(fields[col]) : fields[col]);
    }
  }
  if (updates.length === 0) return [];
  params.push(id);
  db.transaction(() => {
    db.prepare(`UPDATE observations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    rebuildObservationDerived(db, id);
  })();
  return updates.map((u) => u.split(' =')[0]);
}
