// claude-mem-lite: Auto-update via GitHub Releases
// Checks for new versions on SessionStart, downloads and installs automatically.
// Skips in dev mode (symlinked installs). Silent on network failure.

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, cpSync, readdirSync, existsSync, lstatSync, mkdirSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { DB_DIR, CODE_DIR } from './schema.mjs';
import { debugCatch, debugLog } from './utils.mjs';
// Local manifest is fallback only — the active manifest is loaded from the
// extracted tarball's own source-files.mjs inside installExtractedRelease.
// See loadReleaseManifest below.
import { SOURCE_FILES as LOCAL_SOURCE_FILES, HOOK_SCRIPT_FILES as LOCAL_HOOK_SCRIPT_FILES } from './source-files.mjs';
import { acquireLock } from './lib/proc-lock.mjs';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import { verifyReleaseFiles, verifyManifestSignature } from './lib/release-digest.mjs';

// ── Configuration ──────────────────────────────────────────
const GITHUB_REPO = 'sdsrss/claude-mem-lite';
// Plugin CODE location (server.mjs / package.json / install target) — always
// homedir-rooted, NEVER follows CLAUDE_MEM_DIR (see schema.mjs CODE_DIR). Used
// for dev-mode detection, current-version read, and the install target dir.
const INSTALL_DIR = CODE_DIR;  // ~/.claude-mem-lite/ (code)
// DATA/state location — runtime/update-state.json lives with the data (env-aware
// DB_DIR), matching hook-shared RUNTIME_DIR and install.mjs doctor's read path.
// Equal to INSTALL_DIR unless CLAUDE_MEM_DIR relocates the data dir.
const STATE_DIR = DB_DIR;
const STATE_FILE = join(STATE_DIR, 'runtime', 'update-state.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;       // 24 hours
const FETCH_TIMEOUT_MS = 3000;                         // 3s network timeout
// When rate-limited we got NO release data, so re-check sooner than the normal 24h
// cadence (GitHub's unauthenticated rate-limit window resets within the hour). 6h × ≤2
// requests = 4 polls/day, far under the 60/hr limit, so this is a faster retry, not a hammer.
const RATE_LIMIT_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h retry when rate-limited
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
      // Re-read from disk: a 403 inside fetchWithTimeout just persisted rateLimited:true.
      // Spreading the stale in-memory `state` (captured above with rateLimited:false) would
      // clobber that flag back to false, so shouldCheck never honors the backoff and the
      // rate-limit mechanism is dead. Re-reading preserves the freshly-written flag.
      const fresh = readState();
      saveState({ ...fresh, lastCheck: new Date().toISOString() });
      return null;
    }

    const currentVersion = getCurrentVersion();
    const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

    if (hasUpdate) {
      debugLog('DEBUG', 'hook-update', `Update available: ${currentVersion} → ${latest.version}`);
      const canInstall = !pluginMode && Boolean(allowInstall);
      const success = canInstall ? await downloadAndInstall(latest.tarballUrl, latest.version, latest.assets) : false;
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

// ── Non-blocking SessionStart helpers (audit P3d) ──────────────────────────
// Previously handleSessionStart `await checkForUpdate()` inline, blocking the
// session up to ~3-6s on a GitHub fetch once per 24h. These two helpers split
// that: emit the banner from CACHED state (zero network) and let the network
// refresh run in a detached background worker, so SessionStart never blocks.

// Banner string from cached update-state (≤24h stale), or null. No network I/O.
export function getCachedUpdateBanner() {
  try {
    if (isDevMode() || process.env.CLAUDE_MEM_SKIP_UPDATE) return null;
    const state = readState();
    if (state.updateAvailable && state.latestVersion) {
      // Cached "available" state only persists for deferred installs (plugin mode
      // / allowInstall=false); a successful auto-install clears updateAvailable.
      const hint = isPluginMode()
        ? ' — plugin mode only checks for updates; reinstall/update the plugin to apply it'
        : '';
      return `\n📦 claude-mem-lite: v${state.latestVersion} available (current: v${state.installedVersion})${hint}\n`;
    }
    return null;
  } catch { return null; }
}

// True when a network refresh is due (24h throttle) and updates aren't disabled.
// Caller spawns the refresh in the background so this session doesn't wait.
export function isUpdateCheckDue() {
  try {
    if (isDevMode() || process.env.CLAUDE_MEM_SKIP_UPDATE) return false;
    return shouldCheck(readState());
  } catch { return false; }
}

function isPluginMode() {
  return Boolean(process.env.CLAUDE_PLUGIN_ROOT);
}

// ── Dev Mode Detection ─────────────────────────────────────
function isDevMode() {
  try {
    // A dev checkout always carries a .git dir. This catches a whole-directory
    // symlink (~/.claude-mem-lite -> /repo): lstat on server.mjs there follows the
    // intermediate symlink and sees a regular file, so the per-file probe below
    // would return false and auto-update would clobber the working tree.
    if (existsSync(join(INSTALL_DIR, '.git'))) return true;
    // Standard `install --dev` symlinks individual source files; checking several
    // core files (not just server.mjs) survives the drift case where one file was
    // replaced by a plain copy while the install is still symlink-provisioned —
    // mirrors lib/doctor-drift.mjs's "any symlink ⇒ dev" detection. A copy-based
    // real install (install.mjs non-dev) has no symlinks and no .git, so this
    // cannot false-positive into never auto-updating.
    for (const f of ['server.mjs', 'hook.mjs', 'cli.mjs', 'mem-cli.mjs']) {
      const p = join(INSTALL_DIR, f);
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) return true;
    }
    return false;
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
  // Guard tag_name: a 200-OK with a malformed body ({} / {tag_name:null}) would throw
  // `Cannot read properties of undefined (reading 'replace')`. Caught upstream, but it
  // poisons lastError and blocks the tags fallback below — fall through instead.
  if (result && typeof result.tag_name === 'string') {
    return {
      version: result.tag_name.replace(/^v/, ''),
      tarballUrl: result.tarball_url,
      releaseUrl: result.html_url,
      assets: Array.isArray(result.assets) ? result.assets : [],
    };
  }

  // Attempt 2: Tags API fallback (for repos without formal releases)
  const tags = await fetchWithTimeout(
    `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=1`,
    headers,
  );
  if (tags === 'rate-limited') return null;
  if (Array.isArray(tags) && tags.length > 0 && typeof tags[0]?.name === 'string') {
    const tag = tags[0];
    return {
      version: tag.name.replace(/^v/, ''),
      tarballUrl: `https://api.github.com/repos/${GITHUB_REPO}/tarball/${tag.name}`,
      releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${tag.name}`,
      assets: [],
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
      debugLog('DEBUG', 'hook-update', 'GitHub API rate limited; will retry on the 6h rate-limit cadence');
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

// SWITCHABLE_PATHS = everything in SOURCE_FILES plus the recursive dirs that
// install.mjs copies as whole subtrees (scripts, registry, node_modules). It's
// built per-call from the *tarball's* manifest, not the locally-imported one —
// see loadReleaseManifest comment for why.
function buildSwitchablePaths(sourceFiles) {
  return [...sourceFiles, 'scripts', 'registry', 'node_modules'];
}

// Load the SOURCE_FILES / HOOK_SCRIPT_FILES manifest from the *extracted
// tarball's* own source-files.mjs. Critical: the locally-imported
// LOCAL_SOURCE_FILES is frozen at install time, so any entry added in the
// release we're installing is invisible to the running update. Pre-fix
// (≤ v2.83.2) used LOCAL_SOURCE_FILES for both copyReleaseIntoStaging and
// SWITCHABLE_PATHS — v2.80.x → v2.81.0 auto-update copied the new hook.mjs
// (in the v2.80 manifest) but skipped lib/cite-back-hint.mjs (added in v2.81),
// breaking SessionStart on every machine that auto-updated and killing the
// hook chain that would otherwise self-heal on the next round.
async function loadReleaseManifest(sourceDir) {
  const manifestPath = join(sourceDir, 'source-files.mjs');
  if (!existsSync(manifestPath)) {
    return { SOURCE_FILES: LOCAL_SOURCE_FILES, HOOK_SCRIPT_FILES: LOCAL_HOOK_SCRIPT_FILES, source: 'fallback-missing' };
  }
  try {
    const mod = await import(pathToFileURL(manifestPath).href + `?t=${Date.now()}`);
    if (!Array.isArray(mod.SOURCE_FILES) || mod.SOURCE_FILES.length === 0) {
      throw new Error('SOURCE_FILES missing or empty');
    }
    if (!Array.isArray(mod.HOOK_SCRIPT_FILES)) {
      throw new Error('HOOK_SCRIPT_FILES missing');
    }
    return { SOURCE_FILES: mod.SOURCE_FILES, HOOK_SCRIPT_FILES: mod.HOOK_SCRIPT_FILES, source: 'tarball' };
  } catch (e) {
    debugCatch(e, 'loadReleaseManifest');
    return { SOURCE_FILES: LOCAL_SOURCE_FILES, HOOK_SCRIPT_FILES: LOCAL_HOOK_SCRIPT_FILES, source: 'fallback-error' };
  }
}

// ── Download & Install ─────────────────────────────────────
// Direct file copy instead of running old install.mjs (avoids symlink overwrite in dev)
async function downloadAndInstall(tarballUrl, expectedVersion, assets = []) {
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

    const validation = validateExtractedTarball(tmpDir, expectedVersion);
    if (!validation.ok) {
      debugLog('WARN', 'hook-update', `Tarball validation failed: ${validation.reason}`);
      return false;
    }

    // P1 supply-chain: cryptographically verify the release before installing.
    // Opportunistic + inert until keyed — ok=false ONLY on a real tampering
    // signal (signature present but invalid, or a file hash mismatch). Missing
    // key / missing signature assets / fetch failure / escape hatch all proceed,
    // so this never bricks auto-update for unsigned or pre-key releases.
    const authentic = await verifyReleaseAuthenticity(tmpDir, assets);
    if (!authentic.ok) {
      debugLog('WARN', 'hook-update', `Release authenticity check failed (${authentic.action}) — aborting update`);
      return false;
    }

    return await installExtractedRelease(tmpDir);
  } catch (err) {
    debugCatch(err, 'downloadAndInstall');
    return false;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Defense-in-depth check on the extracted GitHub tarball before we hand it to
// installExtractedRelease (which runs `npm install` in staging). Catches:
// - tarball whose package.json `name` is not claude-mem-lite (repo rename / squatter)
// - tarball whose `version` does not match the GitHub tag we resolved (replay /
//   wrong-version artifact)
// - tarball missing critical entry points (truncated download / wrong content)
//
// This is NOT a full signature check. A motivated attacker who controls the
// repo can rewrite package.json. Future: GitHub release attestations
// (`gh attestation verify`) — requires publish.yml to opt into attestations
// and a sigstore trust anchor.
export function validateExtractedTarball(sourceDir, expectedVersion, expectedName = 'claude-mem-lite') {
  const pkgPath = join(sourceDir, 'package.json');
  if (!existsSync(pkgPath)) return { ok: false, reason: 'package.json missing in extracted tarball' };

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `package.json unparseable: ${e.message}` };
  }

  if (pkg.name !== expectedName) {
    return { ok: false, reason: `package.json name "${pkg.name}" !== "${expectedName}"` };
  }

  if (expectedVersion && pkg.version !== expectedVersion) {
    return { ok: false, reason: `package.json version "${pkg.version}" !== expected "${expectedVersion}"` };
  }

  for (const entry of ['cli.mjs', 'server.mjs', 'hook.mjs']) {
    if (!existsSync(join(sourceDir, entry))) {
      return { ok: false, reason: `entry-point file missing: ${entry}` };
    }
  }

  return { ok: true };
}

// ── Release signature verification (P1 supply-chain hardening) ──────────────
// Embedded Ed25519 PUBLIC key (SPKI PEM). ACTIVE since v3.20.0 — auto-update now
// FAILS CLOSED: a release missing valid signature assets is refused (the matching
// private key is the GitHub Actions secret RELEASE_SIGNING_KEY; signer:
// scripts/sign-release.mjs; verifier core: lib/release-digest.mjs). The signature
// over v3.19.0's published manifest was verified against this key end-to-end
// before activation. The CLAUDE_MEM_SKIP_SIG_VERIFY env escape hatch still forces a
// skip. To ROTATE: generate a new keypair, set the new private key as the secret
// and ship one signed release with it BEFORE replacing the key below — embedding a
// key whose releases are not yet signed bricks auto-update (fail-closed on unsigned).
// Setting this back to '' reverts to opportunistic (install-unsigned) behavior.
const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAau5x65mqsYxJU2cO2ORteueK71EuB4aphVZds8FOZKk=
-----END PUBLIC KEY-----
`;
const MANIFEST_ASSET_NAME = 'release-manifest.json';
const SIGNATURE_ASSET_NAME = 'release-manifest.json.sig';

// Pure verifier (no I/O) — exported for unit testing. ok=true ONLY when the
// Ed25519 signature over `manifestBytes` is valid for `publicKeyPem` AND every
// file the manifest lists matches its sha256 under `extractedDir`.
export function verifyDownloadedRelease(extractedDir, manifestBytes, signatureB64, publicKeyPem = RELEASE_PUBLIC_KEY) {
  if (!verifyManifestSignature(manifestBytes, signatureB64, publicKeyPem)) {
    return { ok: false, reason: 'signature-invalid' };
  }
  let manifest;
  try {
    manifest = JSON.parse(Buffer.isBuffer(manifestBytes) ? manifestBytes.toString('utf8') : String(manifestBytes));
  } catch {
    return { ok: false, reason: 'manifest-unparseable' };
  }
  const files = verifyReleaseFiles(extractedDir, manifest);
  if (!files.ok) {
    return { ok: false, reason: `file-mismatch: ${[...files.mismatches, ...files.missing].slice(0, 5).join(', ')}` };
  }
  return { ok: true, reason: 'verified' };
}

// Fetch a GitHub Release asset as a Buffer. Host-locked to github.com (the asset
// browser_download_url); GitHub's own 302 to its CDN is followed by fetch.
async function fetchAssetBuffer(url) {
  if (!/^https:\/\/github\.com\/[\w./%~-]+$/.test(url || '')) {
    throw new Error(`rejected asset url: ${url}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

// I/O gate called from downloadAndInstall after validateExtractedTarball.
// Two regimes, switched by whether a public key is embedded:
//   • No embedded key (the shipped default, RELEASE_PUBLIC_KEY=''): INERT —
//     skipped-no-pubkey so an un-provisioned key can never brick auto-update.
//   • Key embedded (signing active): FAIL CLOSED — a missing signature asset, a
//     signature-asset fetch failure, or an invalid signature all return ok=false.
//     Once we publish signed releases, an attacker who can publish a release or MITM
//     the asset CDN must not bypass verification by stripping the signature assets
//     (the tags-fallback path also sends assets:[]). A transient fetch failure only
//     defers the install to the next ~6h poll, not a permanent brick. (audit P1 #5)
// The CLAUDE_MEM_SKIP_SIG_VERIFY escape hatch still forces a skip. publicKey is a
// param (defaulting to the embedded constant) only so tests can exercise both regimes.
export async function verifyReleaseAuthenticity(extractedDir, assets, publicKey = RELEASE_PUBLIC_KEY) {
  if (process.env.CLAUDE_MEM_SKIP_SIG_VERIFY) return { ok: true, action: 'skipped-env' };
  if (!publicKey) return { ok: true, action: 'skipped-no-pubkey' };

  const list = Array.isArray(assets) ? assets : [];
  const manifestAsset = list.find(a => a && a.name === MANIFEST_ASSET_NAME);
  const sigAsset = list.find(a => a && a.name === SIGNATURE_ASSET_NAME);
  if (!manifestAsset || !sigAsset) {
    debugLog('WARN', 'hook-update', 'Signed-release mode: release carries no signature assets — refusing to install (possible downgrade/strip)');
    return { ok: false, action: 'missing-signature' };
  }

  let manifestBytes, signatureB64;
  try {
    manifestBytes = await fetchAssetBuffer(manifestAsset.browser_download_url);
    signatureB64 = (await fetchAssetBuffer(sigAsset.browser_download_url)).toString('utf8').trim();
  } catch (e) {
    // Can't fetch the signature → can't verify → don't install this cycle (retries next poll).
    debugLog('WARN', 'hook-update', `Signed-release mode: signature asset fetch failed (${e.message}) — refusing to install this cycle`);
    return { ok: false, action: 'signature-fetch-failed' };
  }

  const r = verifyDownloadedRelease(extractedDir, manifestBytes, signatureB64, publicKey);
  if (!r.ok) return { ok: false, action: r.reason };
  debugLog('DEBUG', 'hook-update', 'Release signature verified');
  return { ok: true, action: 'verified' };
}

// opts.skipNpmInstall — copy + atomically switch the source files WITHOUT
// running `npm install` in staging. Used by syncDataDirFromCache: when the
// source is a local plugin-cache version (not a downloaded tarball), the
// target data dir already carries a working, ABI-correct node_modules, so a
// reinstall is pure cost. With staging holding no node_modules the switch loop
// below skips the 'node_modules' switchable path (existsSync guard), leaving
// the target's node_modules untouched. Dependency bumps still flow through the
// GitHub-tarball path (downloadAndInstall), which keeps skipNpmInstall=false.
// Undo a (partial or complete) file swap: delete the freshly-installed files, then
// rename each backup back into place. Shared by the error path and the MED-5
// post-install smoke gate so there is ONE rollback implementation.
function rollbackInstall(installed, backedUp, backupDir, targetDir) {
  for (const relPath of installed.reverse()) {
    try { rmSync(join(targetDir, relPath), { recursive: true, force: true }); } catch { /* best-effort */ }
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
}

// MED-5 post-install health gate: load-test the freshly-switched code in a SEPARATE
// process before the backup is discarded. A clean file swap can still yield an
// install that won't boot — a syntax error, an unresolved import from a half-applied
// mixed-version swap (renameSync loop hard-killed mid-way), or a native ABI mismatch.
// `cli.mjs help` boots the CLI entry, which dynamically imports the mem-cli module
// graph (maintain-core / search-engine / scoring / db-backup / schema / …) and exits
// 0 without opening the DB or a server. hook.mjs and server.mjs auto-execute on
// import (so they can't be import-smoked) — they get a `node --check` syntax pass.
// execSync (not execFileSync) so the unit-test child_process mock intercepts it.
function smokeInstalledRelease(targetDir) {
  const q = (s) => JSON.stringify(s);
  try {
    execSync(`${q(process.execPath)} ${q(join(targetDir, 'cli.mjs'))} help`, { timeout: 20000, stdio: 'ignore' });
    for (const entry of ['hook.mjs', 'server.mjs']) {
      const p = join(targetDir, entry);
      if (existsSync(p)) execSync(`${q(process.execPath)} --check ${q(p)}`, { timeout: 10000, stdio: 'ignore' });
    }
    return true;
  } catch (e) {
    debugLog('WARN', 'hook-update', `post-install smoke failed (rolling back): ${e.message}`);
    return false;
  }
}

export async function installExtractedRelease(sourceDir, targetDir = INSTALL_DIR, opts = {}) {
  // Cross-process lock: concurrent SessionStart self-heals / auto-updates must
  // not interleave the rename loop below (→ mixed-version install). A live peer
  // holding the lock means an install is already in flight — skip rather than
  // race. Shared path with install.mjs so direct install + repair + auto-update
  // are mutually exclusive.
  const release = acquireLock(join(STATE_DIR, 'runtime', 'install.lock'));
  if (!release) {
    debugLog('DEBUG', 'hook-update', 'installExtractedRelease: another install/update is in progress — skipping');
    return false;
  }
  const ts = `${Date.now()}-${process.pid}`;
  const stagingDir = join(targetDir, `.update-staging-${ts}`);
  const backupDir = join(targetDir, `.update-backup-${ts}`);
  const backedUp = [];
  const installed = [];

  const manifest = await loadReleaseManifest(sourceDir);
  const switchablePaths = buildSwitchablePaths(manifest.SOURCE_FILES);

  try {
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });

    copyReleaseIntoStaging(sourceDir, stagingDir, manifest);
    if (!opts.skipNpmInstall) {
      execSync(NPM_INSTALL_CMD, {
        cwd: stagingDir,
        timeout: 60000,
        stdio: 'pipe',
      });
    }

    for (const relPath of switchablePaths) {
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

    // MED-5: before discarding the rollback backup, prove the switched code boots.
    // If it can't, restore the backup and report failure — the running (old) version
    // keeps working rather than leaving a broken install with no way back.
    if (!opts.skipSmoke && !smokeInstalledRelease(targetDir)) {
      rollbackInstall(installed, backedUp, backupDir, targetDir);
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
      return false;
    }

    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });

    // Post-update migration: clean stale global MCPs if plugin handles it.
    // Both "mem" (legacy, pre-v2.78) and "mem-lite" (current) are purged so a
    // user who manually ran `claude mcp add` in either era doesn't end up with
    // duplicate global + plugin registrations after the rename.
    try {
      if (isPluginMode()) {
        const claudeJsonPath = join(homedir(), '.claude.json');
        const cfg = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
        let changed = false;
        for (const k of ['mem', 'mem-lite']) {
          if (cfg.mcpServers?.[k]) {
            delete cfg.mcpServers[k];
            changed = true;
            debugLog('DEBUG', 'hook-update', `Post-update: removed stale global MCP "${k}"`);
          }
        }
        // Atomic + one-time backup: ~/.claude.json is the user's ENTIRE Claude
        // Code config; a torn write here breaks them outside our control.
        if (changed) atomicWriteFileSync(claudeJsonPath, JSON.stringify(cfg, null, 2) + '\n', { backup: true });
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
    rollbackInstall(installed, backedUp, backupDir, targetDir);
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return false;
  } finally {
    release();
  }
}

// ── Plugin-cache → data-dir code sync ──────────────────────
// Root cause this fixes: a plugin-mode install carries TWO independently
// versioned code copies sharing one DB. The plugin cache
// (~/.claude/plugins/cache/<mp>/claude-mem-lite/<ver>/) runs the MCP server and
// is advanced by Claude Code's marketplace updater; on launch it opens the
// shared DB and migrates the schema FORWARD. The data-dir copy
// (~/.claude-mem-lite/) backs the standalone CLI symlink and the settings.json
// hooks, but is only advanced by the GitHub-tarball auto-update — which plugin
// mode disables (allowInstall=false) and which stalls easily (24h throttle,
// rate limits, staging npm install). The data-dir code then lags the schema the
// cache wrote and the CLI/hooks fail to open the DB
// ("schema is vN but binary supports up to vN-1").
//
// Fix: make the data-dir code TRACK the plugin-cache version. The exact files
// are already on disk in the cache, so this is a local source-file copy — no
// network, no npm install — and the synced code is precisely the version that
// migrated the DB, so schema compatibility is guaranteed by construction.
// node_modules is left untouched (skipNpmInstall). Only ever upgrades; equal
// versions no-op, which is the natural per-session throttle.
//
// opts.sourceDir   — explicit source (launch.mjs passes the running ROOT, the
//                    exact version that owns the migrated DB). Omitted → scan
//                    the plugin cache for the highest valid version.
// opts.targetDir   — defaults to INSTALL_DIR (the homedir code dir, NOT
//                    CLAUDE_MEM_DIR — see schema.mjs CODE_DIR / #8632).
// opts.cacheBase   — override the cache root (tests).
export async function syncDataDirFromCache(opts = {}) {
  try {
    const targetDir = opts.targetDir || INSTALL_DIR;

    // Dev install: the data-dir entries are symlinks into the source repo.
    // Overwriting them would clobber the working tree — never sync.
    if (isDevMode()) return { synced: false, reason: 'dev-mode' };

    let sourceDir = opts.sourceDir || null;
    if (!sourceDir) {
      const cacheBase = opts.cacheBase
        || join(homedir(), '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      if (!existsSync(cacheBase)) return { synced: false, reason: 'no-cache' };
      const versions = readdirSync(cacheBase)
        .filter(n => /^\d+\.\d+/.test(n))
        .sort((a, b) => compareVersions(b, a));   // newest first
      for (const v of versions) {
        const dir = join(cacheBase, v);
        if (validateExtractedTarball(dir, null).ok) { sourceDir = dir; break; }
      }
      if (!sourceDir) return { synced: false, reason: 'no-valid-cache-version' };
    }

    // Non-plugin direct install: ROOT === data dir. Syncing a dir onto itself
    // is a no-op at best and a same-path rename hazard at worst.
    if (resolve(sourceDir) === resolve(targetDir)) {
      return { synced: false, reason: 'source-is-target' };
    }

    // Only heal an EXISTING standalone-CLI code install — the case that actually
    // drifts. A pure-plugin user's ~/.claude-mem-lite/ holds only DATA (DB +
    // runtime, maybe node_modules) and runs ALL code from the cache; setup.sh
    // never materializes source files there. Writing them in would create a
    // non-functional orphan code tree and make launch-preflight's fallback
    // mis-detect it as a complete install. Require proof of a real prior code
    // install: package.json AND a resolvable better-sqlite3 binding (both present
    // on a drifted direct install; absent for a pure-plugin data dir).
    if (!existsSync(join(targetDir, 'package.json'))
        || !existsSync(join(targetDir, 'node_modules', 'better-sqlite3'))) {
      return { synced: false, reason: 'no-existing-code-install' };
    }

    const val = validateExtractedTarball(sourceDir, null);
    if (!val.ok) return { synced: false, reason: `invalid-source: ${val.reason}` };

    let sourceVersion;
    try {
      sourceVersion = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')).version;
    } catch { return { synced: false, reason: 'source-version-unreadable' }; }

    let dataVersion = '0.0.0';
    try {
      dataVersion = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')).version || '0.0.0';
    } catch { /* missing/corrupt target package.json → treat as 0.0.0, sync */ }

    // Only ever upgrade. Equal → no-op (cheap version compare runs every session).
    if (compareVersions(sourceVersion, dataVersion) <= 0) {
      return { synced: false, reason: 'data-dir-current', sourceVersion, dataVersion };
    }

    debugLog('DEBUG', 'hook-update',
      `Syncing data-dir code ${dataVersion} → ${sourceVersion} from plugin cache (${sourceDir})`);
    const ok = await installExtractedRelease(sourceDir, targetDir, { skipNpmInstall: true });
    return ok
      ? { synced: true, from: dataVersion, to: sourceVersion }
      : { synced: false, reason: 'install-failed', from: dataVersion, to: sourceVersion };
  } catch (err) {
    debugCatch(err, 'syncDataDirFromCache');
    return { synced: false, reason: 'error' };
  }
}

function copyReleaseIntoStaging(sourceDir, stagingDir, manifest = { SOURCE_FILES: LOCAL_SOURCE_FILES, HOOK_SCRIPT_FILES: LOCAL_HOOK_SCRIPT_FILES }) {
  let copied = 0;

  for (const f of manifest.SOURCE_FILES) {
    const src = join(sourceDir, f);
    const dest = join(stagingDir, f);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied++;
  }

  // scripts/ is curated to HOOK_SCRIPT_FILES — settings.json hook commands
  // resolve only to these 5 files, and plugin mode does not consume this
  // directory at all. Pre-v2.55 used cpSync({recursive:true}) which silently
  // shipped dev-only files (mock-claude.mjs, extract-repos.mjs, p0-forward-probe.mjs…)
  // from the GitHub Releases tarball into every user's data dir.
  const stagingScripts = join(stagingDir, 'scripts');
  const sourceScripts = join(sourceDir, 'scripts');
  if (existsSync(sourceScripts)) {
    mkdirSync(stagingScripts, { recursive: true });
    for (const name of manifest.HOOK_SCRIPT_FILES) {
      const src = join(sourceScripts, name);
      if (existsSync(src)) copyFileSync(src, join(stagingScripts, name));
    }
  }

  // registry/ stays recursive — preinstalled.json is the only current entry
  // but the directory is consumed wholesale by the registry indexer and may
  // grow subtrees. Pre-v2.55 readdirSync+copyFileSync would EISDIR-throw on
  // any subdir and silently roll back the entire update.
  const sourceRegistry = join(sourceDir, 'registry');
  if (existsSync(sourceRegistry)) {
    cpSync(sourceRegistry, join(stagingDir, 'registry'), { recursive: true });
  }

  const stagedScripts = join(stagingDir, 'scripts');
  if (existsSync(stagedScripts)) {
    for (const sf of readdirSync(stagedScripts).filter(n => n.endsWith('.sh'))) {
      try { chmodSync(join(stagedScripts, sf), 0o755); } catch (e) { debugCatch(e, 'chmod-script'); }
    }
  }

  // cli.mjs is invoked via the ~/.local/bin/claude-mem-lite symlink, which needs
  // the target executable. copyFileSync preserves the source mode and git stores
  // cli.mjs as 100644 — without this chmod, auto-update strips the +x bit set by
  // install.mjs:408 and the next CLI invocation dies with "Permission denied".
  const stagedCli = join(stagingDir, 'cli.mjs');
  if (existsSync(stagedCli)) {
    try { chmodSync(stagedCli, 0o755); } catch (e) { debugCatch(e, 'chmod-cli'); }
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
    const dir = join(STATE_DIR, 'runtime');
    mkdirSync(dir, { recursive: true });
    const tmpFile = STATE_FILE + `.tmp-${process.pid}`;
    writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    renameSync(tmpFile, STATE_FILE);
  } catch {}
}
