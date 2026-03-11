#!/usr/bin/env node
// launch.mjs — Auto-installs dependencies then starts MCP server
// Uses only Node built-ins so it works before npm install
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

await import(new URL('../server.mjs', import.meta.url).href);
