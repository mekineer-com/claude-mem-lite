// E2E tests for `claude-mem-lite defer add | list | drop` and the
// `claude-mem-lite save --closes-deferred` round-trip.
//
// Mirrors tests/cli-e2e.test.mjs idioms: subprocess via execFileSync,
// CLAUDE_MEM_DIR isolation, project pinned via CLAUDE_PROJECT_DIR.
//
// Test coverage (5 tests):
//   1. defer add → D#N + ordinal in stdout
//   2. defer list → priority-sorted ordinal/title rendering
//   3. defer drop → status flips, list goes empty, reason echoed
//   4. save --closes-deferred 1 → roundtrip closes the item (folded from Task 4 review)
//   5. duplicate save with --closes-deferred → second call MUST NOT re-close (Task 5 review)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const CLI_PATH = resolve('cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-cli-defer-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initTestDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db;
}

let tmpHome;
let dataDir;
let projectDir;
let db;

function runCli(args, { env = {} } = {}) {
  const mergedEnv = {
    ...process.env,
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_MEM_HOOK_RUNNING: undefined,
    ...env,
  };
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      timeout: 10000,
      encoding: 'utf8',
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

beforeEach(() => {
  tmpHome = makeTmpDir();
  dataDir = join(tmpHome, '.claude-mem-lite');
  // CLAUDE_PROJECT_DIR drives inferProject() → "parent--testproj"
  projectDir = join(tmpHome, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  db = initTestDb(dataDir);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('claude-mem-lite defer CLI', () => {
  it('defer add prints D#N + ordinal', () => {
    const { stdout, exitCode } = runCli(['defer', 'add', 'test item one', '--priority', '3']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/D#\d+/);
    // Ordinal "(item 1)" — first open item in this fresh project.
    expect(stdout).toMatch(/item 1/);
  });

  it('defer list shows ordinal + priority + title', () => {
    runCli(['defer', 'add', 'item A', '--priority', '2']);
    runCli(['defer', 'add', 'item B', '--priority', '3']);
    const { stdout, exitCode } = runCli(['defer', 'list']);
    expect(exitCode).toBe(0);
    // listOpenWithOrdinal sorts (priority DESC, created_at_epoch ASC) →
    // priority-3 "item B" is item 1, priority-2 "item A" is item 2.
    expect(stdout).toMatch(/1\..*item B/);
    expect(stdout).toMatch(/2\..*item A/);
  });

  it('defer drop sets status with reason', () => {
    runCli(['defer', 'add', 'item A', '--priority', '2']);
    const { stdout, exitCode } = runCli(['defer', 'drop', '1', '--reason', 'no longer needed']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Dropped D#\d+/);
    expect(stdout).toMatch(/no longer needed/);
    // After drop, list MUST be empty (only one item existed and we dropped it).
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/No open deferred items/);
  });

  // ── Folded from Task 4 review (M-1): save --closes-deferred roundtrip ──────
  it('save --closes-deferred 1 closes the deferred item', () => {
    runCli(['defer', 'add', 'fix the FTS leak', '--priority', '2']);

    // Save a real bugfix observation that closes the deferred item via ordinal.
    const save = runCli([
      'save', 'Fixed FTS leak by holding a connection-scoped statement cache',
      '--type', 'bugfix',
      '--lesson', 'better-sqlite3 statements are per-connection; cache by session',
      '--importance', '2',
      '--closes-deferred', '1',
    ]);
    expect(save.exitCode).toBe(0);
    expect(save.stdout).toMatch(/Saved #\d+/);
    // Closure annotation must echo the resolved D#N (not the ordinal).
    expect(save.stdout).toMatch(/Closed: D#\d+/);

    // List must now be empty — the only deferred item transitioned to 'done'.
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/No open deferred items/);
  });

  // ── Folded from Task 5 review (M-1): duplicate path skips closure ──────────
  // Dogfood-4 regression: `defer add` with > 200-char titles silently accepted them,
  // wrapping into multi-line garbage in `defer list`. CLI now matches MCP memDeferSchema
  // (z.string().min(1).max(200)).
  it('defer add rejects titles longer than 200 chars (parity with MCP schema)', () => {
    const longTitle = 'Z'.repeat(250);
    // `fail()` writes to stderr — check there, not stdout.
    const { stderr, exitCode } = runCli(['defer', 'add', longTitle]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/title too long/);
    expect(stderr).toMatch(/max 200/);
  });

  // Dogfood-4 regression: `save --closes-deferred` accepted comma-separated batches but
  // `defer drop` only took a single token, forcing N shell invocations for N items.
  // Sibling-command symmetry — drop now mirrors closes-deferred's batch form.
  it('defer drop accepts comma-separated batch ordinals', () => {
    runCli(['defer', 'add', 'batch-A', '--priority', '2']);
    runCli(['defer', 'add', 'batch-B', '--priority', '2']);
    const { stdout, exitCode } = runCli(['defer', 'drop', '1,2', '--reason', 'batch test']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Dropped D#\d+, D#\d+/);
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/No open deferred items/);
  });

  // Atomicity: an unresolvable token in the batch fails the entire call. No partial
  // drops, no orphan rows. Mirrors the resolveDeferredIds throw-on-bad-token contract.
  it('defer drop with one bogus ordinal fails atomically (keeps all rows open)', () => {
    runCli(['defer', 'add', 'still-open', '--priority', '2']);
    const drop = runCli(['defer', 'drop', '1,99', '--reason', 'mixed batch']);
    expect(drop.exitCode).not.toBe(0);
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/still-open/);
  });

  it('duplicate save with --closes-deferred does NOT close the deferred item', () => {
    runCli(['defer', 'add', 'fix dedup leak', '--priority', '2']);

    const content = 'Dedup-path test: this content is sufficiently long to compute a minhash signature for dedup purposes';
    const args = [
      'save', content,
      '--type', 'bugfix',
      '--lesson', 'dedup short-circuit must skip deferred closure',
      '--importance', '2',
      '--closes-deferred', '1',
    ];

    // First save: creates obs + closes the deferred item.
    const first = runCli(args);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/Saved #\d+/);
    expect(first.stdout).toMatch(/Closed: D#\d+/);

    // Second save: dedup short-circuit — the duplicate path MUST NOT mention
    // a "Closed: D#" suffix because closeDeferredItems is gated on
    // result.kind !== 'duplicate' (mirrors server.mjs:934).
    const second = runCli(args);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/Skipped: similar to existing #\d+/);
    expect(second.stdout).not.toMatch(/Closed: D#/);

    // Sanity-check via DB: closed_by_obs_id should still equal the FIRST obs id,
    // proving the duplicate path didn't touch the deferred row.
    const firstObsId = parseInt(/Saved #(\d+)/.exec(first.stdout)[1], 10);
    const row = db.prepare(
      `SELECT status, closed_by_obs_id FROM deferred_work WHERE project = ? ORDER BY id DESC LIMIT 1`
    ).get('parent--testproj');
    expect(row.status).toBe('done');
    expect(row.closed_by_obs_id).toBe(firstObsId);
  });
});
