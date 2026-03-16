#!/usr/bin/env node
// claude-mem-lite Installer — Smart install/uninstall/status/doctor

import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, cpSync, renameSync, symlinkSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
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

/**
 * Apply curated metadata to existing resource DB entries.
 * Fixes existing installs that have generic name-echo metadata.
 * @param {Database} rdb Registry database handle
 */
function reindexKnownResources(rdb) {
  const update = rdb.prepare(`
    UPDATE resources SET
      intent_tags = ?, domain_tags = ?,
      capability_summary = ?, trigger_patterns = ?,
      invocation_name = CASE WHEN ? != '' THEN ? ELSE invocation_name END,
      recommendation_mode = CASE WHEN ? != '' THEN ? ELSE recommendation_mode END,
      updated_at = datetime('now')
    WHERE type = ? AND name = ?
  `);

  rdb.transaction(() => {
    for (const [key, meta] of Object.entries(RESOURCE_METADATA)) {
      const sep = key.indexOf(':');
      if (sep < 0) continue; // skip malformed keys without type:name separator
      const type = key.slice(0, sep);
      const name = key.slice(sep + 1);
      const invName = meta.invocation_name || '';
      const recMode = meta.recommendation_mode || '';
      update.run(
        meta.intent_tags, meta.domain_tags,
        meta.capability_summary, meta.trigger_patterns,
        invName, invName,
        recMode, recMode,
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
        meta.invocation_name || '',
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
  })();
  return count;
}

let cmd = process.argv[2];
let flags = new Set(process.argv.slice(3));

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

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

  const SOURCE_FILES = [
    'server.mjs', 'server-internals.mjs', 'tool-schemas.mjs',
    'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs', 'hook-memory.mjs',
    'hook-semaphore.mjs', 'hook-episode.mjs', 'hook-context.mjs', 'hook-handoff.mjs', 'hook-update.mjs',
    'haiku-client.mjs', 'utils.mjs', 'schema.mjs', 'package.json', 'package-lock.json', 'skill.md',
    'registry.mjs', 'registry-scanner.mjs', 'registry-indexer.mjs',
    'registry-retriever.mjs', 'resource-discovery.mjs',
    'dispatch.mjs', 'dispatch-inject.mjs', 'dispatch-feedback.mjs', 'dispatch-patterns.mjs', 'dispatch-workflow.mjs',
    'install-metadata.mjs',
  ];

  if (IS_DEV) {
    log('Dev mode — creating symlinks in ~/.claude-mem-lite/...');
    // Symlink individual source files
    for (const f of SOURCE_FILES) {
      const target = join(PROJECT_DIR, f);
      const link = join(DATA_DIR, f);
      if (existsSync(target)) {
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
    ok('Symlinks created in ~/.claude-mem-lite/ → dev dir');
  } else {
    log('Installing to ~/.claude-mem-lite/...');
    const scriptsDir = join(DATA_DIR, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    for (const f of SOURCE_FILES) {
      const src = join(PROJECT_DIR, f);
      if (existsSync(src)) copyFileSync(src, join(DATA_DIR, f));
    }
    // Copy scripts
    const postToolSrc = join(PROJECT_DIR, 'scripts', 'post-tool-use.sh');
    if (existsSync(postToolSrc)) copyFileSync(postToolSrc, join(scriptsDir, 'post-tool-use.sh'));
    // Ensure bash script is executable
    try { execFileSync('chmod', ['+x', join(scriptsDir, 'post-tool-use.sh')], { stdio: 'pipe' }); } catch {}
    // Copy registry manifest
    const registryDir = join(DATA_DIR, 'registry');
    if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
    const manifestSrc = join(PROJECT_DIR, 'registry', 'preinstalled.json');
    if (existsSync(manifestSrc)) copyFileSync(manifestSrc, join(registryDir, 'preinstalled.json'));
    ok('Source files copied to ~/.claude-mem-lite/');
  }

  // 2. npm install (skip for --dev: node_modules is symlinked)
  if (IS_DEV) {
    ok('Dependencies: using dev dir (symlinked)');
  } else {
    log('Ensuring dependencies installed...');
    try {
      execSync(NPM_INSTALL_CMD, { cwd: INSTALL_DIR, stdio: 'pipe' });
      ok('Dependencies installed');
    } catch (e) {
      fail('npm install failed: ' + e.message);
      process.exit(1);
    }
  }

  // 3. Register MCP server
  log('Registering MCP server...');
  try {
    // Remove existing first (ignore errors)
    try { execFileSync('claude', ['mcp', 'remove', '-s', 'user', 'mem'], { stdio: 'pipe' }); } catch {}
    execFileSync('claude', ['mcp', 'add', '-s', 'user', '-t', 'stdio', 'mem', '--', 'node', SERVER_PATH], { stdio: 'pipe' });
    // Remove project-level registration that shadows global (from .mcp.json)
    try { execFileSync('claude', ['mcp', 'remove', '-s', 'project', 'mem'], { stdio: 'pipe' }); } catch {}
    ok('MCP server registered: mem');
  } catch (e) {
    fail('MCP registration failed: ' + e.message);
    warn('Try manually: claude mcp add -s user -t stdio mem -- node ' + SERVER_PATH);
  }

  // 3b. Deduplicate: if marketplace plugin also registers MCP + hooks,
  // clear them to prevent double execution. install.mjs hooks (in settings.json)
  // point to ~/.claude-mem-lite/ (latest code in dev mode via symlinks),
  // while plugin hooks use ${CLAUDE_PLUGIN_ROOT} (potentially stale marketplace copy).
  const pluginDir = join(homedir(), '.claude', 'plugins', 'marketplaces', MARKETPLACE_KEY);
  const pluginMcpPath = join(pluginDir, '.mcp.json');
  const pluginHooksPath = join(pluginDir, 'hooks', 'hooks.json');

  if (existsSync(pluginDir)) {
    // Clear plugin MCP to prevent duplicate "mem" server
    try {
      if (existsSync(pluginMcpPath)) {
        const pluginMcp = JSON.parse(readFileSync(pluginMcpPath, 'utf8'));
        if (pluginMcp.mcpServers?.mem) {
          delete pluginMcp.mcpServers.mem;
          writeFileSync(pluginMcpPath, JSON.stringify(pluginMcp, null, 2) + '\n');
          ok('Marketplace plugin: MCP cleared (prevents duplicate)');
        }
      }
    } catch (e) { warn(`Marketplace MCP dedup: ${e.message}`); }

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

  const memPreToolUse = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" pre-tool-use`,
      timeout: 2
    }]
  };

  const memUserPrompt = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" user-prompt`,
      timeout: 5
    }]
  };

  // Filter out existing mem hooks, then append fresh ones
  for (const [event, config] of [['PostToolUse', memPostToolUse], ['PreToolUse', memPreToolUse], ['SessionStart', memSessionStart], ['Stop', memStop], ['UserPromptSubmit', memUserPrompt]]) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event].filter(cfg => !isMemHook(cfg)) : [];
    settings.hooks[event] = [...existing, config];
  }

  writeSettings(settings);
  ok('Hooks configured (PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit)');

  // 5. Migrate from old ~/.claude-mem/ if needed
  if (existsSync(join(OLD_DATA_DIR, 'claude-mem.db')) && !existsSync(DB_PATH) && !existsSync(join(DATA_DIR, 'claude-mem.db'))) {
    log('Detected old ~/.claude-mem/ directory, migrating to ~/.claude-mem-lite/...');
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      // Migrate database and WAL/SHM files (copy as claude-mem-lite.db)
      const srcDb = join(OLD_DATA_DIR, 'claude-mem.db');
      if (existsSync(srcDb)) copyFileSync(srcDb, DB_PATH);
      for (const ext of ['-wal', '-shm']) {
        const src = join(OLD_DATA_DIR, 'claude-mem.db' + ext);
        if (existsSync(src)) copyFileSync(src, DB_PATH + ext);
      }
      // Migrate runtime directory
      const oldRuntime = join(OLD_DATA_DIR, 'runtime');
      const newRuntime = join(DATA_DIR, 'runtime');
      if (existsSync(oldRuntime) && !existsSync(newRuntime)) {
        cpSync(oldRuntime, newRuntime, { recursive: true });
      }
      ok('Data migrated from ~/.claude-mem/ → ~/.claude-mem-lite/');
      log('Old ~/.claude-mem/ preserved (remove manually when ready)');
    } catch (e) {
      warn('Migration failed: ' + e.message);
      log('You can copy manually: cp ~/.claude-mem/claude-mem.db ~/.claude-mem-lite/claude-mem-lite.db');
    }
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
  log('Setting up skill/agent registry...');
  try {
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
          const repoName = repoUrl.split('/').slice(-2).join('-');
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
                invocation_name: meta?.invocation_name || '',
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

  // 1. Remove MCP (legacy hook-based install)
  try {
    execFileSync('claude', ['mcp', 'remove', '-s', 'user', 'mem'], { stdio: 'pipe' });
    ok('MCP server removed');
  } catch {
    warn('MCP server not found or already removed');
  }

  // 2. Remove hooks from settings.json (match both npx and git-clone install paths)
  const settings = readSettings();
  cleanupMemHooksFromSettings(settings);

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
  console.log('\nclaude-mem-lite status\n');

  // MCP
  try {
    const list = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
    if (list.includes('mem:') || list.includes('mem ')) {
      ok('MCP server: registered');
    } else {
      fail('MCP server: not registered');
    }
  } catch {
    warn('Could not check MCP status');
  }

  // Hooks
  const settings = readSettings();
  const hasHooks = hasMemHooksConfigured(settings);
  const pluginDisabled = isPluginExplicitlyDisabled(settings);
  const pluginEnabled = settings.enabledPlugins?.[PLUGIN_KEY] === true;

  if (pluginEnabled) {
    ok('Plugin: enabled in settings');
  } else if (pluginDisabled) {
    warn('Plugin: disabled in settings');
  } else {
    warn('Plugin: not present in enabledPlugins');
  }

  if (hasHooks && pluginDisabled) {
    warn('Hooks: still configured in settings.json while plugin is disabled (runtime ignores them; run cleanup-hooks or uninstall to clean up)');
  } else if (hasHooks) {
    ok('Hooks: configured');
  } else if (pluginDisabled) {
    ok('Hooks: not configured');
  } else {
    fail('Hooks: not configured');
  }

  // Database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const obs = db.prepare('SELECT COUNT(*) as c FROM observations').get();
      const sess = db.prepare('SELECT COUNT(*) as c FROM session_summaries').get();
      db.close();
      ok(`Database: ${obs.c} observations, ${sess.c} sessions`);
    } catch (e) {
      warn('Database: exists but check failed — ' + e.message);
    }
  } else {
    warn('Database: not found');
  }

  // Old system
  const vectorDb = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDb)) {
    warn('Old vector-db still exists (can be removed)');
  }

  console.log('');
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

async function doctor() {
  console.log('\nclaude-mem-lite doctor\n');
  let issues = 0;

  // Node version
  const nodeVer = process.version;
  if (parseInt(nodeVer.slice(1)) >= 18) {
    ok(`Node.js: ${nodeVer}`);
  } else {
    fail(`Node.js ${nodeVer} too old (need >=18)`);
    issues++;
  }

  // Dependencies
  const bsPath = join(INSTALL_DIR, 'node_modules', 'better-sqlite3');
  if (existsSync(bsPath)) {
    ok('better-sqlite3: installed');
  } else {
    fail('better-sqlite3: not installed (run install again)');
    issues++;
  }

  const mcpPath = join(INSTALL_DIR, 'node_modules', '@modelcontextprotocol');
  if (existsSync(mcpPath)) {
    ok('@modelcontextprotocol/sdk: installed');
  } else {
    fail('@modelcontextprotocol/sdk: not installed');
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
    warn('Plugin lifecycle: hooks not configured');
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
              warn('FTS5 integrity issues detected:');
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
          warn('FTS5 integrity check failed: ' + e.message);
        }
      } else {
        warn('FTS5 index: missing (will be created on server start)');
      }
    } catch (e) {
      fail('Database: ' + e.message);
      issues++;
    }
  } else {
    warn('Database: not found (will be created)');
  }

  // Check for stale processes
  try {
    const procs = execSync('pgrep -af "chroma|claude-mem.*worker" 2>/dev/null', { encoding: 'utf8' }).trim();
    // Filter out the pgrep process itself (matches its own pattern)
    const real = procs.split('\n').filter(l => !l.includes('pgrep'));
    if (real.length > 0) {
      warn('Old processes running:\n    ' + real.join('\n    '));
      issues++;
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
    } else {
      warn('Update state: no state file (first run?)');
    }
  } catch {
    warn('Update state: failed to read');
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
      warn(`Stale temp files: ${staleCount} found (run: node install.mjs cleanup)`);
    } else {
      ok('Stale temp files: none');
    }
  } catch {
    warn('Stale temp files: check failed');
  }

  // DB stats
  if (existsSync(DB_PATH)) {
    try {
      const dbSize = statSync(DB_PATH).size;
      const sizeMB = (dbSize / 1024 / 1024).toFixed(1);
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const obsCount = db.prepare('SELECT COUNT(*) as cnt FROM observations').get()?.cnt || 0;
      const sessCount = db.prepare('SELECT COUNT(*) as cnt FROM sdk_sessions').get()?.cnt || 0;
      db.close();
      ok(`DB stats: ${sizeMB}MB, ${obsCount} observations, ${sessCount} sessions`);
    } catch (e) {
      warn('DB stats: ' + e.message);
    }
  }

  console.log(`\n  ${issues === 0 ? 'All checks passed!' : `${issues} issue(s) found.`}\n`);
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
  console.log('\nclaude-mem-lite cleanup\n');
  let removed = 0;

  // Clean .update-staging-* / .update-backup-* in INSTALL_DIR
  const stalePatterns = ['.update-staging-', '.update-backup-'];
  if (existsSync(INSTALL_DIR)) {
    for (const f of readdirSync(INSTALL_DIR)) {
      if (stalePatterns.some(p => f.startsWith(p))) {
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

  console.log(`\n  ${removed === 0 ? 'No stale files found.' : `Removed ${removed} stale file(s).`}\n`);
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
    warn(`v${result.to} available — plugin mode only checks for updates, reinstall/update the plugin to apply it`);
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

  // Sync plugin.json
  const pluginJsonPath = join(PROJECT_DIR, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
    if (pluginJson.version !== version) {
      pluginJson.version = version;
      writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n');
      ok(`plugin.json: ${pluginJson.version} → ${version}`);
    } else {
      ok(`plugin.json: already ${version}`);
    }
  } else {
    warn('plugin.json not found');
  }

  // Sync marketplace.json
  const marketJsonPath = join(PROJECT_DIR, '.claude-plugin', 'marketplace.json');
  if (existsSync(marketJsonPath)) {
    const marketJson = JSON.parse(readFileSync(marketJsonPath, 'utf8'));
    const plugin = marketJson.plugins?.[0];
    if (plugin && plugin.version !== version) {
      plugin.version = version;
      writeFileSync(marketJsonPath, JSON.stringify(marketJson, null, 2) + '\n');
      ok(`marketplace.json: ${plugin.version} → ${version}`);
    } else if (plugin) {
      ok(`marketplace.json: already ${version}`);
    }
  } else {
    warn('marketplace.json not found');
  }

  console.log('');
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
    case 'update':
      await manualUpdate();
      break;
    case 'release':
      syncVersions();
      break;
    default:
      if (IS_NPX) {
        // npx claude-mem-lite (no args) → auto install
        await install();
      } else {
        console.log(`
claude-mem-lite — Lightweight memory system for Claude Code

Usage:
  node install.mjs install            Install (copy files to ~/.claude-mem-lite/)
  node install.mjs install --dev      Install dev mode (symlinks to dev dir)
  node install.mjs uninstall          Remove (keep data)
  node install.mjs uninstall --purge  Remove and delete all data
  node install.mjs status             Show current status
  node install.mjs doctor             Diagnose issues
  node install.mjs cleanup            Remove stale temp/staging files
  node install.mjs cleanup-hooks      Remove only claude-mem-lite hooks from settings.json
  node install.mjs update             Check for and install updates
  node install.mjs release            Sync version to plugin.json + marketplace.json

  npx claude-mem-lite                 Install via npx (one-liner)
`);
      }
  }
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
