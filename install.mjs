#!/usr/bin/env node
// claude-mem-lite Installer — Smart install/uninstall/status/doctor

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, cpSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const PROJECT_DIR = resolve(import.meta.dirname || '.');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const DATA_DIR = join(homedir(), 'claude-mem-lite');
const DB_PATH = join(DATA_DIR, 'claude-mem.db');
const OLD_DATA_DIR = join(homedir(), '.claude-mem');

// Detect ephemeral context (npx) — files won't persist after exit
const IS_NPX = process.env.npm_command === 'exec' ||
  PROJECT_DIR.includes('_npx') || PROJECT_DIR.includes('.npm/_');

// For npx: install runtime files to ~/claude-mem-lite/
// For git clone: use files in-place from the cloned repo
const INSTALL_DIR = IS_NPX ? DATA_DIR : PROJECT_DIR;
const SERVER_PATH = join(INSTALL_DIR, 'server.mjs');
const HOOK_PATH = join(INSTALL_DIR, 'hook.mjs');

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

// ─── Install ────────────────────────────────────────────────────────────────

async function install() {
  console.log('\nclaude-mem-lite installer\n');

  // 1. Copy source files to persistent location (npx mode)
  if (IS_NPX) {
    log('npx detected — installing to ~/claude-mem-lite/...');
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const scriptsDir = join(DATA_DIR, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    for (const f of ['server.mjs', 'hook.mjs', 'package.json', 'skill.md', 'scripts/post-tool-use.sh']) {
      const src = join(PROJECT_DIR, f);
      if (existsSync(src)) copyFileSync(src, join(DATA_DIR, f));
    }
    // Ensure bash script is executable
    try { execSync(`chmod +x "${join(scriptsDir, 'post-tool-use.sh')}"`, { stdio: 'pipe' }); } catch {}
    ok('Source files copied to ~/claude-mem-lite/');
  }

  // 2. npm install
  if (!existsSync(join(INSTALL_DIR, 'node_modules'))) {
    log('Installing dependencies...');
    try {
      execSync('npm install --production', { cwd: INSTALL_DIR, stdio: 'pipe' });
      ok('Dependencies installed');
    } catch (e) {
      fail('npm install failed: ' + e.message);
      process.exit(1);
    }
  } else {
    ok('Dependencies already installed');
  }

  // 3. Register MCP server
  log('Registering MCP server...');
  try {
    // Remove existing first (ignore errors)
    try { execSync('claude mcp remove -s user mem', { stdio: 'pipe' }); } catch {}
    execSync(`claude mcp add -s user -t stdio mem -- node ${SERVER_PATH}`, { stdio: 'pipe' });
    ok('MCP server registered: mem');
  } catch (e) {
    fail('MCP registration failed: ' + e.message);
    warn('Try manually: claude mcp add -s user -t stdio mem -- node ' + SERVER_PATH);
  }

  // 4. Configure hooks (merge: preserve user's existing hooks, replace ours)
  log('Configuring hooks...');
  const settings = readSettings();
  settings.hooks = settings.hooks || {};

  const PREFILTER_PATH = join(INSTALL_DIR, 'scripts', 'post-tool-use.sh');

  const memPostToolUse = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `bash ${PREFILTER_PATH}`,
      timeout: 5
    }]
  };

  const memSessionStart = {
    matcher: 'startup|clear|compact',
    hooks: [{
      type: 'command',
      command: `node ${HOOK_PATH} session-start`,
      timeout: 10
    }]
  };

  const memStop = {
    hooks: [{
      type: 'command',
      command: `node ${HOOK_PATH} stop`,
      timeout: 5
    }]
  };

  // Filter out existing mem hooks, then append fresh ones
  for (const [event, config] of [['PostToolUse', memPostToolUse], ['SessionStart', memSessionStart], ['Stop', memStop]]) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event].filter(cfg => !isMemHook(cfg)) : [];
    settings.hooks[event] = [...existing, config];
  }

  writeSettings(settings);
  ok('Hooks configured (PostToolUse, SessionStart, Stop)');

  // 5. Migrate from old ~/.claude-mem/ if needed
  if (existsSync(join(OLD_DATA_DIR, 'claude-mem.db')) && !existsSync(DB_PATH)) {
    log('Detected old ~/.claude-mem/ directory, migrating to ~/claude-mem-lite/...');
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      // Migrate database and WAL/SHM files
      for (const f of ['claude-mem.db', 'claude-mem.db-wal', 'claude-mem.db-shm']) {
        const src = join(OLD_DATA_DIR, f);
        if (existsSync(src)) copyFileSync(src, join(DATA_DIR, f));
      }
      // Migrate runtime directory
      const oldRuntime = join(OLD_DATA_DIR, 'runtime');
      const newRuntime = join(DATA_DIR, 'runtime');
      if (existsSync(oldRuntime) && !existsSync(newRuntime)) {
        cpSync(oldRuntime, newRuntime, { recursive: true });
      }
      ok('Data migrated from ~/.claude-mem/ → ~/claude-mem-lite/');
      log('Old ~/.claude-mem/ preserved (remove manually when ready)');
    } catch (e) {
      warn('Migration failed: ' + e.message);
      log('You can copy manually: cp ~/.claude-mem/claude-mem.db ~/claude-mem-lite/');
    }
  }

  // 6. Verify database
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

  // 7. Disable old claude-mem plugin
  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    settings.enabledPlugins['claude-mem@thedotmack'] = false;
    writeSettings(settings);
    ok('Old claude-mem plugin disabled');
  }

  // 8. Clean old processes
  try {
    execSync('pkill -f chroma-mcp 2>/dev/null || true', { stdio: 'pipe' });
    execSync('pkill -f "claude-mem.*worker" 2>/dev/null || true', { stdio: 'pipe' });
  } catch {}

  // 9. Offer to clean old vector-db
  const vectorDbPath = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDbPath)) {
    try {
      const size = execSync(`du -sh "${vectorDbPath}" 2>/dev/null`, { encoding: 'utf8' }).trim().split('\t')[0];
      warn(`Old vector-db exists (${size}). Run: rm -rf ~/.claude-mem/vector-db/`);
    } catch {}
  }

  console.log('\n  Done! Restart Claude Code to activate.\n');
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

async function uninstall() {
  console.log('\nclaude-mem-lite uninstaller\n');

  // 1. Remove MCP
  try {
    execSync('claude mcp remove -s user mem', { stdio: 'pipe' });
    ok('MCP server removed');
  } catch {
    warn('MCP server not found or already removed');
  }

  // 2. Remove hooks (match both npx and git-clone install paths)
  const settings = readSettings();
  if (settings.hooks) {
    for (const [event, configs] of Object.entries(settings.hooks)) {
      settings.hooks[event] = configs.filter(cfg => !isMemHook(cfg));
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeSettings(settings);
    ok('Hooks removed');
  }

  // 3. Purge data if requested
  if (flags.has('--purge')) {
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      ok('Data purged (~/claude-mem-lite/)');
    }
  } else {
    log('Data preserved in ~/claude-mem-lite/ (use --purge to remove)');
  }

  console.log('\n  Done!\n');
}

// ─── Status ─────────────────────────────────────────────────────────────────

async function status() {
  console.log('\nclaude-mem-lite status\n');

  // MCP
  try {
    const list = execSync('claude mcp list 2>/dev/null', { encoding: 'utf8' });
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
  const hasHooks = settings.hooks && Object.values(settings.hooks).some(configs =>
    configs.some(cfg => cfg.hooks?.some(h => h.command?.includes('hook.mjs')))
  );
  if (hasHooks) {
    ok('Hooks: configured');
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
    if (procs) {
      warn('Old processes running:\n    ' + procs.split('\n').join('\n    '));
      issues++;
    }
  } catch {
    ok('No stale processes');
  }

  console.log(`\n  ${issues === 0 ? 'All checks passed!' : `${issues} issue(s) found.`}\n`);
}

// ─── Settings helpers ───────────────────────────────────────────────────────

function isMemHook(cfg) {
  if (!cfg.hooks) return false;
  return cfg.hooks.some(h =>
    h.command?.includes('claude-mem-lite') ||
    h.command?.includes('hook.mjs') ||
    h.command?.includes('post-tool-use.sh')
  );
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

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
  default:
    if (IS_NPX) {
      // npx claude-mem-lite (no args) → auto install
      await install();
    } else {
      console.log(`
claude-mem-lite — Lightweight memory system for Claude Code

Usage:
  node install.mjs install            Install and configure
  node install.mjs uninstall          Remove (keep data)
  node install.mjs uninstall --purge  Remove and delete all data
  node install.mjs status             Show current status
  node install.mjs doctor             Diagnose issues

  npx claude-mem-lite                 Install via npx (one-liner)
`);
    }
}
