// claude-mem-lite: Auto-update via GitHub Releases
// Checks for new versions on SessionStart, downloads and installs automatically.
// Skips in dev mode (symlinked installs). Silent on network failure.

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync, lstatSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { DB_DIR } from './schema.mjs';
import { debugCatch, debugLog } from './utils.mjs';

// ── Configuration ──────────────────────────────────────────
const GITHUB_REPO = 'sdsrss/claude-mem-lite';
const INSTALL_DIR = DB_DIR;  // ~/.claude-mem-lite/
const STATE_FILE = join(INSTALL_DIR, 'runtime', 'update-state.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;       // 24 hours
const FETCH_TIMEOUT_MS = 3000;                         // 3s network timeout
const RATE_LIMIT_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h if rate-limited
const NPM_INSTALL_CMD = 'npm install --omit=dev --no-audit --no-fund';

// ── Main Entry ─────────────────────────────────────────────
export async function checkForUpdate(options = {}) {
  try {
    const pluginMode = isPluginMode();
    const force = Boolean(options.force);
    const allowInstall = options.allowInstall ?? !pluginMode;

    if (isDevMode() || process.env.CLAUDE_MEM_SKIP_UPDATE) return null;

    const state = readState();
    if (!force && !shouldCheck(state)) {
      // Return cached update info if previously detected
      if (state.updateAvailable && state.latestVersion) {
        return {
          updateAvailable: true,
          updated: false,
          from: state.installedVersion,
          to: state.latestVersion,
          installDeferred: pluginMode || !allowInstall,
          pluginMode,
        };
      }
      return null;
    }

    const latest = await fetchLatestRelease();
    if (!latest) {
      saveState({ ...state, lastCheck: new Date().toISOString() });
      return null;
    }

    const currentVersion = getCurrentVersion();
    const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

    if (hasUpdate) {
      debugLog('DEBUG', 'hook-update', `Update available: ${currentVersion} → ${latest.version}`);
      const canInstall = !pluginMode && Boolean(allowInstall);
      const success = canInstall ? await downloadAndInstall(latest.tarballUrl) : false;
      const newState = {
        lastCheck: new Date().toISOString(),
        installedVersion: success ? latest.version : currentVersion,
        latestVersion: latest.version,
        updateAvailable: !success,
        lastUpdate: success ? new Date().toISOString() : (state.lastUpdate || null),
        rateLimited: false,
      };
      saveState(newState);

      return {
        updateAvailable: !success,
        updated: success,
        from: currentVersion,
        to: latest.version,
        installDeferred: !canInstall,
        pluginMode,
      };
    }

    // No update needed
    saveState({
      ...state,
      lastCheck: new Date().toISOString(),
      latestVersion: latest.version,
      updateAvailable: false,
      rateLimited: false,
      lastError: null,
    });
    return null;
  } catch (err) {
    debugCatch(err, 'checkForUpdate');
    try {
      const s = readState();
      saveState({ ...s, lastCheck: new Date().toISOString(), lastError: err.message });
    } catch {}
    return null;
  }
}

function isPluginMode() {
  return Boolean(process.env.CLAUDE_PLUGIN_ROOT);
}

// ── Dev Mode Detection ─────────────────────────────────────
function isDevMode() {
  try {
    const serverPath = join(INSTALL_DIR, 'server.mjs');
    return existsSync(serverPath) && lstatSync(serverPath).isSymbolicLink();
  } catch { return false; }
}

// ── Throttle ───────────────────────────────────────────────
function shouldCheck(state) {
  if (!state.lastCheck) return true;
  const elapsed = Date.now() - new Date(state.lastCheck).getTime();
  const interval = state.rateLimited ? RATE_LIMIT_INTERVAL_MS : CHECK_INTERVAL_MS;
  return elapsed >= interval;
}

// ── GitHub API ─────────────────────────────────────────────
// Try releases/latest first, fallback to tags (some repos only use tags)
async function fetchLatestRelease() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'claude-mem-lite-updater/1.0',
  };

  // Attempt 1: GitHub Releases API
  const result = await fetchWithTimeout(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    headers,
  );
  if (result === 'rate-limited') return null;
  if (result) {
    return {
      version: result.tag_name.replace(/^v/, ''),
      tarballUrl: result.tarball_url,
      releaseUrl: result.html_url,
    };
  }

  // Attempt 2: Tags API fallback (for repos without formal releases)
  const tags = await fetchWithTimeout(
    `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=1`,
    headers,
  );
  if (tags === 'rate-limited') return null;
  if (Array.isArray(tags) && tags.length > 0) {
    const tag = tags[0];
    return {
      version: tag.name.replace(/^v/, ''),
      tarballUrl: `https://api.github.com/repos/${GITHUB_REPO}/tarball/${tag.name}`,
      releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${tag.name}`,
    };
  }

  return null;
}

async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (res.status === 403) {
      const state = readState();
      saveState({ ...state, rateLimited: true });
      debugLog('DEBUG', 'hook-update', 'GitHub API rate limited, extending interval');
      return 'rate-limited';
    }
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

// ── Version Comparison (semver) ────────────────────────────
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function getCurrentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(INSTALL_DIR, 'package.json'), 'utf8'));
    return pkg.version;
  } catch { return '0.0.0'; }
}

// ── Source files to copy (must match install.mjs SOURCE_FILES) ──
const SOURCE_FILES = [
  'cli.mjs', 'server.mjs', 'server-internals.mjs', 'tool-schemas.mjs',
  'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs', 'hook-memory.mjs', 'skip-tools.mjs',
  'hook-semaphore.mjs', 'hook-episode.mjs', 'hook-context.mjs', 'hook-handoff.mjs', 'hook-update.mjs',
  'hook-optimize.mjs', 'plugin-cache-guard.mjs',
  'haiku-client.mjs', 'utils.mjs', 'schema.mjs', 'package.json', 'package-lock.json', 'skill.md',
  'registry.mjs', 'registry-scanner.mjs', 'registry-indexer.mjs',
  'registry-retriever.mjs', 'resource-discovery.mjs',
  'install.mjs', 'install-metadata.mjs', 'mem-cli.mjs', 'tier.mjs', 'tfidf.mjs',
  'nlp.mjs', 'synonyms.mjs', 'scoring-sql.mjs', 'stop-words.mjs', 'project-utils.mjs',
  'secret-scrub.mjs', 'format-utils.mjs', 'hash-utils.mjs', 'bash-utils.mjs',
];
const SWITCHABLE_PATHS = [...SOURCE_FILES, 'scripts', 'registry', 'node_modules'];

// ── Download & Install ─────────────────────────────────────
// Direct file copy instead of running old install.mjs (avoids symlink overwrite in dev)
async function downloadAndInstall(tarballUrl) {
  const tmpDir = join(tmpdir(), `claude-mem-lite-update-${Date.now()}`);
  try {
    mkdirSync(tmpDir, { recursive: true });

    // Download tarball via curl (available on all supported platforms)
    // Validate URL to prevent command injection via crafted tarball URLs
    if (!/^https:\/\/(?:api\.)?github\.com\/[a-zA-Z0-9./_-]+$/.test(tarballUrl)) {
      debugLog('WARN', 'hook-update', `Rejected suspicious tarball URL: ${tarballUrl}`);
      return false;
    }
    const tarballPath = join(tmpDir, 'release.tar.gz');
    execFileSync('curl', ['-sL', '-H', 'Accept: application/vnd.github+json', tarballUrl, '-o', tarballPath],
      { timeout: 30000, stdio: 'pipe' });
    execFileSync('tar', ['xzf', tarballPath, '-C', tmpDir, '--strip-components=1'],
      { timeout: 30000, stdio: 'pipe' });

    return installExtractedRelease(tmpDir);
  } catch (err) {
    debugCatch(err, 'downloadAndInstall');
    return false;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export function installExtractedRelease(sourceDir, targetDir = INSTALL_DIR) {
  const ts = `${Date.now()}-${process.pid}`;
  const stagingDir = join(targetDir, `.update-staging-${ts}`);
  const backupDir = join(targetDir, `.update-backup-${ts}`);
  const backedUp = [];
  const installed = [];

  try {
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });

    copyReleaseIntoStaging(sourceDir, stagingDir);
    execSync(NPM_INSTALL_CMD, {
      cwd: stagingDir,
      timeout: 60000,
      stdio: 'pipe',
    });

    for (const relPath of SWITCHABLE_PATHS) {
      const stagedPath = join(stagingDir, relPath);
      if (!existsSync(stagedPath)) continue;

      const targetPath = join(targetDir, relPath);
      const backupPath = join(backupDir, relPath);

      mkdirSync(dirname(targetPath), { recursive: true });
      mkdirSync(dirname(backupPath), { recursive: true });

      if (existsSync(targetPath)) {
        renameSync(targetPath, backupPath);
        backedUp.push(relPath);
      }

      renameSync(stagedPath, targetPath);
      installed.push(relPath);
    }

    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });

    // Post-update migration: clean stale global MCP if plugin handles it
    try {
      if (isPluginMode()) {
        const claudeJsonPath = join(homedir(), '.claude.json');
        const cfg = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
        if (cfg.mcpServers?.mem) {
          delete cfg.mcpServers.mem;
          writeFileSync(claudeJsonPath, JSON.stringify(cfg, null, 2) + '\n');
          debugLog('DEBUG', 'hook-update', 'Post-update: removed stale global MCP "mem"');
        }
      }
    } catch (e) { debugCatch(e, 'post-update-mcp-dedup'); }

    // Post-update: prune old plugin cache versions (keep latest 3)
    try { prunePluginCache(); } catch (e) { debugCatch(e, 'prunePluginCache'); }

    // Post-update: clear cache hooks.json in every remaining version. Claude Code
    // runtime reads plugin hooks from cache, not marketplace source — leaving populated
    // cache hooks.json alongside install.mjs-written settings.json causes double firing.
    // Inline impl (no import of plugin-cache-guard.mjs — this module must run even when
    // the guard module is absent on disk, e.g. auto-upgrading from pre-2.31.2).
    try { clearCacheHookResidue(); } catch (e) { debugCatch(e, 'clearCacheHookResidue'); }

    debugLog('DEBUG', 'hook-update', `Auto-update: switched ${installed.length} paths`);
    return true;
  } catch (err) {
    debugCatch(err, 'installExtractedRelease');

    for (const relPath of installed.reverse()) {
      try { rmSync(join(targetDir, relPath), { recursive: true, force: true }); } catch {}
    }
    for (const relPath of backedUp.reverse()) {
      const backupPath = join(backupDir, relPath);
      const targetPath = join(targetDir, relPath);
      try {
        if (existsSync(backupPath)) {
          mkdirSync(dirname(targetPath), { recursive: true });
          renameSync(backupPath, targetPath);
        }
      } catch (restoreErr) {
        debugCatch(restoreErr, `installExtractedRelease-restore-${relPath}`);
      }
    }

    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    try { rmSync(backupDir, { recursive: true, force: true }); } catch {}
    return false;
  }
}

function copyReleaseIntoStaging(sourceDir, stagingDir) {
  let copied = 0;

  for (const f of SOURCE_FILES) {
    const src = join(sourceDir, f);
    const dest = join(stagingDir, f);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied++;
  }

  for (const dirName of ['scripts', 'registry']) {
    const srcDir = join(sourceDir, dirName);
    const destDir = join(stagingDir, dirName);
    if (!existsSync(srcDir)) continue;
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(srcDir)) {
      copyFileSync(join(srcDir, entry), join(destDir, entry));
    }
  }

  const stagedScripts = join(stagingDir, 'scripts');
  if (existsSync(stagedScripts)) {
    for (const sf of readdirSync(stagedScripts).filter(n => n.endsWith('.sh'))) {
      try { execFileSync('chmod', ['+x', join(stagedScripts, sf)], { stdio: 'pipe' }); } catch {}
    }
  }

  debugLog('DEBUG', 'hook-update', `Auto-update staged ${copied} source files`);
}

// ── Cache hook residue clearing ────────────────────────────
// Inline (does not import plugin-cache-guard.mjs) so hook-update.mjs keeps working
// even if plugin-cache-guard.mjs is missing on disk in degraded installs.
export function clearCacheHookResidue() {
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
  if (!existsSync(cacheBase)) return 0;
  let cleared = 0;
  for (const ver of readdirSync(cacheBase)) {
    const p = join(cacheBase, ver, 'hooks', 'hooks.json');
    if (!existsSync(p)) continue;
    try {
      const h = JSON.parse(readFileSync(p, 'utf8'));
      if (!h.hooks || Object.keys(h.hooks).length === 0) continue;
      writeFileSync(p, JSON.stringify({
        description: h.description || 'claude-mem-lite hooks',
        _note: `Auto-cleared by hook-update.mjs post-install — prevents double hook registration (cache ver: ${ver})`,
        hooks: {},
      }, null, 2) + '\n');
      cleared++;
    } catch { /* ignore single bad entry */ }
  }
  if (cleared > 0) {
    debugLog('DEBUG', 'hook-update', `Cache hooks residue cleared in ${cleared} version(s)`);
  }
  return cleared;
}

// ── Plugin Cache Pruning ──────────────────────────────────
const PLUGIN_CACHE_KEEP = 3;

export function prunePluginCache() {
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
  if (!existsSync(cacheBase)) return 0;

  const entries = readdirSync(cacheBase)
    .filter(name => /^\d+\.\d+/.test(name))  // version-like dirs only
    .sort((a, b) => compareVersions(b, a));   // newest first

  if (entries.length <= PLUGIN_CACHE_KEEP) return 0;

  const toRemove = entries.slice(PLUGIN_CACHE_KEEP);
  let removed = 0;
  for (const ver of toRemove) {
    try {
      rmSync(join(cacheBase, ver), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  if (removed > 0) {
    debugLog('DEBUG', 'hook-update', `Plugin cache pruned: removed ${removed} old version(s), kept latest ${PLUGIN_CACHE_KEEP}`);
  }
  return removed;
}

// ── State Persistence ──────────────────────────────────────
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    const dir = join(INSTALL_DIR, 'runtime');
    mkdirSync(dir, { recursive: true });
    const tmpFile = STATE_FILE + `.tmp-${process.pid}`;
    writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    renameSync(tmpFile, STATE_FILE);
  } catch {}
}
