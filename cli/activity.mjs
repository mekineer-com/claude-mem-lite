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
    fail('[mem] Usage: claude-mem-lite activity <save|search|recent|show|delete> ...');
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
    if (row) {
      out(JSON.stringify(row, null, 2));
    } else {
      out(`[mem] activity show: event #${id} Not found`);
    }
    return;
  }

  if (sub === 'delete') {
    // Mirrors cmdDelete (mem-cli.mjs:1316): preview by default, --confirm
    // executes. Per Tier 3b in tasks/v2.66-carry-forward.md the events table
    // accumulates corrupted titles from old hook-llm fallback bugs (#8158).
    // This command lets users prune them by ID without dropping to raw SQL.
    const idStr = positional.join(',').trim();
    if (!idStr) {
      fail('[mem] Usage: claude-mem-lite activity delete <id1,id2,...> [--confirm]');
      return;
    }
    const ids = idStr.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => parseInt(s, 10))
      .filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      fail('[mem] activity delete: no valid IDs provided (must be positive integers)');
      return;
    }

    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, event_type, title FROM events WHERE id IN (${placeholders})`).all(...ids);
    if (rows.length === 0) {
      fail(`[mem] activity delete: no events found for ID(s) ${ids.join(', ')}`);
      return;
    }

    const confirm = flags.confirm === true || flags.confirm === 'true';
    if (!confirm) {
      out(`[mem] Preview: ${rows.length} event(s) will be deleted:`);
      for (const r of rows) {
        const titleStr = (r.title || '').slice(0, 100);
        out(`  #${r.id} [${r.event_type}] ${titleStr}`);
      }
      const missingIds = ids.filter(i => !rows.some(r => r.id === i));
      if (missingIds.length > 0) {
        out(`[mem] Note: ${missingIds.length} ID(s) not found and will be skipped: ${missingIds.join(', ')}`);
      }
      out('[mem] Run with --confirm to execute deletion.');
      return;
    }

    const result = db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...ids);
    out(`[mem] Deleted ${result.changes} event(s).`);
    return;
  }

  fail(`[mem] Unknown activity subcommand: ${sub}`);
}
