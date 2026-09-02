// Shared body for the registry write actions — import / remove / reindex.
//
// These were the last un-collapsed CLI/MCP twin (audit 2026-08-22 P1-3): mem-cli.mjs and
// server.mjs each wrote their own SQL for the same three actions, and had already drifted —
// the CLI granted a user-initiated import `quality_tier = 'installed'` and the MCP twin did
// not, so the same intent produced differently-ranked rows depending on which surface the
// user reached for. That is this project's first-listed病类 ("a guard wired into one face,
// missing on the other"), so the fix is a single body both faces call, not a second patch.
//
// Contract: these functions decide and write. They return structured results and never
// format output or touch process state — rendering (and CLI-only concerns like bare-flag
// rejection or the "add --capability-summary" tip) stays in the surface.

import { upsertResource } from '../registry.mjs';

/**
 * String columns an import may set, in canonical snake_case. Single source: the CLI derives
 * its kebab-case flag names from this list, the MCP tool reads its args by these keys, so a
 * new column is added once and both surfaces pick it up.
 */
export const IMPORT_STRING_FIELDS = [
  'repo_url',
  'local_path',
  'invocation_name',
  'intent_tags',
  'domain_tags',
  'trigger_patterns',
  'capability_summary',
  'keywords',
  'tech_stack',
  'use_cases',
];

/**
 * Resolve the `source` column for an import.
 *
 * Preserve provenance on a metadata-only re-import: default to 'user' only for a genuinely
 * NEW resource. Re-importing an existing github/preinstalled row without an explicit source
 * must not flip it to 'user' (which also mis-grants the user-source rank boost).
 */
function resolveSource(db, { type, name, source }) {
  if (source) return source;
  const existing = db.prepare('SELECT source FROM resources WHERE type = ? AND name = ?').get(type, name);
  return existing ? existing.source : 'user';
}

/**
 * Upsert one resource.
 *
 * @param {object} db  open resource-registry.db handle
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.type              'skill' | 'agent'
 * @param {string} [params.source]          explicit provenance; absent = user-initiated
 * @param {object} [params.fields]          IMPORT_STRING_FIELDS values (snake_case keys)
 * @returns {{id: number, source: string, installedTierGranted: boolean}}
 */
export function importResource(db, { name, type, source, fields = {} }) {
  const resolvedSource = resolveSource(db, { type, name, source });

  const row = { name, type, status: 'active', source: resolvedSource };
  for (const f of IMPORT_STRING_FIELDS) row[f] = fields[f] || '';

  const id = upsertResource(db, row);

  // A user-initiated import (no explicit --source/source arg) means the user deliberately
  // added this resource — it gets the 'installed' quality tier, which the retriever reads as
  // a ranking bonus and the recommendation gate reads as a precision signal.
  const installedTierGranted = Boolean(id) && !source;
  if (installedTierGranted) {
    db.prepare("UPDATE resources SET quality_tier = 'installed' WHERE id = ?").run(id);
  }

  return { id, source: resolvedSource, installedTierGranted };
}

/**
 * Delete one resource.
 * @returns {{removed: boolean}} removed=false means nothing matched (not an error).
 */
export function removeResource(db, { name, type }) {
  const result = db.prepare('DELETE FROM resources WHERE type = ? AND name = ?').run(type, name);
  return { removed: result.changes > 0 };
}

/**
 * Rebuild the FTS5 index over the resources table.
 * @returns {{activeCount: number}}
 */
export function reindexResources(db) {
  db.exec("INSERT INTO resources_fts(resources_fts) VALUES('rebuild')");
  const row = db.prepare('SELECT COUNT(*) as c FROM resources WHERE status = ?').get('active');
  return { activeCount: row.c };
}
