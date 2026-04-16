// Phase C (Invited-Memory plan, T11): CLI handlers for
//   claude-mem-lite adopt [--all] [--force] [--dry-run] [--status]
//   claude-mem-lite unadopt [--all]
//
// adopt = write sentinel section into MEMORY.md + drop plugin_claude_mem_lite.md
// unadopt = precise sentinel removal + doc cleanup
// --all  = scan every project under ~/.claude/projects/*/memory/
// --force = override UserEditedError
// --dry-run = print intent without writing
// --status = list all adopted projects + versions

import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  memdirPath, writePluginSection, removePluginSection,
  writePluginDoc, removePluginDoc,
  isAdopted, readMemoryIndex,
  UserEditedError, BudgetExceededError,
} from './memdir.mjs';
import {
  PLUGIN_SLUG, CURRENT_SENTINEL_VERSION, getIndexLine, getDetailDoc,
} from './adopt-content.mjs';

function log(msg) { console.log(msg); }

function detectCwd() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

function projectsRoot() {
  return join(homedir(), '.claude', 'projects');
}

function listAllMemdirs() {
  const base = projectsRoot();
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base)) {
    const memdir = join(base, name, 'memory');
    try {
      if (existsSync(memdir) && statSync(memdir).isDirectory()) {
        out.push({ projectSlug: name, memdir });
      }
    } catch { /* ignore entries we can't stat */ }
  }
  return out;
}

function hasFlag(args, flag) { return Array.isArray(args) && args.includes(flag); }

/**
 * cmdAdopt — write sentinel section + plugin doc to memdir.
 * Exit code 1 on any hard failure; skipped (--all + UserEditedError) doesn't
 * fail the batch.
 */
export function cmdAdopt(args = []) {
  if (hasFlag(args, '--status')) return statusAll();

  const all = hasFlag(args, '--all');
  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');

  const targets = all
    ? listAllMemdirs().map((m) => m.memdir)
    : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[adopt] no memdirs to adopt (use without --all for current project)');
    return;
  }

  let created = 0, updated = 0, unchanged = 0, skipped = 0, failed = 0;
  for (const memdir of targets) {
    const r = adoptOne(memdir, { force, dryRun, all });
    if (r.action === 'created') created++;
    else if (r.action === 'updated') updated++;
    else if (r.action === 'unchanged') unchanged++;
    else if (r.action === 'skipped') skipped++;
    else if (r.action === 'dry-run') unchanged++;
    else failed++;
  }

  log('');
  log(`[adopt] ${targets.length} target(s): ${created} created, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

function adoptOne(memdir, { force, dryRun, all }) {
  const contentLine = getIndexLine();
  const version = CURRENT_SENTINEL_VERSION;

  if (dryRun) {
    log(`[adopt --dry-run] ${memdir}`);
    log(`  MEMORY.md line: ${contentLine}`);
    log(`  detail file:    plugin_claude_mem_lite.md (${getDetailDoc().length} chars)`);
    return { action: 'dry-run' };
  }

  try {
    const r = writePluginSection(memdir, { slug: PLUGIN_SLUG, version, contentLine, force });
    writePluginDoc(memdir, PLUGIN_SLUG, getDetailDoc());
    log(`[adopt] ${memdir} → ${r.action}`);
    return r;
  } catch (e) {
    if (e instanceof UserEditedError && all) {
      log(`[adopt] ${memdir} → skipped (user-edited; pass --force to override)`);
      return { action: 'skipped' };
    }
    if (e instanceof UserEditedError) {
      log(`[adopt] ${memdir} → refused: ${e.message}`);
      log('[adopt] pass --force to overwrite, or edit/uninstall manually.');
      return { action: 'failed' };
    }
    if (e instanceof BudgetExceededError) {
      log(`[adopt] ${memdir} → failed: ${e.message}`);
      return { action: 'failed' };
    }
    log(`[adopt] ${memdir} → error: ${e.message}`);
    return { action: 'failed' };
  }
}

function statusAll() {
  const dirs = listAllMemdirs();
  log('[adopt --status] scanning ~/.claude/projects/*/memory/');
  if (dirs.length === 0) { log('  (no memdirs found)'); return; }
  let adopted = 0;
  for (const { projectSlug, memdir } of dirs) {
    if (isAdopted(memdir, PLUGIN_SLUG)) {
      const idx = readMemoryIndex(memdir, PLUGIN_SLUG);
      log(`  ✓ ${projectSlug} (${idx.version})`);
      adopted++;
    }
  }
  log('');
  log(`[adopt --status] ${adopted}/${dirs.length} adopted`);
}

/**
 * cmdUnadopt — precise removal of sentinel section + plugin doc.
 * Exit code stays 0: unadopt is idempotent; "absent" isn't an error.
 */
export function cmdUnadopt(args = []) {
  const all = hasFlag(args, '--all');
  const targets = all
    ? listAllMemdirs().map((m) => m.memdir)
    : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[unadopt] no memdirs found');
    return;
  }

  let removed = 0, absent = 0;
  for (const memdir of targets) {
    const r = removePluginSection(memdir, PLUGIN_SLUG);
    removePluginDoc(memdir, PLUGIN_SLUG);
    if (r.action === 'removed') removed++;
    else absent++;
    log(`[unadopt] ${memdir} → ${r.action}`);
  }

  log('');
  log(`[unadopt] ${targets.length} target(s): ${removed} removed, ${absent} absent`);
}
