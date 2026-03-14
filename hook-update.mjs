// claude-mem-lite: Auto-update via GitHub Releases
// Checks for new versions on SessionStart, downloads and installs automatically.
// Skips in dev mode (symlinked installs). Silent on network failure.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DB_DIR } from './schema.mjs';
import { debugCatch, debugLog } from './utils.mjs';

// ── Configuration ──────────────────────────────────────────
const GITHUB_REPO = 'sdsrss/claude-mem-lite';
const INSTALL_DIR = DB_DIR;  // ~/.claude-mem-lite/
const STATE_FILE = join(INSTALL_DIR, 'runtime', 'update-state.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;       // 24 hours
const FETCH_TIMEOUT_MS = 3000;                         // 3s network timeout
const RATE_LIMIT_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h if rate-limited

// ── Main Entry ─────────────────────────────────────────────
export async function checkForUpdate() {
  try {
    if (isDevMode() || process.env.CLAUDE_MEM_SKIP_UPDATE) return null;

    const state = readState();
    if (!shouldCheck(state)) {
      // Return cached update info if previously detected
      if (state.updateAvailable && state.latestVersion) {
        return { updateAvailable: true, from: state.installedVersion, to: state.latestVersion };
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
      const success = await downloadAndInstall(latest.tarballUrl);
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
      };
    }

    // No update needed
    saveState({
      ...state,
      lastCheck: new Date().toISOString(),
      latestVersion: latest.version,
      updateAvailable: false,
      rateLimited: false,
    });
    return null;
  } catch (err) {
    debugCatch(err, 'checkForUpdate');
    return null;
  }
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
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
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
  'server.mjs', 'server-internals.mjs', 'tool-schemas.mjs',
  'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs', 'hook-memory.mjs',
  'hook-semaphore.mjs', 'hook-episode.mjs', 'hook-context.mjs', 'hook-handoff.mjs', 'hook-update.mjs',
  'haiku-client.mjs', 'utils.mjs', 'schema.mjs', 'package.json', 'skill.md',
  'registry.mjs', 'registry-scanner.mjs', 'registry-indexer.mjs',
  'registry-retriever.mjs', 'resource-discovery.mjs',
  'dispatch.mjs', 'dispatch-inject.mjs', 'dispatch-feedback.mjs', 'dispatch-workflow.mjs',
  'install.mjs',
];

// ── Download & Install ─────────────────────────────────────
// Direct file copy instead of running old install.mjs (avoids symlink overwrite in dev)
async function downloadAndInstall(tarballUrl) {
  const tmpDir = join(tmpdir(), `claude-mem-lite-update-${Date.now()}`);
  try {
    mkdirSync(tmpDir, { recursive: true });

    // Download tarball via curl (available on all supported platforms)
    // Validate URL to prevent command injection via crafted tarball URLs
    if (!/^https:\/\/[a-zA-Z0-9./-]+$/.test(tarballUrl)) {
      debugLog('WARN', 'hook-update', `Rejected suspicious tarball URL: ${tarballUrl}`);
      return false;
    }
    execSync(
      `curl -sL -H "Accept: application/vnd.github+json" "${tarballUrl}" | tar xz -C "${tmpDir}" --strip-components=1`,
      { timeout: 30000, stdio: 'pipe' }
    );

    // Direct copy: overwrite source files in INSTALL_DIR
    // Safer than running old install.mjs which may not respect CLAUDE_MEM_DIR
    let copied = 0;
    for (const f of SOURCE_FILES) {
      const src = join(tmpDir, f);
      const dest = join(INSTALL_DIR, f);
      if (existsSync(src)) {
        copyFileSync(src, dest);
        copied++;
      }
    }

    // Copy scripts/ directory if present
    const srcScripts = join(tmpDir, 'scripts');
    if (existsSync(srcScripts)) {
      const destScripts = join(INSTALL_DIR, 'scripts');
      mkdirSync(destScripts, { recursive: true });
      for (const f of readdirSync(srcScripts)) {
        copyFileSync(join(srcScripts, f), join(destScripts, f));
      }
    }

    // Run npm install for dependencies (skip if node_modules is a symlink = dev mode)
    const nmPath = join(INSTALL_DIR, 'node_modules');
    if (!existsSync(nmPath) || !lstatSync(nmPath).isSymbolicLink()) {
      try {
        execSync('npm install --omit=dev', {
          cwd: INSTALL_DIR,
          timeout: 60000,
          stdio: 'pipe',
        });
      } catch (err) {
        debugCatch(err, 'downloadAndInstall-npm');
        // Non-fatal: old node_modules may still work
      }
    }

    debugLog('DEBUG', 'hook-update', `Auto-update: ${copied} files copied`);
    return true;
  } catch (err) {
    debugCatch(err, 'downloadAndInstall');
    return false;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
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
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}
