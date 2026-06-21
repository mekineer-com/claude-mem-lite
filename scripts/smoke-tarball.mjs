#!/usr/bin/env node
// Real-install smoke test (audit item ①).
//
// The riskiest install path — `npm pack` → real `npm install` of the tarball →
// better-sqlite3 native rebuild → import entry points → open a DB — is exercised
// by NOTHING else in CI:
//   * install-e2e.test.mjs runs `--dev` (symlinks, skips `npm install`);
//   * hook-update.test.mjs mocks ALL tarball download/extract I/O;
//   * npm-tarball-completeness.test.mjs checks file inclusion STATICALLY.
// This script closes that gap end-to-end: it builds the actual publishable
// artifact and proves a clean machine can install it, (re)build the native
// addon, import the package, and open the DB.
//
// Guards in one shot: #8719 (lockfile / native-binding shape drift between the
// developer's npm and the user's npm), a better-sqlite3 ABI break, and tarball
// runtime completeness (a missing root .mjs that static import analysis misses
// surfaces here as an import crash).
//
// Dev-only: NOT listed in package.json "files", so it never ships in the
// tarball. Run locally with `node scripts/smoke-tarball.mjs`; CI runs it in the
// `smoke` job (.github/workflows/ci.yml). Exit 0 = pass, non-zero = the
// published tarball is broken.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const KEEP = process.argv.includes('--keep'); // leave the workdir for debugging
const log = (m) => process.stdout.write(`[smoke] ${m}\n`);
const fail = (m) => { process.stderr.write(`[smoke] FAIL: ${m}\n`); process.exit(1); };

// Run a command; inherit stderr so npm/native build errors stay visible, capture
// stdout for assertions. Throws (non-zero exit) propagate as a failed smoke run.
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

const work = mkdtempSync(join(tmpdir(), 'mem-smoke-'));
const installDir = join(work, 'install');
const dataDir = join(work, 'data'); // sandboxed CLAUDE_MEM_DIR — never touches the real ~/.claude-mem-lite
mkdirSync(installDir, { recursive: true });

try {
  // 1. Build the real publishable tarball (same artifact `npm publish` ships).
  log('npm pack …');
  const packJson = sh('npm', ['pack', '--json', '--pack-destination', work], { cwd: REPO_ROOT });
  const tgz = join(work, JSON.parse(packJson)[0].filename);
  log(`packed ${JSON.parse(packJson)[0].filename}`);

  // 2. Install into a clean throwaway project. This is where better-sqlite3 is
  //    fetched/rebuilt for the target runtime — the step --dev installs skip.
  log('npm install <tarball> (clean dir, rebuilds better-sqlite3) …');
  sh('npm', ['init', '-y'], { cwd: installDir });
  sh('npm', ['install', tgz, '--no-audit', '--no-fund'], { cwd: installDir });

  const cli = join(installDir, 'node_modules', 'claude-mem-lite', 'cli.mjs');

  // 3a. Entry point loads + package wiring is intact.
  const ver = sh('node', [cli, '--version'], { cwd: installDir }).trim();
  if (!/^claude-mem-lite v\d+\.\d+\.\d+/.test(ver)) fail(`unexpected --version output: ${ver}`);
  log(`entry OK — ${ver}`);

  // 3b. Native binding works: resolve better-sqlite3 from the INSTALLED tree
  //     (exactly as the package does) and open :memory:. Isolates a native ABI
  //     failure from a JS/CLI failure.
  const probe = join(work, 'probe.mjs');
  writeFileSync(probe, [
    "import { createRequire } from 'node:module';",
    `const require = createRequire(${JSON.stringify(join(installDir, 'package.json'))});`,
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    "db.exec('CREATE TABLE t(x)'); db.prepare('INSERT INTO t VALUES (1)').run();",
    "const n = db.prepare('SELECT count(*) AS c FROM t').get().c; db.close();",
    "if (n !== 1) { console.error('bad count', n); process.exit(3); }",
    "process.stdout.write('native-ok');",
  ].join('\n'));
  const probeOut = sh('node', [probe], { cwd: installDir });
  if (probeOut !== 'native-ok') fail(`better-sqlite3 probe returned: ${probeOut}`);
  log('native OK — better-sqlite3 opened :memory: and round-tripped a row');

  // 3c. Full runtime path: real import chain → schema init → DB open → query,
  //     against a fresh sandboxed data dir. `stats` reads the DB and exits 0 on
  //     an empty one, creating the schema on first open (the import-+-open-DB
  //     check the audit asked for).
  sh('node', [cli, 'stats'], { cwd: installDir, env: { ...process.env, CLAUDE_MEM_DIR: dataDir } });
  log('runtime OK — cli stats initialised schema and opened DB on a fresh data dir');

  log('PASS — published tarball installs, rebuilds native, imports, and opens a DB');
} finally {
  if (KEEP) process.stderr.write(`[smoke] --keep: left workdir at ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}
