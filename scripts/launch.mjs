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
  execSync('npm install --omit=dev', {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'], // stdout piped (discard), stderr inherit
    timeout: 120_000,
  });
  process.stderr.write('[claude-mem-lite] Dependencies installed\n');
}

// Dev mode: prefer ~/.claude-mem-lite/server.mjs (symlinked to source) over
// CLAUDE_PLUGIN_ROOT (potentially stale plugin cache). This ensures the MCP
// server always runs the latest code when installed with `install --dev`.
const devServer = join(homedir(), '.claude-mem-lite', 'server.mjs');
let useDevServer = false;
try { useDevServer = existsSync(devServer) && lstatSync(devServer).isSymbolicLink(); } catch {}

if (useDevServer) {
  await import(pathToFileURL(devServer).href);
} else {
  await import(new URL('../server.mjs', import.meta.url).href);
}
