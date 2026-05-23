#!/usr/bin/env node
// claude-mem-lite Installer — Smart install/uninstall/status/doctor

import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, cpSync, renameSync, symlinkSync, unlinkSync, readdirSync, statSync, lstatSync } from 'fs';
import { join, resolve, dirname, isAbsolute } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const PROJECT_DIR = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)));
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const DATA_DIR = join(homedir(), '.claude-mem-lite');
const DB_PATH = join(DATA_DIR, 'claude-mem-lite.db');
const OLD_DATA_DIR = join(homedir(), '.claude-mem');

// Detect ephemeral context (npx) — files won't persist after exit
const IS_NPX = process.env.npm_command === 'exec' ||
  PROJECT_DIR.includes('_npx') || PROJECT_DIR.includes('.npm/_');

// Both modes install to ~/.claude-mem-lite/ (copies or symlinks)
const INSTALL_DIR = DATA_DIR;
const SERVER_PATH = join(INSTALL_DIR, 'server.mjs');
const HOOK_PATH = join(INSTALL_DIR, 'hook.mjs');
const MARKETPLACE_KEY = 'sdsrss';
const PLUGIN_KEY = `claude-mem-lite@${MARKETPLACE_KEY}`;
const NPM_INSTALL_CMD = 'npm install --omit=dev --no-audit --no-fund';

import { RESOURCE_METADATA } from './install-metadata.mjs';
import { scanPluginCacheHookPollution } from './plugin-cache-guard.mjs';
import { SOURCE_FILES, HOOK_SCRIPT_FILES } from './source-files.mjs';
import { probeBetterSqlite3Binding, ensureBetterSqlite3Working } from './lib/binding-probe.mjs';

// Re-export for backward compatibility — tests/install-hook-scripts.test.mjs
// and any external consumers still import HOOK_SCRIPT_FILES from install.mjs.
// The constant itself moved to source-files.mjs in v2.55 so hook-update.mjs
// can share it without a static cycle.
export { HOOK_SCRIPT_FILES };

// Re-export for backward compatibility — tests/install-bsqlite-probe.test.mjs
// imports these from install.mjs. The implementation moved to lib/binding-probe.mjs
// so scripts/launch.mjs can share the probe without importing install.mjs (which
// pulls heavy install-only deps).
export { probeBetterSqlite3Binding, ensureBetterSqlite3Working };

export function copyHookScripts(srcDir, destDir) {
  for (const name of HOOK_SCRIPT_FILES) {
    const src = join(srcDir, name);
    if (existsSync(src)) copyFileSync(src, join(destDir, name));
  }
}

/**
 * Move legacy `~/.claude-mem/claude-mem.db` (+ -wal/-shm sidecars) to
 * timestamped `*.legacy-backup-<ms>` files inside `newDir`. The legacy DB
 * carries v16 schema (schema_versions plural table); the new claude-mem-lite
 * code expects v28 (schema_version singular + memory_session_id column) and
 * MIGRATIONS[] has no v16→v28 bridge — so loading the legacy DB FATALs on
 * first launch. Backing up rather than copying-as-current lets the new
 * install create a fresh v28 DB while preserving legacy bytes for recovery.
 *
 * Returns: {action: 'noop'|'skip'|'backed-up', backupPath?}
 *   - noop: no legacy DB found
 *   - skip: working `claude-mem-lite.db` already exists in newDir
 *   - backed-up: legacy files renamed to `<newDir>/claude-mem-lite.db.legacy-backup-<ts>` etc.
 */
export function migrateLegacyClaudeMemData(oldDir, newDir, opts = {}) {
  const legacyDb = join(oldDir, 'claude-mem.db');
  const targetDb = join(newDir, 'claude-mem-lite.db');
  if (!existsSync(legacyDb)) return { action: 'noop' };
  if (existsSync(targetDb)) return { action: 'skip' };

  if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
  const ts = opts.now ?? Date.now();
  const backupPath = join(newDir, `claude-mem-lite.db.legacy-backup-${ts}`);
  renameSync(legacyDb, backupPath);
  for (const ext of ['-wal', '-shm']) {
    const src = legacyDb + ext;
    if (existsSync(src)) renameSync(src, join(newDir, `claude-mem-lite.db${ext}.legacy-backup-${ts}`));
  }
  return { action: 'backed-up', backupPath };
}

/**
 * Derive invocation_name from resource name when metadata doesn't provide one.
 * Rules:
 *   "parent/child" → "parent:child"  (plugin:resource format)
 *   "simple-name"  → "simple-name"   (standalone resource)
 * @param {string} name Resource name
 * @returns {string} Derived invocation name
 */
function deriveInvocationName(name) {
  if (name.includes('/')) return name.replace('/', ':');
  return name;
}

/**
 * Apply curated metadata to existing resource DB entries.
 * Fixes existing installs that have generic name-echo metadata.
 * Also syncs keywords, tech_stack, use_cases and auto-derives invocation_name.
 * @param {Database} rdb Registry database handle
 */
function reindexKnownResources(rdb) {
  const update = rdb.prepare(`
    UPDATE resources SET
      intent_tags = ?, domain_tags = ?,
      capability_summary = ?, trigger_patterns = ?,
      invocation_name = CASE WHEN ? != '' THEN ? ELSE invocation_name END,
      recommendation_mode = CASE WHEN ? != '' THEN ? ELSE recommendation_mode END,
      keywords = CASE WHEN ? != '' THEN ? ELSE keywords END,
      tech_stack = CASE WHEN ? != '' THEN ? ELSE tech_stack END,
      use_cases = CASE WHEN ? != '' THEN ? ELSE use_cases END,
      updated_at = datetime('now')
    WHERE type = ? AND name = ?
  `);

  rdb.transaction(() => {
    for (const [key, meta] of Object.entries(RESOURCE_METADATA)) {
      const sep = key.indexOf(':');
      if (sep < 0) continue; // skip malformed keys without type:name separator
      const type = key.slice(0, sep);
      const name = key.slice(sep + 1);
      const invName = meta.invocation_name || deriveInvocationName(name);
      const recMode = meta.recommendation_mode || '';
      const kw = meta.keywords || '';
      const ts = meta.tech_stack || '';
      const uc = meta.use_cases || '';
      update.run(
        meta.intent_tags, meta.domain_tags,
        meta.capability_summary, meta.trigger_patterns,
        invName, invName,
        recMode, recMode,
        kw, kw,
        ts, ts,
        uc, uc,
        type, name
      );
    }
  })();
}

/**
 * Register plugin resources that have no local files (virtual resources).
 * These are skills/agents from other installed plugins that the dispatch
 * system should know about for intelligent recommendation.
 * Only inserts entries that don't already exist in the resources table.
 * @param {Database} rdb Registry database handle
 */
function registerVirtualResources(rdb) {
  const insert = rdb.prepare(`
    INSERT OR IGNORE INTO resources (name, type, status, source, local_path, invocation_name,
      intent_tags, domain_tags, capability_summary, trigger_patterns,
      keywords, tech_stack, use_cases, recommendation_mode,
      created_at, updated_at)
    VALUES (?, ?, 'active', 'preinstalled', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  // Backfill FTS5 fields for existing resources that have empty keywords/tech_stack/use_cases
  const updateFts = rdb.prepare(`
    UPDATE resources SET
      keywords = CASE WHEN (keywords IS NULL OR keywords = '') AND ?1 != '' THEN ?1 ELSE keywords END,
      tech_stack = CASE WHEN (tech_stack IS NULL OR tech_stack = '') AND ?2 != '' THEN ?2 ELSE tech_stack END,
      use_cases = CASE WHEN (use_cases IS NULL OR use_cases = '') AND ?3 != '' THEN ?3 ELSE use_cases END,
      updated_at = datetime('now')
    WHERE type = ?4 AND name = ?5
      AND ((keywords IS NULL OR keywords = '') OR (tech_stack IS NULL OR tech_stack = '') OR (use_cases IS NULL OR use_cases = ''))
  `);

  let count = 0;
  rdb.transaction(() => {
    for (const [key, meta] of Object.entries(RESOURCE_METADATA)) {
      const sep = key.indexOf(':');
      if (sep < 0) continue;
      const type = key.slice(0, sep);
      const name = key.slice(sep + 1);
      const { changes } = insert.run(
        name, type,
        meta.invocation_name || deriveInvocationName(name),
        meta.intent_tags || name.replace(/-/g, ' '),
        meta.domain_tags || '',
        meta.capability_summary || `${type}: ${name.replace(/-/g, ' ')}`,
        meta.trigger_patterns || `when user needs ${name.replace(/-/g, ' ')}`,
        meta.keywords || '',
        meta.tech_stack || '',
        meta.use_cases || '',
        meta.recommendation_mode || 'proactive',
      );
      count += changes;

      // Backfill FTS5 fields for existing resources
      if (changes === 0) {
        updateFts.run(meta.keywords || '', meta.tech_stack || '', meta.use_cases || '', type, name);
      }
    }

    // Backfill keywords from preinstalled tags for resources still missing keywords
    try {
      const backfill = rdb.prepare(`
        UPDATE resources SET keywords = (
          SELECT GROUP_CONCAT(json_each.value, ',')
          FROM preinstalled p, json_each(p.tags)
          WHERE p.type = resources.type AND p.name = resources.name
        )
        WHERE (keywords IS NULL OR keywords = '')
          AND EXISTS (
            SELECT 1 FROM preinstalled p
            WHERE p.type = resources.type AND p.name = resources.name
              AND p.tags != '[]' AND p.tags IS NOT NULL
          )
      `);
      backfill.run();
    } catch {}

    // Backfill invocation_name for resources that still have it empty
    // Derive from name: "parent/child" → "parent:child", otherwise use name as-is
    try {
      const emptyInvoc = rdb.prepare(`
        SELECT id, name FROM resources
        WHERE status = 'active' AND (invocation_name IS NULL OR invocation_name = '')
      `).all();
      if (emptyInvoc.length > 0) {
        const setInvoc = rdb.prepare('UPDATE resources SET invocation_name = ? WHERE id = ?');
        for (const r of emptyInvoc) {
          setInvoc.run(deriveInvocationName(r.name), r.id);
        }
      }
    } catch {}
  })();
  return count;
}

let cmd = process.argv[2];
let flags = new Set(process.argv.slice(3));

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

// Pure JSON-version field bumper for the release pipeline. Reads `filePath`,
// walks `keyPath` (e.g. `['version']` or `['plugins', 0, 'version']`), and
// rewrites only when the new value differs. Returns `{ changed, prev }` so
// callers can log "X → Y" with the captured-before-mutation value — pre-2.63.0
// the plugin.json branch in syncVersions logged "Y → Y" because it read the
// field after assignment.
export function bumpJsonField(filePath, keyPath, newVal) {
  const json = JSON.parse(readFileSync(filePath, 'utf8'));
  let parent = json;
  for (let i = 0; i < keyPath.length - 1; i++) parent = parent?.[keyPath[i]];
  if (!parent) return { changed: false, prev: undefined };
  const lastKey = keyPath[keyPath.length - 1];
  const prev = parent[lastKey];
  if (prev === newVal) return { changed: false, prev };
  parent[lastKey] = newVal;
  writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
  return { changed: true, prev };
}

// Doctor's final summary line. Pure function so the 4-way contract
// (clean / warnings-only / issues / mixed) is unit-testable without spinning
// up the full doctor pipeline. `issues` are ✗-level (action required);
// `warnings` are ⚠-level (informational, "All checks passed!" must NOT lie
// about them).
export function buildDoctorSummary(issues, warnings) {
  const wPlural = warnings === 1 ? '' : 's';
  if (issues === 0 && warnings === 0) return 'All checks passed!';
  if (issues === 0) return `All critical checks passed (${warnings} warning${wPlural}).`;
  const warnSuffix = warnings > 0 ? ` (+${warnings} warning${wPlural})` : '';
  return `${issues} issue(s) found.${warnSuffix}`;
}

// Dev installs symlink server.mjs → the project's source file. Used to suppress
// misleading "first run" messages since hook-update.mjs skips state-writes in
// this mode (see hook-update.mjs isDevMode).
function isDevInstall() {
  try {
    const serverPath = join(INSTALL_DIR, 'server.mjs');
    return existsSync(serverPath) && lstatSync(serverPath).isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── Install ────────────────────────────────────────────────────────────────

async function install() {
  console.log('\nclaude-mem-lite installer\n');

  // 1. Install source files to ~/.claude-mem-lite/
  const IS_DEV = flags.has('--dev');

  // Auto-migrate unhidden dir (~/claude-mem-lite/ → ~/.claude-mem-lite/)
  const oldUnhidden = join(homedir(), 'claude-mem-lite');
  if (!existsSync(DATA_DIR) && existsSync(oldUnhidden)) {
    log('Migrating ~/claude-mem-lite/ → ~/.claude-mem-lite/...');
    renameSync(oldUnhidden, DATA_DIR);
    ok('Directory migrated');
  }

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (IS_DEV) {
    log('Dev mode — creating symlinks in ~/.claude-mem-lite/...');
    // Symlink individual source files
    for (const f of SOURCE_FILES) {
      const target = join(PROJECT_DIR, f);
      const link = join(DATA_DIR, f);
      if (existsSync(target)) {
        // Ensure parent dir exists for subdir entries (e.g. 'lib/activity.mjs')
        const linkParent = dirname(link);
        if (!existsSync(linkParent)) mkdirSync(linkParent, { recursive: true });
        // Remove existing file/symlink before creating
        if (existsSync(link)) try { unlinkSync(link); } catch {}
        symlinkSync(target, link);
      }
    }
    // Symlink scripts/ directory
    const scriptsLink = join(DATA_DIR, 'scripts');
    if (existsSync(scriptsLink)) try { rmSync(scriptsLink, { recursive: true, force: true }); } catch {}
    symlinkSync(join(PROJECT_DIR, 'scripts'), scriptsLink);
    // Symlink node_modules/
    const nmLink = join(DATA_DIR, 'node_modules');
    if (existsSync(nmLink)) try { rmSync(nmLink, { recursive: true, force: true }); } catch {}
    symlinkSync(join(PROJECT_DIR, 'node_modules'), nmLink);
    // Symlink registry/ directory
    const regLink = join(DATA_DIR, 'registry');
    if (existsSync(regLink)) try { rmSync(regLink, { recursive: true, force: true }); } catch {}
    if (existsSync(join(PROJECT_DIR, 'registry'))) {
      symlinkSync(join(PROJECT_DIR, 'registry'), regLink);
    }
    // commands/ is intentionally NOT linked: Claude Code reads slash commands
    // from the plugin cache (~/.claude/plugins/cache/<mp>/<plugin>/<ver>/commands/)
    // or user-level ~/.claude/commands/, never from ~/.claude-mem-lite/commands/.
    // Pre-v2.55 maintained a symlink/copy here that had no consumers.
    ok('Symlinks created in ~/.claude-mem-lite/ → dev dir');
  } else {
    log('Installing to ~/.claude-mem-lite/...');
    const scriptsDir = join(DATA_DIR, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    for (const f of SOURCE_FILES) {
      const src = join(PROJECT_DIR, f);
      const dst = join(DATA_DIR, f);
      if (existsSync(src)) {
        // Ensure parent dir exists for subdir entries (e.g. 'lib/activity.mjs')
        const dstParent = dirname(dst);
        if (!existsSync(dstParent)) mkdirSync(dstParent, { recursive: true });
        copyFileSync(src, dst);
      }
    }
    // Copy hook scripts (settings.json hook commands point at these — must
    // stay in sync with HOOK_SCRIPT_FILES manifest)
    copyHookScripts(join(PROJECT_DIR, 'scripts'), scriptsDir);
    // Ensure bash script is executable
    try { execFileSync('chmod', ['+x', join(scriptsDir, 'post-tool-use.sh')], { stdio: 'pipe' }); } catch {}
    // commands/ is intentionally NOT copied — see dev-mode branch above.
    // Copy registry manifest
    const registryDir = join(DATA_DIR, 'registry');
    if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
    const manifestSrc = join(PROJECT_DIR, 'registry', 'preinstalled.json');
    if (existsSync(manifestSrc)) copyFileSync(manifestSrc, join(registryDir, 'preinstalled.json'));
    ok('Source files copied to ~/.claude-mem-lite/');

    // v2.48 P1-4: prune stale top-level .mjs + 0-byte .db files left behind by
    // prior upgrades (e.g. dispatch.mjs removed in v2.20.0, zero-byte mem.db /
    // memory.db / registry.db from pre-consolidation installs). Subdirs +
    // symlinks + non-empty DBs are always preserved.
    try {
      const pruned = pruneStaleInstallFiles(DATA_DIR, SOURCE_FILES);
      if (pruned.length > 0) {
        ok(`Pruned ${pruned.length} stale file(s): ${pruned.map(p => p.split('/').pop()).join(', ')}`);
      }
    } catch (e) { /* prune is best-effort — never block install */ void e; }
  }

  // 2. npm install (skip for --dev: node_modules is symlinked)
  if (IS_DEV) {
    ok('Dependencies: using dev dir (symlinked)');
  } else {
    log('Ensuring dependencies installed...');
    try {
      // stderr inherited so users see real-time progress (network slowness,
      // node-gyp compile spinner, prebuild-install fallback messages). With
      // `stdio: 'pipe'` the install appeared to hang under the 5-min Bash
      // timeout when better-sqlite3 had no Node v24 prebuild and had to
      // compile from source — see bug audit 2026-05.
      execSync(NPM_INSTALL_CMD, { cwd: INSTALL_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
      ok('Dependencies installed');
    } catch (e) {
      fail('npm install failed: ' + e.message);
      process.exit(1);
    }
    // npm install exits 0 even when the better-sqlite3 prebuilt .node binary
    // mismatches the running Node ABI (e.g. NODE_MODULE_VERSION 137 on Node v24).
    // Probe and auto-rebuild before declaring success — otherwise the next
    // launch FATALs with "Could not locate the bindings file".
    const verify = await ensureBetterSqlite3Working(INSTALL_DIR);
    if (verify.ok) {
      ok(`better-sqlite3: ${verify.action}`);
    } else {
      fail(`better-sqlite3 binding unusable after rebuild: ${verify.error}`);
      log('Try manually: cd ' + INSTALL_DIR + ' && npm rebuild better-sqlite3 --build-from-source');
      process.exit(1);
    }
  }

  // 2b. Create global CLI symlink (claude-mem-lite command)
  const cliSource = join(INSTALL_DIR, 'cli.mjs');
  if (existsSync(cliSource)) {
    try { execFileSync('chmod', ['+x', cliSource], { stdio: 'pipe' }); } catch {}
    // Try ~/.local/bin first (user-writable, commonly on PATH)
    const localBin = join(homedir(), '.local', 'bin');
    const cliLink = join(localBin, 'claude-mem-lite');
    try {
      if (!existsSync(localBin)) mkdirSync(localBin, { recursive: true });
      if (existsSync(cliLink)) unlinkSync(cliLink);
      symlinkSync(cliSource, cliLink);
      ok(`CLI: ${cliLink} → ${cliSource}`);
    } catch {
      // Fallback: try /usr/local/bin (may need sudo)
      try {
        const globalLink = '/usr/local/bin/claude-mem-lite';
        if (existsSync(globalLink)) unlinkSync(globalLink);
        symlinkSync(cliSource, globalLink);
        ok(`CLI: ${globalLink} → ${cliSource}`);
      } catch {
        warn('CLI symlink failed — run manually: ln -sf ' + cliSource + ' ~/.local/bin/claude-mem-lite');
      }
    }
  }

  // 3. Register MCP server (skip if plugin system already handles it)
  // Plugin MCP must stay at root .mcp.json so Claude Code registers plugin:*:mem-lite.
  // Duplicate registrations in practice come from old global install.mjs state
  // (claude mcp add) or stale marketplace copies, not from the cache root itself.
  // Global registration via `claude mcp add` creates a DUPLICATE mcp__mem-lite__* server.
  // The legacy generic name "mem" (pre-v2.78) is also purged so a user who installed in
  // either era ends up with a single canonical "mem-lite" registration.
  // Detect plugin mode: installed_plugins.json has our entry → plugin handles MCP.
  const installedPluginsPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let pluginHandlesMcp = false;
  try {
    const installed = JSON.parse(readFileSync(installedPluginsPath, 'utf8'));
    pluginHandlesMcp = !!installed?.plugins?.[PLUGIN_KEY]?.length;
  } catch { /* not installed via plugin system */ }

  if (pluginHandlesMcp) {
    log('MCP server: plugin system handles registration (skipping global)');
    // Clean up stale global registrations (both legacy "mem" and current "mem-lite")
    for (const name of ['mem', 'mem-lite']) {
      try {
        execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], { stdio: 'pipe' });
        ok(`Removed stale global MCP "${name}"`);
      } catch {}
    }
  } else {
    log('Registering MCP server...');
    try {
      // Purge legacy "mem" and any pre-existing "mem-lite" before re-registering
      for (const name of ['mem', 'mem-lite']) {
        try { execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], { stdio: 'pipe' }); } catch {}
        try { execFileSync('claude', ['mcp', 'remove', '-s', 'project', name], { stdio: 'pipe' }); } catch {}
      }
      execFileSync('claude', ['mcp', 'add', '-s', 'user', '-t', 'stdio', 'mem-lite', '--', 'node', SERVER_PATH], { stdio: 'pipe' });
      ok('MCP server registered: mem-lite');
    } catch (e) {
      fail('MCP registration failed: ' + e.message);
      warn('Try manually: claude mcp add -s user -t stdio mem-lite -- node ' + SERVER_PATH);
    }
  }

  // 3b. Deduplicate: if marketplace plugin also registers MCP + hooks,
  // clear them to prevent double execution. install.mjs hooks (in settings.json)
  // point to ~/.claude-mem-lite/ (latest code in dev mode via symlinks),
  // while plugin hooks use ${CLAUDE_PLUGIN_ROOT} (potentially stale marketplace copy).
  //
  // MCP dedup: Claude Code copies .mcp.json from marketplace clone → plugin cache.
  // Do NOT modify marketplace .mcp.json — it breaks the MCP server registration chain.
  // Dedup is handled by skipping global `claude mcp add` when plugin system is active.
  const pluginDir = join(homedir(), '.claude', 'plugins', 'marketplaces', MARKETPLACE_KEY);
  const pluginHooksPath = join(pluginDir, 'hooks', 'hooks.json');

  if (existsSync(pluginDir)) {
    // NOTE: Do NOT clear marketplace .mcp.json — Claude Code copies from
    // marketplace clone → plugin cache on updates. Clearing it causes the
    // cache .mcp.json to lose the MCP server definition, breaking plugin MCP.
    // Dedup is already handled by skipping global `claude mcp add` above.

    // Clear plugin hooks to prevent double hook execution
    try {
      if (existsSync(pluginHooksPath)) {
        const pluginHooks = JSON.parse(readFileSync(pluginHooksPath, 'utf8'));
        if (pluginHooks.hooks && Object.keys(pluginHooks.hooks).length > 0) {
          writeFileSync(pluginHooksPath, JSON.stringify({
            description: pluginHooks.description || 'claude-mem-lite hooks',
            _note: 'Hooks managed by install.mjs in settings.json — this file cleared to prevent duplicates',
            hooks: {}
          }, null, 2) + '\n');
          ok('Marketplace plugin: hooks cleared (prevents duplicate)');
        }
      }
    } catch (e) { warn(`Marketplace hooks dedup: ${e.message}`); }

    // Sync launch.mjs to plugin cache — ensures MCP server loads dev code via symlink detection.
    // ALSO clear cached hooks.json in every version dir — Claude Code runtime reads hooks from
    // ~/.claude/plugins/cache/<mp>/<plugin>/<ver>/hooks/hooks.json, NOT from the marketplace source.
    // Clearing only the marketplace source (above) leaves stale cache copies that double-register
    // hooks alongside install.mjs-written settings.json entries.
    try {
      const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_KEY, 'claude-mem-lite');
      if (existsSync(cacheBase)) {
        const launchSyncFiles = ['launch.mjs', 'launch-preflight.mjs'];
        let clearedHooks = 0;
        for (const ver of readdirSync(cacheBase)) {
          const verDir = join(cacheBase, ver);

          // Sync launch.mjs + its preflight companion (issue #15)
          if (existsSync(join(verDir, 'scripts'))) {
            for (const f of launchSyncFiles) {
              const src = join(PROJECT_DIR, 'scripts', f);
              if (existsSync(src)) {
                try { copyFileSync(src, join(verDir, 'scripts', f)); } catch { /* keep going */ }
              }
            }
          }

          // Clear cached hooks.json (runtime reads here, not marketplace source)
          const cachedHooksPath = join(verDir, 'hooks', 'hooks.json');
          if (existsSync(cachedHooksPath)) {
            try {
              const h = JSON.parse(readFileSync(cachedHooksPath, 'utf8'));
              if (h.hooks && Object.keys(h.hooks).length > 0) {
                writeFileSync(cachedHooksPath, JSON.stringify({
                  description: h.description || 'claude-mem-lite hooks',
                  _note: `Hooks managed by install.mjs in settings.json — cache hooks.json cleared to prevent duplicate registration (cache ver: ${ver})`,
                  hooks: {}
                }, null, 2) + '\n');
                clearedHooks++;
              }
            } catch { /* silent — never block install on one bad cache entry */ }
          }
        }
        const parts = ['launch.mjs synced (dev mode MCP routing)'];
        if (clearedHooks > 0) parts.push(`${clearedHooks} stale hooks.json cleared`);
        ok(`Plugin cache: ${parts.join('; ')}`);
      }
    } catch (e) { warn(`Plugin cache sync: ${e.message}`); }
  }

  // 4. Configure hooks (merge: preserve user's existing hooks, replace ours)
  log('Configuring hooks...');
  const settings = readSettings();
  if (clearPluginDisabledMarkerForDirectInstall(settings)) {
    ok('Cleared stale disabled plugin flag so install.mjs-managed hooks can run');
  }
  settings.hooks = settings.hooks || {};

  const PREFILTER_PATH = join(INSTALL_DIR, 'scripts', 'post-tool-use.sh');

  const memPostToolUse = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `bash "${PREFILTER_PATH}"`,
      timeout: 5
    }]
  };

  const memSessionStart = {
    matcher: 'startup|clear|compact',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" session-start`,
      timeout: 10
    }]
  };

  const memStop = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" stop`,
      timeout: 5
    }]
  };

  const SCRIPTS_PATH = join(INSTALL_DIR, 'scripts');

  const memUserPrompt = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `node "${join(SCRIPTS_PATH, 'user-prompt-search.js')}"`,
        timeout: 2
      },
      {
        type: 'command',
        command: `node "${HOOK_PATH}" user-prompt`,
        timeout: 5
      }
    ]
  };

  const memPreToolRecall = {
    // v2.34.6: Read added to cover planning-Read (pre-Edit exploration).
    // Read-path uses a tighter filter (lesson_learned required, top-1,
    // 120-char truncation, silent-on-empty) — see scripts/pre-tool-recall.js.
    matcher: 'Edit|Write|NotebookEdit|Read',
    hooks: [
      {
        type: 'command',
        command: `node "${join(SCRIPTS_PATH, 'pre-tool-recall.js')}"`,
        timeout: 3
      }
    ]
  };

  const memPreSkillBridge = {
    matcher: 'Skill',
    hooks: [
      {
        type: 'command',
        command: `node "${join(SCRIPTS_PATH, 'pre-skill-bridge.js')}"`,
        timeout: 3
      }
    ]
  };

  // Filter out existing mem hooks, then append fresh ones
  // PreToolUse has two separate matchers, so we register both
  const hookConfigs = {
    PreToolUse: [memPreToolRecall, memPreSkillBridge],
    PostToolUse: [memPostToolUse],
    SessionStart: [memSessionStart],
    Stop: [memStop],
    UserPromptSubmit: [memUserPrompt],
  };

  for (const [event, configs] of Object.entries(hookConfigs)) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event].filter(cfg => !isMemHook(cfg)) : [];
    settings.hooks[event] = [...existing, ...configs];
  }

  writeSettings(settings);
  ok('Hooks configured (PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit)');

  // 5. Legacy ~/.claude-mem/ → ~/.claude-mem-lite/ — back up, don't reuse.
  // The legacy DB is schema v16 (schema_versions plural) and there's no
  // bridge in MIGRATIONS[] to v28. Reusing it FATALs on first launch with
  // "no such column: memory_session_id". Rename to a timestamped backup
  // so the new install creates a fresh v28 DB.
  try {
    const r = migrateLegacyClaudeMemData(OLD_DATA_DIR, DATA_DIR);
    if (r.action === 'backed-up') {
      ok(`Legacy ~/.claude-mem/ DB backed up to ${r.backupPath}`);
      log('New v28 DB will be created on first launch (legacy schema is incompatible).');
    }
  } catch (e) {
    warn('Legacy DB backup failed: ' + e.message);
  }

  // 5b. Rename claude-mem.db → claude-mem-lite.db in same directory
  const oldDbInDir = join(DATA_DIR, 'claude-mem.db');
  if (existsSync(oldDbInDir) && !existsSync(DB_PATH)) {
    renameSync(oldDbInDir, DB_PATH);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(oldDbInDir + ext)) try { renameSync(oldDbInDir + ext, DB_PATH + ext); } catch {}
    }
    ok('Database renamed: claude-mem.db → claude-mem-lite.db');
  }

  // 6. Install pre-installed resources (skills + agents)
  if (process.env.CLAUDE_MEM_SKIP_REPOS) {
    ok('Skill/agent registry: skipped (CLAUDE_MEM_SKIP_REPOS)');
  } else try {
    const manifestPath = join(INSTALL_DIR, 'registry', 'preinstalled.json');
    if (!existsSync(manifestPath)) {
      // For git-clone mode, check PROJECT_DIR
      const altPath = join(PROJECT_DIR, 'registry', 'preinstalled.json');
      if (existsSync(altPath)) {
        const registryDir = join(INSTALL_DIR, 'registry');
        if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
        copyFileSync(altPath, manifestPath);
      }
    }

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const resources = manifest.resources || [];

      if (resources.length > 0) {
        const managedDir = join(DATA_DIR, 'managed');

        // 6a. Git shallow clone unique repos
        const repos = new Map();
        for (const r of resources) {
          if (!repos.has(r.repo)) repos.set(r.repo, []);
          repos.get(r.repo).push(r);
        }

        let cloned = 0, updated = 0;
        const deadRepos = new Set(); // repos that no longer exist (404)

        const isRepoNotFound = (err) => {
          const msg = (err?.stderr ? err.stderr.toString() : '') + (err?.message || '');
          return /repository.*not found|404/i.test(msg);
        };

        for (const [repoUrl, entries] of repos) {
          const repoName = repoUrl.split('/').slice(-2).join('-').replace(/[^a-zA-Z0-9._-]/g, '_');
          const clonePath = join(managedDir, 'repos', repoName);
          let repoReady = false;

          if (!existsSync(clonePath)) {
            // Fresh clone
            try {
              mkdirSync(join(managedDir, 'repos'), { recursive: true });
              execFileSync('git', ['clone', '--depth', '1', `${repoUrl.replace(/\.git$/, '')}.git`, clonePath], { stdio: 'pipe', timeout: 30000 });
              cloned++;
              repoReady = true;
            } catch (err) {
              if (isRepoNotFound(err)) {
                deadRepos.add(repoUrl);
                warn(`  Repo not found (removed?): ${repoUrl}`);
              } else {
                warn(`  Clone failed: ${repoUrl}`);
              }
              continue;
            }
          } else {
            // Update existing: fetch latest and fast-forward
            try {
              const localHash = execFileSync('git', ['-C', clonePath, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
              execFileSync('git', ['-C', clonePath, 'fetch', '--depth', '1', 'origin'], { stdio: 'pipe', timeout: 30000 });
              const remoteHash = execFileSync('git', ['-C', clonePath, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
              if (localHash !== remoteHash) {
                execFileSync('git', ['-C', clonePath, 'reset', '--hard', 'FETCH_HEAD'], { stdio: 'pipe' });
                updated++;
                repoReady = true; // needs re-copy
              }
            } catch (err) {
              if (isRepoNotFound(err)) {
                deadRepos.add(repoUrl);
                warn(`  Repo not found (removed?): ${repoUrl} — cleaning up`);
                // Remove local clone
                try { rmSync(clonePath, { recursive: true, force: true }); } catch {}
                // Remove extracted resources
                for (const entry of entries) {
                  const destDir = join(managedDir, entry.type === 'skill' ? 'skills' : 'agents');
                  const destPath = join(destDir, entry.name);
                  try { if (existsSync(destPath)) rmSync(destPath, { recursive: true, force: true }); } catch {}
                }
                continue;
              }
              // Transient failure — use existing clone as-is
            }
          }

          // Copy resources to managed/skills/ or managed/agents/
          // Re-copy if repo was freshly cloned or updated
          mkdirSync(join(managedDir, 'skills'), { recursive: true });
          mkdirSync(join(managedDir, 'agents'), { recursive: true });
          for (const entry of entries) {
            // Path traversal guard: reject entries with '..' or absolute paths
            if (entry.path.includes('..') || entry.name.includes('..') ||
                isAbsolute(entry.path) || isAbsolute(entry.name)) continue;
            const srcPath = entry.path === '.' ? clonePath : join(clonePath, entry.path);
            const destDir = join(managedDir, entry.type === 'skill' ? 'skills' : 'agents');
            const destPath = join(destDir, entry.name);
            if (existsSync(srcPath) && (repoReady || !existsSync(destPath))) {
              try {
                if (existsSync(destPath)) rmSync(destPath, { recursive: true, force: true });
                cpSync(srcPath, destPath, { recursive: true });
              } catch {}
            }
          }
        }
        ok(`Repos: ${cloned} cloned, ${updated} updated, ${repos.size - deadRepos.size} active` +
           (deadRepos.size > 0 ? `, ${deadRepos.size} dead removed` : ''));

        // 6b. Init registry DB and record preinstalled entries
        const { ensureRegistryDb } = await import('./registry.mjs');
        const regDbPath = join(DATA_DIR, 'resource-registry.db');
        const rdb = ensureRegistryDb(regDbPath);

        const insertPre = rdb.prepare(`
          INSERT OR REPLACE INTO preinstalled (name, type, repo_url, repo_path, tags, enabled)
          VALUES (?, ?, ?, ?, ?, 1)
        `);
        const activeResources = deadRepos.size > 0
          ? resources.filter(r => !deadRepos.has(r.repo))
          : resources;
        for (const r of activeResources) {
          insertPre.run(r.name, r.type, r.repo, r.path, JSON.stringify(r.tags || []));
        }

        // Clean up DB entries for dead repos
        if (deadRepos.size > 0) {
          const delPre = rdb.prepare('DELETE FROM preinstalled WHERE repo_url = ?');
          const delRes = rdb.prepare('DELETE FROM resources WHERE repo_url = ?');
          for (const deadUrl of deadRepos) {
            try { delPre.run(deadUrl); } catch {}
            try { delRes.run(deadUrl); } catch {}
          }
        }
        ok(`Registry DB initialized (${activeResources.length} preinstalled entries` +
           (deadRepos.size > 0 ? `, ${deadRepos.size} dead repos purged` : '') + ')');

        // 6c. Fetch GitHub stars (best-effort, unauthenticated)
        log('  Fetching GitHub stars...');
        const starCache = new Map();
        for (const [repoUrl] of repos) {
          if (deadRepos.has(repoUrl)) continue;
          const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
          if (match) {
            try {
              const apiUrl = `https://api.github.com/repos/${match[1]}/${match[2]}`;
              const res = execFileSync('curl', ['-sf', apiUrl], { encoding: 'utf8', timeout: 10000 });
              const data = JSON.parse(res);
              if (typeof data.stargazers_count === 'number') {
                starCache.set(repoUrl, data.stargazers_count);
              }
            } catch {}
          }
        }
        if (starCache.size > 0) ok(`Stars fetched (${starCache.size}/${repos.size} repos)`);

        // 6d. Scan and index resources (fallback-only, Haiku indexing deferred to first run)
        log('  Scanning resources...');
        const { scanAllResources, diffResources } = await import('./registry-scanner.mjs');
        const scanned = scanAllResources({ dataDir: DATA_DIR });

        // Attach star counts and repo URLs
        for (const s of scanned) {
          const entry = resources.find(r => r.name === s.name && r.type === s.type);
          if (entry) {
            s.repoUrl = entry.repo;
            s.repoStars = starCache.get(entry.repo) || 0;
          }
        }

        const { toIndex } = diffResources(rdb, scanned);
        if (toIndex.length > 0) {
          // Use fallback indexing at install time (no Haiku calls)
          // Full Haiku indexing happens on first SessionStart
          const { upsertResource } = await import('./registry.mjs');
          for (const res of toIndex) {
            try {
              const metaKey = `${res.type}:${res.name}`;
              const meta = RESOURCE_METADATA[metaKey];
              upsertResource(rdb, {
                name: res.name,
                type: res.type,
                status: 'active',
                source: res.source,
                repo_url: res.repoUrl || null,
                repo_stars: res.repoStars || 0,
                local_path: res.localPath,
                file_hash: res.fileHash,
                invocation_name: meta?.invocation_name || deriveInvocationName(res.name),
                intent_tags: meta?.intent_tags || res.name.replace(/-/g, ' '),
                domain_tags: meta?.domain_tags || '',
                trigger_patterns: meta?.trigger_patterns || `when user needs ${res.name.replace(/-/g, ' ')}`,
                capability_summary: meta?.capability_summary || `${res.type}: ${res.name.replace(/-/g, ' ')}`,
              });
            } catch {}
          }
          ok(`Resources registered: ${toIndex.length} indexed`);
        }

        // Apply curated metadata to all known resources (fixes existing installs)
        reindexKnownResources(rdb);
        ok('Resource metadata curated (FTS5 reindexed)');

        // Register plugin resources (skills/agents from other plugins, no local files)
        const virtualCount = registerVirtualResources(rdb);
        if (virtualCount > 0) ok(`Plugin resources registered: ${virtualCount} virtual entries`);

        rdb.close();
      }
    } else {
      log('  No preinstalled manifest found, skipping');
    }
  } catch (e) {
    warn('Resource setup: ' + e.message);
    log('  Skills/agents will be indexed on first use');
  }

  // 7. Verify database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const count = db.prepare('SELECT COUNT(*) as c FROM observations').get();
      db.close();
      ok(`Database accessible: ${count.c} observations`);
    } catch (e) {
      warn('Database check failed: ' + e.message);
    }
  } else {
    log('No existing database — will be created on first use');
  }

  // 7b. Dogfood auto-adopt (invited-memory, Phase C T13).
  // Only fires when install.mjs is running from the claude-mem-lite source repo
  // itself (detected via git remote match). In npm/npx flows PROJECT_DIR is a
  // cache dir with no git metadata, so this is a no-op for end users.
  // --no-adopt override respected.
  if (!flags.has('--no-adopt')) {
    try {
      const remote = execFileSync('git', ['-C', PROJECT_DIR, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: 'pipe' }).trim();
      const isDogfood = /github\.com[:/]sdsrss\/claude-mem-lite(\.git)?$/i.test(remote);
      if (isDogfood) {
        const { cmdAdopt } = await import('./adopt-cli.mjs');
        cmdAdopt([]);
        ok('Invited-memory: auto-adopt for claude-mem-lite dogfood repo');
      }
    } catch {
      // Not a git repo, or git missing — silent skip (this is the normal npm path).
    }
  }

  // 8. Disable old claude-mem plugin
  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    settings.enabledPlugins['claude-mem@thedotmack'] = false;
    writeSettings(settings);
    ok('Old claude-mem plugin disabled');
  }

  // 9. Offer to clean old vector-db
  const vectorDbPath = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDbPath)) {
    try {
      const size = execFileSync('du', ['-sh', vectorDbPath], { encoding: 'utf8' }).trim().split('\t')[0];
      warn(`Old vector-db exists (${size}). Run: rm -rf ~/.claude-mem/vector-db/`);
    } catch {}
  }

  console.log('\n  Done! Restart Claude Code to activate.\n');
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

async function uninstall() {
  console.log('\nclaude-mem-lite uninstaller\n');

  // 1. Remove MCP (legacy hook-based install).
  // Try both the legacy "mem" (pre-v2.78) and current "mem-lite" names so a user
  // who installed in either era ends up clean.
  let removedAny = false;
  for (const name of ['mem', 'mem-lite']) {
    try {
      execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], { stdio: 'pipe' });
      ok(`MCP server removed: ${name}`);
      removedAny = true;
    } catch {}
  }
  if (!removedAny) warn('MCP server not found or already removed');

  // 1b. Remove CLI symlink
  for (const binDir of [join(homedir(), '.local', 'bin'), '/usr/local/bin']) {
    const cliLink = join(binDir, 'claude-mem-lite');
    try {
      if (existsSync(cliLink)) { unlinkSync(cliLink); ok(`CLI symlink removed: ${cliLink}`); }
    } catch { /* may not have permissions */ }
  }

  // 2. Remove hooks from settings.json (match both npx and git-clone install paths)
  const settings = readSettings();
  cleanupMemHooksFromSettings(settings);

  // 2b. Uninstall does NOT auto-unadopt — an adopted project may be in active use
  // by the user in other Claude Code sessions. Tell them the command instead.
  log('Invited-memory: adopt state preserved. Run `claude-mem-lite unadopt --all` to remove sentinel sections.');

  // 3. Clean plugin registry entries conservatively (avoid deleting other plugins
  // from the same marketplace publisher)
  const pluginsDir = join(homedir(), '.claude', 'plugins');
  const installedPath = join(pluginsDir, 'installed_plugins.json');
  let canRemoveMarketplaceArtifacts;
  try {
    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    const plugins = getInstalledPluginEntries(installed);
    let cleaned = false;
    if (PLUGIN_KEY in plugins) {
      delete plugins[PLUGIN_KEY];
      cleaned = true;
    }
    canRemoveMarketplaceArtifacts = !hasOtherMarketplacePlugins(installed);
    if (cleaned) {
      writeFileSync(installedPath, JSON.stringify(installed, null, 2) + '\n');
      ok('Removed from installed_plugins.json');
    }
  } catch {
    // Conservative default: if registry shape is unknown, preserve marketplace cache.
    canRemoveMarketplaceArtifacts = false;
  }

  // 4. Clean plugin system entries from settings.json
  const marketplaceKey = MARKETPLACE_KEY;
  if (settings.enabledPlugins) {
    delete settings.enabledPlugins[PLUGIN_KEY];
  }
  if (settings.extraKnownMarketplaces && canRemoveMarketplaceArtifacts) {
    delete settings.extraKnownMarketplaces[marketplaceKey];
  }
  writeSettings(settings);
  ok('Hooks and plugin settings cleaned');

  // 5. Clean plugin system registry files (only if no other marketplace plugins remain)
  const marketplaceDir = join(pluginsDir, 'marketplaces', marketplaceKey);
  if (canRemoveMarketplaceArtifacts && existsSync(marketplaceDir)) {
    rmSync(marketplaceDir, { recursive: true, force: true });
    ok('Marketplace directory removed');
  }

  // 5b. Remove cache directory
  const cacheDir = join(pluginsDir, 'cache', marketplaceKey);
  if (canRemoveMarketplaceArtifacts && existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
    ok('Plugin cache removed');
  }

  // 5c. Clean known_marketplaces.json
  const knownPath = join(pluginsDir, 'known_marketplaces.json');
  try {
    const known = JSON.parse(readFileSync(knownPath, 'utf8'));
    if (canRemoveMarketplaceArtifacts && marketplaceKey in known) {
      delete known[marketplaceKey];
      writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n');
      ok('Removed from known_marketplaces.json');
    }
  } catch { /* file may not exist */ }

  if (!canRemoveMarketplaceArtifacts && (existsSync(marketplaceDir) || existsSync(cacheDir))) {
    log('Marketplace cache preserved (other plugins may still depend on sdsrss marketplace)');
  }

  // 6. Purge data if requested
  if (flags.has('--purge')) {
    const expectedPurgePath = join(homedir(), '.claude-mem-lite');
    if (existsSync(DATA_DIR) && DATA_DIR === expectedPurgePath) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      ok('Data purged (~/.claude-mem-lite/)');
    } else if (existsSync(DATA_DIR)) {
      fail('DATA_DIR path mismatch, refusing to purge for safety: ' + DATA_DIR);
    }
  } else {
    log('Data preserved in ~/.claude-mem-lite/ (use --purge to remove)');
  }

  console.log('\n  Done!\n');
}

// ─── Cleanup Hooks ───────────────────────────────────────────────────────────

async function cleanupHooks() {
  console.log('\nclaude-mem-lite cleanup-hooks\n');

  const settings = readSettings();
  const removed = cleanupMemHooksFromSettings(settings);

  if (removed > 0) {
    writeSettings(settings);
    ok(`Removed ${removed} claude-mem-lite hook configuration${removed === 1 ? '' : 's'} from settings.json`);
  } else {
    ok('No claude-mem-lite hooks found in settings.json');
  }

  console.log('');
}

// ─── Status ─────────────────────────────────────────────────────────────────

async function status() {
  // Dogfood-8: support --json so CI / setup scripts can probe install state
  // without scraping text. Collect each check as a structured record first,
  // then print text OR JSON. Text path keeps identical wording so existing
  // users / docs / screenshots stay correct.
  const json = flags.has('--json');
  const checks = [];
  const push = (level, key, message, extra = {}) => checks.push({ level, key, message, ...extra });

  // MCP
  try {
    const list = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
    // Accept either the current "mem-lite" registration or the legacy "mem"
    // name (pre-v2.78) so a user mid-upgrade still sees a green status until
    // setup.sh / install.mjs purges the legacy entry on next run.
    // v2.79.1: dropped a `/\bmem\b\s/` fallback regex — the `\b` word boundary
    // also matched "mem-lite" (because `-` is a non-word char), so the regex
    // was always-true noise (benign only because the mem-lite checks short-
    // circuited first). `claude mcp list` formats as `<name>: <command>`, so
    // the two colon-form checks below cover every shape.
    const registered = list.includes('mem-lite:') || list.includes('mem:');
    push(registered ? 'ok' : 'fail', 'mcp', registered ? 'MCP server: registered' : 'MCP server: not registered', { registered });
  } catch {
    push('warn', 'mcp', 'Could not check MCP status', { registered: null });
  }

  // Hooks
  const settings = readSettings();
  const hasHooks = hasMemHooksConfigured(settings);
  const pluginDisabled = isPluginExplicitlyDisabled(settings);
  const pluginEnabled = settings.enabledPlugins?.[PLUGIN_KEY] === true;

  if (pluginEnabled) push('ok', 'plugin', 'Plugin: enabled in settings', { enabled: true, disabled: false });
  else if (pluginDisabled) push('warn', 'plugin', 'Plugin: disabled in settings', { enabled: false, disabled: true });
  else push('warn', 'plugin', 'Plugin: not present in enabledPlugins', { enabled: false, disabled: false });

  if (hasHooks && pluginDisabled) {
    push('warn', 'hooks', 'Hooks: still configured in settings.json while plugin is disabled (runtime ignores them; run cleanup-hooks or uninstall to clean up)', { configured: true });
  } else if (hasHooks) {
    push('ok', 'hooks', 'Hooks: configured', { configured: true });
  } else if (pluginDisabled) {
    push('ok', 'hooks', 'Hooks: not configured', { configured: false });
  } else {
    push('fail', 'hooks', 'Hooks: not configured', { configured: false });
  }

  // Plugin cache pollution: populated hooks.json in cache AND install.mjs-managed
  // settings.json hooks → runtime registers both → duplicate firing.
  const polluted = scanPluginCacheHookPollution();
  if (polluted.length > 0 && hasHooks) {
    push('fail', 'plugin_cache', `Plugin cache: stale hooks.json in version(s) ${polluted.join(', ')} — duplicate firing alongside settings.json (run 'install' to auto-clear)`, { polluted_versions: polluted });
  } else if (polluted.length > 0) {
    push('ok', 'plugin_cache', `Plugin cache: ${polluted.length} version(s) with hooks.json (plugin-only mode)`, { polluted_versions: polluted });
  } else if (pluginEnabled || hasHooks) {
    push('ok', 'plugin_cache', 'Plugin cache: no stale hooks.json (no duplicate firing)', { polluted_versions: [] });
  }

  // Database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const obs = db.prepare('SELECT COUNT(*) as c FROM observations').get();
      const sess = db.prepare('SELECT COUNT(*) as c FROM session_summaries').get();
      db.close();
      push('ok', 'database', `Database: ${obs.c} observations, ${sess.c} sessions`, { exists: true, observations: obs.c, sessions: sess.c });
    } catch (e) {
      push('warn', 'database', 'Database: exists but check failed — ' + e.message, { exists: true, error: e.message });
    }
  } else {
    push('warn', 'database', 'Database: not found', { exists: false });
  }

  // CLI
  try {
    execFileSync('claude-mem-lite', ['--help'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    push('ok', 'cli', 'CLI: claude-mem-lite command available', { available: true });
  } catch {
    push('warn', 'cli', 'CLI: command not on PATH — run install again to create symlink', { available: false });
  }

  // Old system
  const vectorDb = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDb)) {
    push('warn', 'old_data', 'Old vector-db still exists (can be removed)', { vector_db_exists: true });
  }

  if (json) {
    const out = {};
    for (const c of checks) {
      const { level, key, message, ...extra } = c;
      out[key] = { level, message, ...extra };
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('\nclaude-mem-lite status\n');
  for (const c of checks) {
    if (c.level === 'ok') ok(c.message);
    else if (c.level === 'warn') warn(c.message);
    else fail(c.message);
  }
  console.log('');
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

async function doctor() {
  // Dogfood-9: structured --json output for CI / wrapper scripts that want to
  // act on individual checks (e.g. "fail my deploy if FTS5 integrity not ok").
  // Implementation strategy: shadow ok/warn/fail/log inside doctor() so every
  // existing call site automatically captures into `checks`, and route final
  // output to JSON or text. Mirror install.mjs::status() shape — { key: {...} }
  // would lose ordering, so use a flat array of { level, message } objects
  // (doctor checks are ordered by significance: deps → server → DB → drift).
  const json = flags.has('--json');
  const checks = [];
  if (!json) console.log('\nclaude-mem-lite doctor\n');

  // Shadow file-level helpers so every call site auto-records.
  const ok   = (msg) => { checks.push({ level: 'ok',   message: msg }); if (!json) console.log(`  ✓ ${msg}`); };
  const warn = (msg) => { checks.push({ level: 'warn', message: msg }); if (!json) console.log(`  ⚠ ${msg}`); };
  const fail = (msg) => { checks.push({ level: 'fail', message: msg }); if (!json) console.log(`  ✗ ${msg}`); };
  const log  = (msg) => { if (!json) console.log(`  ${msg}`); };

  let issues = 0;
  let warnings = 0;
  // Doctor-local ⚠ helper: visually identical to the file-level `warn`, but
  // bumps `warnings` so the summary line can distinguish "fully green" from
  // "warnings present". Used for informational ⚠ checks; the two ⚠ paths
  // that ALSO bump `issues` (stale procs, dev drift) keep using the file-level
  // `warn` directly to avoid double-counting.
  const dwarn = (msg) => { warnings++; warn(msg); };

  // Node version
  const nodeVer = process.version;
  if (parseInt(nodeVer.slice(1)) >= 18) {
    ok(`Node.js: ${nodeVer}`);
  } else {
    fail(`Node.js ${nodeVer} too old (need >=18)`);
    issues++;
  }

  // Dependencies
  try {
    const Database = (await import('better-sqlite3')).default;
    const probe = new Database(':memory:');
    probe.close();
    ok('better-sqlite3: verified (import + open OK)');
  } catch (e) {
    fail(`better-sqlite3: import/init failed (${e.message})`);
    issues++;
  }

  try {
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    ok('@modelcontextprotocol/sdk: verified (import OK)');
  } catch (e) {
    fail(`@modelcontextprotocol/sdk: import failed (${e.message})`);
    issues++;
  }

  // Server file
  if (existsSync(SERVER_PATH)) {
    ok(`server.mjs: ${SERVER_PATH}`);
  } else {
    fail('server.mjs: missing');
    issues++;
  }

  // Hook file
  if (existsSync(HOOK_PATH)) {
    ok(`hook.mjs: ${HOOK_PATH}`);
  } else {
    fail('hook.mjs: missing');
    issues++;
  }

  // Plugin/hook lifecycle state
  const settings = readSettings();
  const hasHooks = hasMemHooksConfigured(settings);
  const pluginDisabled = isPluginExplicitlyDisabled(settings);
  if (pluginDisabled && hasHooks) {
    fail('Plugin lifecycle: plugin is disabled but claude-mem-lite hooks still remain in settings.json');
    issues++;
  } else if (pluginDisabled) {
    ok('Plugin lifecycle: disabled cleanly (no active mem hooks)');
  } else if (hasHooks) {
    ok('Plugin lifecycle: hooks active');
  } else {
    dwarn('Plugin lifecycle: hooks not configured');
  }

  // Orphan hooks: settings.json entries referencing hook files that no longer
  // exist on disk. Trips when a user runs `/plugin uninstall` and/or
  // `rm -rf ~/.claude-mem-lite/` without first running `claude-mem-lite uninstall`
  // (which clears the settings.json entries). The hooks keep firing and exit
  // with require-error noise every session. README's Uninstall section warns
  // about the right ordering; this check flags the broken state so it surfaces
  // even when the user skipped the README.
  const orphanPaths = collectOrphanHookPaths(settings);
  if (orphanPaths.length > 0) {
    fail(`Orphan hooks: ${orphanPaths.length} settings.json entr${orphanPaths.length === 1 ? 'y references a missing file' : 'ies reference missing files'}`);
    for (const p of orphanPaths.slice(0, 5)) log(`    missing: ${p}`);
    if (orphanPaths.length > 5) log(`    ... +${orphanPaths.length - 5} more`);
    log(`    Repair: node ${join(PROJECT_DIR, 'install.mjs')} uninstall    # removes the dead hook entries`);
    issues++;
  } else if (hasHooks) {
    ok('Orphan hooks: none (all hook targets present)');
  }

  // Database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      // Check FTS
      const fts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observations_fts'").get();
      db.close();
      if (fts) {
        ok('FTS5 index: present');
        // FTS5 integrity check (requires read-write access for INSERT INTO fts VALUES('integrity-check'))
        try {
          const { checkFTSIntegrity, rebuildFTS } = await import('./schema.mjs');
          const rwDb = new Database(DB_PATH);
          rwDb.pragma('busy_timeout = 3000');
          try {
            const { healthy, details } = checkFTSIntegrity(rwDb);
            if (healthy) {
              ok('FTS5 integrity: all indexes healthy');
            } else {
              dwarn('FTS5 integrity issues detected:');
              for (const d of details) log(`    ${d}`);
              log('  Attempting FTS5 rebuild...');
              const { rebuilt, errors } = rebuildFTS(rwDb);
              if (rebuilt.length > 0) ok(`FTS5 rebuilt: ${rebuilt.join(', ')}`);
              if (errors.length > 0) { fail(`FTS5 rebuild errors: ${errors.join(', ')}`); issues++; }
            }
          } finally {
            rwDb.close();
          }
        } catch (e) {
          dwarn('FTS5 integrity check failed: ' + e.message);
        }
      } else {
        dwarn('FTS5 index: missing (will be created on server start)');
      }
    } catch (e) {
      fail('Database: ' + e.message);
      issues++;
    }
  } else {
    dwarn('Database: not found (will be created)');
  }

  // Check for stale processes — extends beyond legacy chroma/worker to
  // catch MCP launchers / servers from cached old plugin versions. Auto-update
  // bumps installed_plugins.json but cannot kill the MCP process spawned for
  // an active session, so v2.60.0/v2.61.0 launchers commonly outlive their
  // version (recurrent pattern, see #2580 for the gsd analogue). Filtering
  // strategy: legacy chroma/worker = always stale; cache-path launchers = only
  // when their version segment ≠ current package.json version; dev-install
  // paths (no version segment) are never flagged.
  try {
    const procs = execFileSync('pgrep', ['-af', 'chroma|claude-mem-lite.*(scripts/launch|server)\\.mjs|claude-mem.*worker'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
    const lines = procs.split('\n').filter(l => l && !l.includes('pgrep'));
    let currentVersion = '';
    try { currentVersion = JSON.parse(readFileSync(join(PROJECT_DIR, 'package.json'), 'utf8')).version; } catch { /* fall through with empty version */ }
    const stale = lines.filter(l => {
      if (/chroma|claude-mem.*worker/.test(l)) return true;
      const m = l.match(/claude-mem-lite\/(\d+\.\d+\.\d+)\/(scripts\/launch|server)\.mjs/);
      return m && currentVersion && m[1] !== currentVersion;
    });
    if (stale.length > 0) {
      warn(`Old processes running${currentVersion ? ` (current: v${currentVersion})` : ''}:\n    ` + stale.join('\n    '));
      issues++;
    } else {
      ok('No stale processes');
    }
  } catch {
    ok('No stale processes');
  }

  // Update state
  try {
    const stateFile = join(INSTALL_DIR, 'runtime', 'update-state.json');
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      const parts = [];
      if (state.lastCheck) parts.push(`last check: ${state.lastCheck}`);
      if (state.latestVersion) parts.push(`latest: v${state.latestVersion}`);
      if (state.lastUpdate) parts.push(`last update: ${state.lastUpdate}`);
      if (state.updateAvailable) parts.push('update pending');
      if (state.rateLimited) parts.push('rate-limited');
      if (state.lastError) parts.push(`last error: ${state.lastError}`);
      ok(`Update state: ${parts.join(', ') || 'empty'}`);
    } else if (isDevInstall()) {
      // Dev installs symlink server.mjs → project source; hook-update.mjs
      // short-circuits before writing state (see hook-update.mjs isDevMode).
      ok('Update state: skipped (dev mode — symlinked install)');
    } else {
      dwarn('Update state: no state file (first run?)');
    }
  } catch {
    dwarn('Update state: failed to read');
  }

  // Dev drift: in dev-mode installs, all SOURCE_FILES entries should be
  // symlinks. A plain file means an earlier install (or manual cp) copied it
  // (edits in the repo won't propagate). A missing entry (neither symlink nor
  // plain) means an earlier install never wrote the file — same divergence
  // class. Per #8043: "is this file present ≠ is this install consistent" —
  // missing is tracked separately by checkDevDrift but the caller MUST surface
  // it to honour #8268's "gate the all-green string on every counter" rule.
  try {
    const { checkDevDrift } = await import('./lib/doctor-drift.mjs');
    const r = checkDevDrift(INSTALL_DIR, SOURCE_FILES);
    if (r.drift || (r.devMode && r.missingCount > 0)) {
      const parts = [];
      if (r.plainCount > 0) {
        const names = r.plainFiles.slice(0, 5).join(', ');
        const suffix = r.plainCount > 5 ? ` +${r.plainCount - 5} more` : '';
        parts.push(`${r.plainCount} non-symlink: ${names}${suffix}`);
      }
      if (r.missingCount > 0) {
        const names = r.missingFiles.join(', ');
        const suffix = r.missingCount > r.missingFiles.length ? ` +${r.missingCount - r.missingFiles.length} more` : '';
        parts.push(`${r.missingCount} missing: ${names}${suffix}`);
      }
      warn(`Dev drift: ${parts.join('; ')} (re-run: node ${join(PROJECT_DIR, 'install.mjs')} install --dev)`);
      issues++;
    } else if (r.devMode) {
      ok(`Dev drift: clean (${r.symlinkCount} symlinks, 0 plain, 0 missing)`);
    }
    // Prod (all plain) install: no message — dev-drift is a dev-only concern.
  } catch (e) {
    dwarn('Dev drift: check failed — ' + e.message);
  }

  // Stale temp files
  try {
    const runtimeDir = join(INSTALL_DIR, 'runtime');
    let staleCount = 0;
    const stalePatterns = ['.update-staging-', '.update-backup-'];
    if (existsSync(INSTALL_DIR)) {
      for (const f of readdirSync(INSTALL_DIR)) {
        if (stalePatterns.some(p => f.startsWith(p))) staleCount++;
      }
    }
    if (existsSync(runtimeDir)) {
      for (const f of readdirSync(runtimeDir)) {
        if (f.startsWith('pending-') || f.startsWith('ep-flush-')) staleCount++;
      }
    }
    if (staleCount > 0) {
      dwarn(`Stale temp files: ${staleCount} found (run: node install.mjs cleanup)`);
    } else {
      ok('Stale temp files: none');
    }
  } catch {
    dwarn('Stale temp files: check failed');
  }

  // DB stats
  if (existsSync(DB_PATH)) {
    try {
      const dbSize = statSync(DB_PATH).size;
      const sizeMB = (dbSize / 1024 / 1024).toFixed(1);
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const obsCount = db.prepare('SELECT COUNT(*) as cnt FROM observations').get()?.cnt || 0;
      // Align with stats / MCP mem_stats: session_summaries, not sdk_sessions
      const sessCount = db.prepare('SELECT COUNT(*) as cnt FROM session_summaries').get()?.cnt || 0;
      db.close();
      ok(`DB stats: ${sizeMB}MB, ${obsCount} observations, ${sessCount} sessions`);
    } catch (e) {
      dwarn('DB stats: ' + e.message);
    }
  }

  // Plugin cache versions
  const pluginCacheBase = join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_KEY, 'claude-mem-lite');
  if (existsSync(pluginCacheBase)) {
    try {
      const versions = readdirSync(pluginCacheBase).filter(n => /^\d+\./.test(n));
      let sizeStr;
      try {
        sizeStr = execFileSync('du', ['-sh', pluginCacheBase], { encoding: 'utf8', timeout: 5000 }).trim().split('\t')[0];
      } catch { sizeStr = '?'; }
      if (versions.length > 3) {
        dwarn(`Plugin cache: ${versions.length} versions (${sizeStr}) — run setup.sh or update to auto-prune to 3`);
      } else {
        ok(`Plugin cache: ${versions.length} version(s) (${sizeStr})`);
      }
    } catch {}
  }

  if (json) {
    console.log(JSON.stringify({
      issues,
      warnings,
      summary: buildDoctorSummary(issues, warnings),
      checks,
    }, null, 2));
  } else {
    console.log(`\n  ${buildDoctorSummary(issues, warnings)}\n`);
  }
  // Diagnostic-tool exit-code contract: any ✗-level finding must propagate non-zero
  // so CI / wrapper scripts (`claude-mem-lite doctor || alert`) actually trip. Keeps
  // ⚠-only states at exit 0 (#8268 already established the visual ⚠ vs counted-issue
  // separation; this propagates that count to the shell).
  if (issues > 0) process.exitCode = 1;
}

// ─── Settings helpers ───────────────────────────────────────────────────────

function isMemHook(cfg) {
  if (!cfg.hooks) return false;
  return cfg.hooks.some(h => {
    const cmd = h.command || '';
    return cmd.includes('claude-mem-lite') ||
      (cmd.includes('hook.mjs') && /\b(session-start|stop|user-prompt|pre-tool-use)\b/.test(cmd)) ||
      cmd.includes('scripts/post-tool-use.sh');
  });
}

function hasMemHooksConfigured(settings) {
  if (!settings?.hooks) return false;
  return Object.values(settings.hooks).some(configs =>
    Array.isArray(configs) && configs.some(cfg => isMemHook(cfg))
  );
}

/**
 * Walk every mem-hook command in settings.json and collect any absolute file
 * paths that don't currently exist on disk. Used by doctor() to surface
 * post-uninstall residue ("/plugin uninstall claude-mem-lite" leaves
 * settings.json hooks pointing at ~/.claude-mem-lite/hook.mjs; if the user
 * then deleted that directory, every session start dispatches to a missing
 * file).
 *
 * Path extraction: command strings look like:
 *   node "/home/sds/.claude-mem-lite/hook.mjs" session-start
 *   bash "/home/sds/.claude-mem-lite/scripts/post-tool-use.sh"
 *   node "/home/sds/.claude-mem-lite/scripts/pre-tool-recall.js"
 * We pick the first quoted absolute path; if there is no quoted token we fall
 * back to the first whitespace-delimited absolute-looking token after the
 * interpreter. ${CLAUDE_PLUGIN_ROOT}-templated commands are ignored — those
 * are plugin-owned hooks resolved by Claude Code at runtime, not by us.
 */
const HOOK_PATH_EXTS = ['.mjs', '.js', '.cjs', '.sh'];

function looksLikeHookPath(p) {
  if (!p || !p.startsWith('/')) return false;
  return HOOK_PATH_EXTS.some(ext => p.endsWith(ext));
}

export function collectOrphanHookPaths(settings) {
  if (!settings?.hooks) return [];
  const out = [];
  for (const configs of Object.values(settings.hooks)) {
    if (!Array.isArray(configs)) continue;
    for (const cfg of configs) {
      if (!isMemHook(cfg)) continue;
      for (const h of cfg.hooks || []) {
        const cmd = h.command || '';
        if (cmd.includes('${CLAUDE_PLUGIN_ROOT}')) continue;
        // v2.80: scan ALL quoted tokens (was: only the first), prefer ones
        // that look like a hook path. Fixes a footgun where a wrapper command
        // like `bash -c "some inline" "/real/path.sh"` would pick "some inline"
        // and flag a false orphan. If no quoted token looks like a path, fall
        // through to the unquoted scanner; if that also misses, skip the
        // entry — we'd rather under-report than false-flag.
        let path = null;
        for (const m of cmd.matchAll(/"([^"]+)"/g)) {
          if (looksLikeHookPath(m[1])) { path = m[1]; break; }
        }
        if (!path) {
          const parts = cmd.split(/\s+/);
          path = parts.find(p => looksLikeHookPath(p)) || null;
        }
        if (!path) continue;
        if (!existsSync(path) && !out.includes(path)) out.push(path);
      }
    }
  }
  return out;
}

/**
 * v2.48 P1-4: prune top-level stale files left behind by removed-module upgrades.
 *
 * Strict whitelist: only removes files under `dataDir` (no recursion) that match
 *   - `*.mjs` whose basename is NOT in SOURCE_FILES (comparing against both the
 *     bare entry and any `subdir/basename` entry flattened to its basename — the
 *     prune intentionally skips subdir files; see below)
 *   - 0-byte `.db` files that are NOT in the protected-db allow-list
 *
 * Protections (never touched):
 *   - subdirectories (managed/, runtime/, scripts/, lib/, cli/, commands/, server/, node_modules/, .claude-plugin/, registry/, etc.)
 *   - non-empty `.db` files — real data risk, always preserved
 *   - WAL/SHM (`*-wal`, `*-shm`) transients
 *   - files not ending in `.mjs` or `.db`
 *   - the two canonical DBs (`claude-mem-lite.db`, `resource-registry.db`) even when 0-byte (fresh-install transient state)
 *
 * @param {string} dataDir Absolute path, typically `~/.claude-mem-lite`
 * @param {string[]} sourceFiles SOURCE_FILES manifest
 * @returns {string[]} Absolute paths of files that were deleted (ordered by readdir)
 */
export function pruneStaleInstallFiles(dataDir, sourceFiles) {
  if (!existsSync(dataDir)) return [];
  // Flatten manifest to just top-level basenames. SOURCE_FILES contains entries
  // like 'lib/activity.mjs' — those belong to a subdir and prune never touches
  // subdirs anyway. For top-level entries ('server.mjs'), basename === entry.
  const topLevelAllowed = new Set(
    sourceFiles
      .filter(f => !f.includes('/'))
      .map(f => f)
  );
  const PROTECTED_DBS = new Set(['claude-mem-lite.db', 'resource-registry.db']);
  const removed = [];
  let entries;
  try { entries = readdirSync(dataDir); } catch { return removed; }
  for (const name of entries) {
    const full = join(dataDir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    // Skip directories and symlinks (dev mode uses symlinks; treat as intentional).
    if (!st.isFile()) continue;
    if (name.endsWith('.mjs') && !topLevelAllowed.has(name)) {
      try { unlinkSync(full); removed.push(full); } catch { /* best-effort */ }
      continue;
    }
    if (name.endsWith('.db') && !PROTECTED_DBS.has(name) && st.size === 0) {
      try { unlinkSync(full); removed.push(full); } catch { /* best-effort */ }
    }
  }
  return removed;
}

export function clearPluginDisabledMarkerForDirectInstall(settings) {
  if (settings?.enabledPlugins?.[PLUGIN_KEY] !== false) return false;
  delete settings.enabledPlugins[PLUGIN_KEY];
  if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
  return true;
}

function cleanupMemHooksFromSettings(settings) {
  if (!settings?.hooks) return 0;

  let removed = 0;
  for (const [event, configs] of Object.entries(settings.hooks)) {
    if (!Array.isArray(configs)) continue;
    const kept = configs.filter(cfg => !isMemHook(cfg));
    removed += configs.length - kept.length;
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function isPluginExplicitlyDisabled(settings) {
  return settings?.enabledPlugins?.[PLUGIN_KEY] === false;
}

function getInstalledPluginEntries(installed) {
  if (installed?.plugins && typeof installed.plugins === 'object') return installed.plugins;
  return installed && typeof installed === 'object' ? installed : {};
}

export function hasOtherMarketplacePlugins(installed, marketplaceKey = MARKETPLACE_KEY, pluginKey = PLUGIN_KEY) {
  const plugins = getInstalledPluginEntries(installed);
  return Object.keys(plugins).some(key => key !== pluginKey && key.endsWith(`@${marketplaceKey}`));
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  const settingsDir = dirname(SETTINGS_PATH);
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, SETTINGS_PATH);
}

// ─── Cleanup Stale Files ─────────────────────────────────────────────────────

function cleanup() {
  // Dogfood-7 addition: --dry-run lists which files would be removed without
  // touching disk. Useful before running cleanup on a remote/CI machine where
  // accidentally pruning the wrong file would be costly. Doctor reports stale
  // file counts and points users here; --dry-run lets them confirm the list.
  const dryRun = flags.has('--dry-run');
  console.log(`\nclaude-mem-lite cleanup${dryRun ? ' (--dry-run)' : ''}\n`);
  let removed = 0;

  // Clean .update-staging-* / .update-backup-* in INSTALL_DIR
  const stalePatterns = ['.update-staging-', '.update-backup-'];
  if (existsSync(INSTALL_DIR)) {
    for (const f of readdirSync(INSTALL_DIR)) {
      if (stalePatterns.some(p => f.startsWith(p))) {
        if (dryRun) {
          ok(`Would remove: ${f}`);
          removed++;
          continue;
        }
        try {
          rmSync(join(INSTALL_DIR, f), { recursive: true, force: true });
          ok(`Removed: ${f}`);
          removed++;
        } catch (e) {
          warn(`Failed to remove ${f}: ${e.message}`);
        }
      }
    }
  }

  // Clean pending-* / ep-flush-* in runtime/
  const runtimeDir = join(INSTALL_DIR, 'runtime');
  if (existsSync(runtimeDir)) {
    for (const f of readdirSync(runtimeDir)) {
      if (f.startsWith('pending-') || f.startsWith('ep-flush-')) {
        if (dryRun) {
          ok(`Would remove: runtime/${f}`);
          removed++;
          continue;
        }
        try {
          rmSync(join(runtimeDir, f), { force: true });
          ok(`Removed: runtime/${f}`);
          removed++;
        } catch (e) {
          warn(`Failed to remove runtime/${f}: ${e.message}`);
        }
      }
    }
  }

  const verb = dryRun ? 'would be removed' : 'removed';
  console.log(`\n  ${removed === 0 ? 'No stale files found.' : `${removed} stale file(s) ${verb}.`}\n`);
}

// ─── Manual Update ───────────────────────────────────────────────────────────

async function manualUpdate() {
  console.log('\nclaude-mem-lite update\n');

  // Force check by importing hook-update (bypasses throttle for manual use)
  const { checkForUpdate, getCurrentVersion } = await import('./hook-update.mjs');
  log('Checking for updates...');
  const result = await checkForUpdate({ force: true, allowInstall: true });

  if (result?.updated) {
    ok(`Updated: v${result.from} → v${result.to}`);
  } else if (result?.updateAvailable && result?.installDeferred) {
    warn(`v${result.to} available — plugin mode only checks for updates.`);
    log('  To upgrade, inside Claude Code run:');
    log('    /plugin marketplace update sdsrss');
    log('    /plugin install claude-mem-lite@sdsrss');
  } else if (result?.updateAvailable) {
    warn(`v${result.to} available but install failed — try: node install.mjs install`);
  } else {
    const ver = getCurrentVersion();
    ok(`Already up to date (v${ver})`);
  }
  console.log('');
}

// ─── Release: Sync Versions ─────────────────────────────────────────────────

function syncVersions() {
  console.log('\nclaude-mem-lite release — sync versions\n');

  const pkg = JSON.parse(readFileSync(join(PROJECT_DIR, 'package.json'), 'utf8'));
  const version = pkg.version;
  log(`package.json version: ${version}`);

  const pluginJsonPath = join(PROJECT_DIR, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    const r = bumpJsonField(pluginJsonPath, ['version'], version);
    ok(r.changed ? `plugin.json: ${r.prev} → ${version}` : `plugin.json: already ${version}`);
  } else {
    warn('plugin.json not found');
  }

  const marketJsonPath = join(PROJECT_DIR, '.claude-plugin', 'marketplace.json');
  if (existsSync(marketJsonPath)) {
    const r = bumpJsonField(marketJsonPath, ['plugins', 0, 'version'], version);
    if (r.prev === undefined) warn('marketplace.json: plugins[0] not found');
    else ok(r.changed ? `marketplace.json: ${r.prev} → ${version}` : `marketplace.json: already ${version}`);
  } else {
    warn('marketplace.json not found');
  }

  // Sync CLAUDE.md `**Version**: x.y.z` line — install-e2e asserts this
  // matches package.json so omitting it here would break CI on every release.
  const claudeMdPath = join(PROJECT_DIR, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const orig = readFileSync(claudeMdPath, 'utf8');
    const versionLine = /^- \*\*Version\*\*: .+$/m;
    if (versionLine.test(orig)) {
      const patched = orig.replace(versionLine, `- **Version**: ${version}`);
      if (patched !== orig) {
        writeFileSync(claudeMdPath, patched);
        ok(`CLAUDE.md: → ${version}`);
      } else {
        ok(`CLAUDE.md: already ${version}`);
      }
    } else {
      warn('CLAUDE.md: `**Version**:` line not found — skipped');
    }
  } else {
    warn('CLAUDE.md not found');
  }

  console.log('');
}

// Regenerate package-lock.json via npm@10.9.2 to guarantee CI parity. The
// drift this prevents: `npm install --package-lock-only` on npm@11+ silently
// strips top-level `@emnapi/core` + `@emnapi/runtime` entries when those are
// transitive deps of platform-optional bindings (e.g. `@oxc-parser/binding-*`
// from knip), and CI's bundled npm@10 (Node 22 default in GitHub Actions)
// then refuses `npm ci` with EUSAGE. Same recipe bit twice (#8271 / 2.58.2 /
// 2.62.1) before this guard. The packageManager field in package.json
// declares the same version for corepack-aware tooling. Network cost: ~5-30s
// per release; release cadence makes this acceptable.
function regenerateLockfile() {
  console.log('\nclaude-mem-lite release — regenerate lockfile (npm@10.9.2)\n');
  try {
    execFileSync('npx', ['--yes', 'npm@10.9.2', 'install'], {
      stdio: 'inherit',
      cwd: PROJECT_DIR,
    });
    ok('lockfile regenerated');
  } catch (e) {
    fail('lockfile regen failed: ' + e.message);
    throw e;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  cmd = argv[0];
  flags = new Set(argv.slice(1));

  switch (cmd) {
    case 'install':
      await install();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'status':
      await status();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'cleanup-hooks':
      await cleanupHooks();
      break;
    case 'cleanup':
      cleanup();
      break;
    case 'self-update':
    case 'update':
      await manualUpdate();
      break;
    case 'release':
      syncVersions();
      if (!flags.has('--no-lock')) regenerateLockfile();
      break;
    default:
      if (IS_NPX) {
        // npx claude-mem-lite (no args) → auto install
        await install();
      } else {
        // Name the unknown token before the usage block. Pre-fix `install frobnicate`
        // dumped usage silently, which read like the user had typed nothing — they had
        // no idea their command was rejected.
        if (cmd) {
          console.error(`[install] Unknown command: "${cmd}"`);
          process.exitCode = 1;
        }
        console.log(`
claude-mem-lite — Lightweight memory system for Claude Code

Usage:
  node install.mjs install            Install (copy files to ~/.claude-mem-lite/)
  node install.mjs install --dev      Install dev mode (symlinks to dev dir)
  node install.mjs uninstall          Remove (keep data)
  node install.mjs uninstall --purge  Remove and delete all data
  node install.mjs status             Show current status (use --json for structured output)
  node install.mjs doctor             Diagnose issues (use --json for structured output)
  node install.mjs cleanup            Remove stale temp/staging files (use --dry-run to preview)
  node install.mjs cleanup-hooks      Remove only claude-mem-lite hooks from settings.json
  node install.mjs self-update         Check for and install updates
  node install.mjs release            Sync versions (plugin/marketplace/CLAUDE.md) + regen lockfile via npm@10.9.2 (use --no-lock to skip lock regen)

  npx claude-mem-lite                 Install via npx (one-liner)
`);
      }
  }
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
