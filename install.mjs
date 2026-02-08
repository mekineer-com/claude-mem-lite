#!/usr/bin/env node
// claude-mem-lite Installer — Smart install/uninstall/status/doctor

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const PROJECT_DIR = resolve(import.meta.dirname || '.');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const SERVER_PATH = join(PROJECT_DIR, 'server.mjs');
const HOOK_PATH = join(PROJECT_DIR, 'hook.mjs');

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

// ─── Install ────────────────────────────────────────────────────────────────

async function install() {
  console.log('\nclaude-mem-lite installer\n');

  // 1. npm install
  if (!existsSync(join(PROJECT_DIR, 'node_modules'))) {
    log('Installing dependencies...');
    try {
      execSync('npm install --production', { cwd: PROJECT_DIR, stdio: 'pipe' });
      ok('Dependencies installed');
    } catch (e) {
      fail('npm install failed: ' + e.message);
      process.exit(1);
    }
  } else {
    ok('Dependencies already installed');
  }

  // 2. Register MCP server
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

  // 3. Configure hooks
  log('Configuring hooks...');
  const settings = readSettings();
  settings.hooks = settings.hooks || {};

  settings.hooks.PostToolUse = [{
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node ${HOOK_PATH} post-tool-use`,
      timeout: 5
    }]
  }];

  settings.hooks.SessionStart = [{
    matcher: 'startup|clear|compact',
    hooks: [{
      type: 'command',
      command: `node ${HOOK_PATH} session-start`,
      timeout: 10
    }]
  }];

  settings.hooks.Stop = [{
    hooks: [{
      type: 'command',
      command: `node ${HOOK_PATH} stop`,
      timeout: 5
    }]
  }];

  writeSettings(settings);
  ok('Hooks configured (PostToolUse, SessionStart, Stop)');

  // 4. Verify database
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

  // 5. Disable old claude-mem plugin
  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    settings.enabledPlugins['claude-mem@thedotmack'] = false;
    writeSettings(settings);
    ok('Old claude-mem plugin disabled');
  }

  // 6. Clean old processes
  try {
    execSync('pkill -f chroma-mcp 2>/dev/null || true', { stdio: 'pipe' });
    execSync('pkill -f "claude-mem.*worker" 2>/dev/null || true', { stdio: 'pipe' });
  } catch {}

  // 7. Offer to clean vector-db
  const vectorDbPath = join(homedir(), '.claude-mem', 'vector-db');
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

  // 2. Remove hooks
  const settings = readSettings();
  if (settings.hooks) {
    const hookPath = HOOK_PATH;
    for (const [event, configs] of Object.entries(settings.hooks)) {
      settings.hooks[event] = configs.filter(cfg => {
        if (!cfg.hooks) return true;
        return !cfg.hooks.some(h => h.command?.includes(hookPath) || h.command?.includes('hook.mjs'));
      });
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeSettings(settings);
    ok('Hooks removed');
  }

  // 3. Purge data if requested
  if (flags.has('--purge')) {
    const memDir = join(homedir(), '.claude-mem');
    if (existsSync(memDir)) {
      rmSync(memDir, { recursive: true, force: true });
      ok('Data purged (~/.claude-mem/)');
    }
  } else {
    log('Data preserved in ~/.claude-mem/ (use --purge to remove)');
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
  const vectorDb = join(homedir(), '.claude-mem', 'vector-db');
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
  const bsPath = join(PROJECT_DIR, 'node_modules', 'better-sqlite3');
  if (existsSync(bsPath)) {
    ok('better-sqlite3: installed');
  } else {
    fail('better-sqlite3: not installed (run: npm install)');
    issues++;
  }

  const mcpPath = join(PROJECT_DIR, 'node_modules', '@modelcontextprotocol');
  if (existsSync(mcpPath)) {
    ok('@modelcontextprotocol/sdk: installed');
  } else {
    fail('@modelcontextprotocol/sdk: not installed');
    issues++;
  }

  // Server file
  if (existsSync(SERVER_PATH)) {
    ok('server.mjs: exists');
  } else {
    fail('server.mjs: missing');
    issues++;
  }

  // Hook file
  if (existsSync(HOOK_PATH)) {
    ok('hook.mjs: exists');
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
    console.log(`
claude-mem-lite — Lightweight memory system for Claude Code

Usage:
  node install.mjs install          Install and configure
  node install.mjs uninstall        Remove (keep data)
  node install.mjs uninstall --purge  Remove and delete all data
  node install.mjs status           Show current status
  node install.mjs doctor           Diagnose issues
`);
}
