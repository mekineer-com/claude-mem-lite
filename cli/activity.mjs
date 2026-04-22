// cli/activity.mjs — `claude-mem-lite activity <save|search|recent|show>`.
// Extracted from mem-cli.mjs (v2.41, god-module split). Thin wrapper over
// lib/activity.mjs pure functions.
//
// Events namespace is separate from observations (schema.mjs v2.31 T6): the
// activity table stores bugfix/lesson/bug/discovery/refactor/feature/observation/
// decision events with their own FTS5 index. All mutations go through
// lib/activity.mjs::saveEvent, which enforces the type CHECK and populates
// events_fts via triggers.

import { inferProject } from '../utils.mjs';
import { resolveProject } from '../project-utils.mjs';
import { parseArgs, out, fail } from './common.mjs';

function formatActivityResults(rows) {
  if (!rows || rows.length === 0) return '(no events)';
  return rows.map(r => `#${r.id} [${r.event_type}] ${r.title}`).join('\n');
}

export async function cmdActivity(db, args) {
  const sub = args[0];
  if (!sub) {
    fail('[mem] Usage: claude-mem-lite activity <save|search|recent|show> ...');
    return;
  }

  const { positional, flags } = parseArgs(args.slice(1));
  const { saveEvent, searchEvents, recentEvents, getEvent, EVENT_TYPES } = await import('../lib/activity.mjs');
  const VALID_EVENT_TYPES = new Set(EVENT_TYPES);
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();

  if (sub === 'save') {
    const type = flags.type || 'observation';
    if (!VALID_EVENT_TYPES.has(type)) {
      fail(`[mem] activity save: invalid --type "${type}". Valid: ${[...VALID_EVENT_TYPES].join(', ')}`);
      return;
    }
    const title = flags.title || positional.join(' ').trim();
    if (!title) {
      fail('[mem] activity save: --title or positional text required');
      return;
    }
    const body = flags.body || null;
    // Accept both --file (singular, backward compat) and --files (plural,
    // comma-split, preferred — matches cmdSave). Merge both sources.
    const filesFromPlural = flags.files && typeof flags.files === 'string'
      ? flags.files.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const filesFromSingular = flags.file && typeof flags.file === 'string' ? [flags.file] : [];
    const file_paths_merged = [...filesFromSingular, ...filesFromPlural];
    const file_paths = file_paths_merged.length > 0 ? file_paths_merged : null;
    const rawImp = flags.importance !== undefined ? parseInt(flags.importance, 10) : 2;
    if (flags.importance !== undefined && (isNaN(rawImp) || rawImp < 1 || rawImp > 3)) {
      fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
      return;
    }
    const id = saveEvent(db, {
      project,
      event_type: type,
      title,
      body,
      importance: rawImp,
      file_paths,
    });
    out(JSON.stringify({ ok: true, id }));
    return;
  }

  if (sub === 'search') {
    const q = positional.join(' ');
    if (!q) {
      fail('[mem] activity search: query required');
      return;
    }
    const type = flags.type || null;
    if (type !== null && !VALID_EVENT_TYPES.has(type)) {
      fail(`[mem] activity search: invalid --type "${type}". Valid: ${[...VALID_EVENT_TYPES].join(', ')}`);
      return;
    }
    const limit = flags.limit !== undefined ? parseInt(flags.limit, 10) : 10;
    const rows = searchEvents(db, q, { project, type, limit });
    out(formatActivityResults(rows));
    return;
  }

  if (sub === 'recent') {
    // Accept either `activity recent 5` or `activity recent --limit 5`.
    const posLimit = positional.length > 0 ? parseInt(positional[0], 10) : NaN;
    const flagLimit = flags.limit !== undefined ? parseInt(flags.limit, 10) : NaN;
    const limit = Number.isFinite(posLimit) ? posLimit : (Number.isFinite(flagLimit) ? flagLimit : 20);
    const type = flags.type || null;
    if (type !== null && !VALID_EVENT_TYPES.has(type)) {
      fail(`[mem] activity recent: invalid --type "${type}". Valid: ${[...VALID_EVENT_TYPES].join(', ')}`);
      return;
    }
    const rows = recentEvents(db, { project, type, limit });
    out(formatActivityResults(rows));
    return;
  }

  if (sub === 'show') {
    const id = positional.length > 0 ? parseInt(positional[0], 10) : NaN;
    if (!Number.isFinite(id)) {
      fail('[mem] activity show: numeric id required');
      return;
    }
    const row = getEvent(db, id);
    out(row ? JSON.stringify(row, null, 2) : 'Not found');
    return;
  }

  fail(`[mem] Unknown activity subcommand: ${sub}`);
}
