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

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
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

// ─── Per-project auto-adopt opt-out sentinel ─────────────────────────────────
// `<memdir>/.mem-no-auto-adopt` is the durable, project-scoped escape hatch.
// Survives marker deletion, sentinel removal, and plugin reinstalls — that's
// the point: "user said no for this project" should not be reversible by
// `rm ~/.claude-mem-lite/runtime/.auto-adopt-*`. Managed via
// `claude-mem-lite adopt --disable` / `--enable`. silentAutoAdopt checks it
// at entry and skips WITHOUT writing the runtime marker, so toggling
// `--enable` re-arms auto-adopt on the next SessionStart.
const DISABLE_SENTINEL_BASENAME = '.mem-no-auto-adopt';

export function disableSentinelPath(memdir) {
  return join(memdir, DISABLE_SENTINEL_BASENAME);
}

export function isAutoAdoptDisabled(memdir) {
  return existsSync(disableSentinelPath(memdir));
}

/**
 * cmdAdopt — write sentinel section + plugin doc to memdir.
 * Exit code 1 on any hard failure; skipped (--all + UserEditedError) doesn't
 * fail the batch.
 */
export function cmdAdopt(args = []) {
  if (hasFlag(args, '--status')) return statusAll();
  if (hasFlag(args, '--disable')) return cmdDisable(args);
  if (hasFlag(args, '--enable')) return cmdEnable(args);

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

/**
 * silentAutoAdopt — plugin-mode first-run auto-adopt helper (v2.33.0+).
 *
 * Preconditions (caller must gate): CLAUDE_PLUGIN_ROOT set, MEM_NO_AUTO_ADOPT!=1,
 * first-attempt marker absent. This helper does NOT re-check those — it only
 * does the write + marker persistence. (v2.82.0: dropped MEM_QUIET_HOOKS gate;
 * quiet is a stdout control, not a side-effect control.)
 *
 * Behavior:
 *   - If `<memdir>/.mem-no-auto-adopt` exists: skip silently, do NOT write the
 *     runtime marker. This keeps `--enable` re-armable: deleting the disable
 *     sentinel lets the next SessionStart try again.
 *   - Else: writes plugin sentinel + detail doc to the memdir for `cwd`.
 *   - Writes a per-project first-attempt marker under `markerDir` so a later
 *     `/unadopt` is respected (no re-adopt loop).
 *   - Silent: never logs, never throws. Returns structured result.
 *
 * Returns { ok, action, reason } — caller uses for telemetry / debugLog only.
 */
export function silentAutoAdopt({ cwd, markerDir, markerKey }) {
  const memdir = memdirPath(cwd);
  try {
    if (isAutoAdoptDisabled(memdir)) {
      return { ok: true, action: 'disabled', reason: 'disabled-by-sentinel' };
    }
    if (isAdopted(memdir, PLUGIN_SLUG)) {
      writeMarker(markerDir, markerKey);
      return { ok: true, action: 'already-adopted' };
    }
    writePluginSection(memdir, {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      contentLine: getIndexLine(),
      force: false,
    });
    writePluginDoc(memdir, PLUGIN_SLUG, getDetailDoc());
    writeMarker(markerDir, markerKey);
    return { ok: true, action: 'adopted' };
  } catch (e) {
    // Budget exceeded, user-edited conflict, or FS error — write marker so we
    // don't retry on every SessionStart. User can run /adopt --force manually.
    try { writeMarker(markerDir, markerKey); } catch { /* marker best-effort */ }
    const reason = e instanceof UserEditedError ? 'user-edited'
      : e instanceof BudgetExceededError ? 'budget-exceeded'
      : 'error';
    return { ok: false, action: 'skipped', reason, err: e };
  }
}

function writeMarker(markerDir, markerKey) {
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  const path = join(markerDir, `.auto-adopt-${markerKey}`);
  writeFileSync(path, JSON.stringify({ firstAttemptAt: new Date().toISOString() }));
}

export function hasAutoAdoptMarker(markerDir, markerKey) {
  return existsSync(join(markerDir, `.auto-adopt-${markerKey}`));
}

/**
 * cmdDisable — `claude-mem-lite adopt --disable [--all]`.
 *
 * Writes `<memdir>/.mem-no-auto-adopt` so SessionStart auto-adopt skips this
 * project permanently. Idempotent: re-running on an already-disabled memdir is
 * a no-op. Does NOT remove an existing sentinel — pair with `unadopt` if you
 * want both. The two operations are deliberately separate:
 *   - `unadopt`      = "remove the contract now"
 *   - `adopt --disable` = "and don't auto-write it back"
 */
function cmdDisable(args) {
  const all = hasFlag(args, '--all');
  const targets = all
    ? listAllMemdirs().map((m) => m.memdir)
    : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[adopt --disable] no memdirs found');
    return;
  }

  let disabled = 0, already = 0;
  for (const memdir of targets) {
    if (!existsSync(memdir)) mkdirSync(memdir, { recursive: true });
    const path = disableSentinelPath(memdir);
    if (existsSync(path)) {
      log(`[adopt --disable] ${memdir} → already-disabled`);
      already++;
      continue;
    }
    writeFileSync(path, JSON.stringify({ disabledAt: new Date().toISOString() }) + '\n');
    log(`[adopt --disable] ${memdir} → disabled`);
    disabled++;
  }

  log('');
  log(`[adopt --disable] ${targets.length} target(s): ${disabled} newly disabled, ${already} already disabled`);
}

/**
 * cmdEnable — `claude-mem-lite adopt --enable [--all]`.
 *
 * Removes the `<memdir>/.mem-no-auto-adopt` sentinel so the next SessionStart
 * can auto-adopt again. Idempotent. Does NOT trigger an immediate adoption —
 * run plain `claude-mem-lite adopt` if you want that now.
 */
function cmdEnable(args) {
  const all = hasFlag(args, '--all');
  const targets = all
    ? listAllMemdirs().map((m) => m.memdir)
    : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[adopt --enable] no memdirs found');
    return;
  }

  let enabled = 0, absent = 0;
  for (const memdir of targets) {
    const path = disableSentinelPath(memdir);
    if (!existsSync(path)) {
      log(`[adopt --enable] ${memdir} → absent`);
      absent++;
      continue;
    }
    try { unlinkSync(path); } catch { /* best-effort */ }
    log(`[adopt --enable] ${memdir} → enabled`);
    enabled++;
  }

  log('');
  log(`[adopt --enable] ${targets.length} target(s): ${enabled} re-enabled, ${absent} not-disabled`);
}

function statusAll() {
  const dirs = listAllMemdirs();
  log('[adopt --status] scanning ~/.claude/projects/*/memory/');
  if (dirs.length === 0) { log('  (no memdirs found)'); return; }
  let adopted = 0, disabled = 0;
  for (const { projectSlug, memdir } of dirs) {
    const isAdoptedHere = isAdopted(memdir, PLUGIN_SLUG);
    const isDisabledHere = isAutoAdoptDisabled(memdir);
    if (isAdoptedHere) {
      const idx = readMemoryIndex(memdir, PLUGIN_SLUG);
      const suffix = isDisabledHere ? ' [auto-adopt disabled]' : '';
      log(`  ✓ ${projectSlug} (${idx.version})${suffix}`);
      adopted++;
      if (isDisabledHere) disabled++;
    } else if (isDisabledHere) {
      log(`  ✗ ${projectSlug} (auto-adopt disabled, no sentinel)`);
      disabled++;
    }
  }
  log('');
  log(`[adopt --status] ${adopted}/${dirs.length} adopted${disabled > 0 ? `, ${disabled} disabled` : ''}`);

  // Gating snapshot — helps debug "why didn't auto-adopt fire?"
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? 'set' : 'unset';
  const noAutoAdopt = process.env.MEM_NO_AUTO_ADOPT === '1' ? '1 (opt-out)' : 'unset';
  log('');
  log('Auto-adopt gates (next SessionStart will fire only if both pass):');
  log(`  CLAUDE_PLUGIN_ROOT  = ${pluginRoot}  (plugin-mode install required; npx stays opt-in)`);
  log(`  MEM_NO_AUTO_ADOPT   = ${noAutoAdopt}  (global escape hatch)`);
  log('Per-project opt-out: `claude-mem-lite adopt --disable` (run --enable to re-arm).');
}

/**
 * cmdUnadopt — precise removal of sentinel section + plugin doc.
 * Exit code stays 0: unadopt is idempotent; "absent" isn't an error.
 *
 * Flags:
 *   --all       Operate on every memdir under ~/.claude/projects/*\/memory/
 *   --status    Read-only: list currently-adopted memdirs (mirrors `adopt --status`).
 *   --dry-run   Preview what would be removed; no filesystem writes.
 *
 * Pre-fix history: unrecognized flags (e.g. `--status` extrapolated from `adopt --status`,
 * or `--dry-run` extrapolated from `adopt --dry-run`) were silently ignored and the
 * destructive default ran anyway, removing the sentinel block when the user expected
 * a read-only probe.
 */
export function cmdUnadopt(args = []) {
  if (hasFlag(args, '--status')) return statusAll();

  const all = hasFlag(args, '--all');
  const dryRun = hasFlag(args, '--dry-run');
  const targets = all
    ? listAllMemdirs().map((m) => m.memdir)
    : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[unadopt] no memdirs found');
    return;
  }

  let removed = 0, absent = 0;
  for (const memdir of targets) {
    if (dryRun) {
      const adopted = isAdopted(memdir, PLUGIN_SLUG);
      const action = adopted ? 'would-remove' : 'absent';
      log(`[unadopt --dry-run] ${memdir} → ${action}`);
      if (adopted) removed++; else absent++;
      continue;
    }
    const r = removePluginSection(memdir, PLUGIN_SLUG);
    removePluginDoc(memdir, PLUGIN_SLUG);
    if (r.action === 'removed') removed++;
    else absent++;
    log(`[unadopt] ${memdir} → ${r.action}`);
  }

  log('');
  const verb = dryRun ? 'would remove' : 'removed';
  log(`[unadopt${dryRun ? ' --dry-run' : ''}] ${targets.length} target(s): ${removed} ${verb}, ${absent} absent`);
}
