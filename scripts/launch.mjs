#!/usr/bin/env node
// launch.mjs — Auto-installs dependencies then starts MCP server
// Uses only Node built-ins so it works before npm install
import { execSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');

if (!existsSync(join(ROOT, 'node_modules', 'better-sqlite3'))) {
  process.stderr.write('[claude-mem-lite] Installing dependencies...\n');
  try {
    execSync('npm install --omit=dev', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'], // stdout piped (discard), stderr inherit
      timeout: 120_000,
    });
    process.stderr.write('[claude-mem-lite] Dependencies installed\n');
  } catch (e) {
    // Plugin-cache / multi-user / disk-full installs can fail here. Without this
    // catch the user sees a Node stack trace; with it they get an actionable line.
    const detail = e.message?.split('\n')[0] || e.code || 'unknown error';
    process.stderr.write(`[claude-mem-lite] npm install failed in ${ROOT} — ${detail}\n`);
    process.stderr.write(`[claude-mem-lite] Likely cause: read-only directory, disk full, or network blocked.\n`);
    process.stderr.write(`[claude-mem-lite] Repair: cd "${ROOT}" && npm install --omit=dev\n`);
    process.exit(1);
  }
}

// Verify MCP SDK is importable (exports mapping intact).
// Incomplete installs can leave the directory present but package.json missing,
// causing Node.js to fail resolving subpath exports like /server/mcp.js.
try {
  await import('@modelcontextprotocol/sdk/server/mcp.js');
} catch (firstErr) {
  process.stderr.write(`[claude-mem-lite] MCP SDK broken (${firstErr.code || firstErr.message}) — reinstalling...\n`);
  try {
    execSync('npm install @modelcontextprotocol/sdk --force --omit=dev --no-audit --no-fund', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 60_000,
    });
    // Verify the reinstall actually fixed it
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    process.stderr.write('[claude-mem-lite] MCP SDK repaired\n');
  } catch (e) {
    process.stderr.write(`[claude-mem-lite] MCP SDK repair failed: ${e.message}\n`);
    process.exit(1);
  }
}

// Dev mode: prefer ~/.claude-mem-lite/server.mjs (symlinked to source) over
// CLAUDE_PLUGIN_ROOT (potentially stale plugin cache). This ensures the MCP
// server always runs the latest code when installed with `install --dev`.
const dataDir = join(homedir(), '.claude-mem-lite');
const devServer = join(dataDir, 'server.mjs');
let useDevServer = false;
try { useDevServer = existsSync(devServer) && lstatSync(devServer).isSymbolicLink(); } catch {}

if (useDevServer) {
  await import(pathToFileURL(devServer).href);
} else {
  // Preflight: detect incomplete primary install (issue #15) — if relative
  // imports referenced by server.mjs are missing on disk, fall back to the
  // hook-update.mjs-maintained ~/.claude-mem-lite/ copy when healthy, or exit
  // with a clear repair command instead of a Node ERR_MODULE_NOT_FOUND stack.
  const { resolveLaunchEntry } = await import('./launch-preflight.mjs');
  try {
    const entry = resolveLaunchEntry({
      primaryRoot: ROOT,
      fallbackRoot: dataDir,
      warn: (msg) => process.stderr.write(msg + '\n'),
    });
    await import(pathToFileURL(entry.path).href);
  } catch (e) {
    if (e.code === 'INSTALL_INCOMPLETE') {
      process.stderr.write(e.message + '\n');
      process.exit(1);
    }
    throw e;
  }
}
