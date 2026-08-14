// Regression pins for the "silent loss" half of the 2026-08-14 audit batch — the
// defects whose whole signature is that NOTHING reports them: exit 0, empty stdout,
// a green doctor, and the data gone or the wrong data served.
//
// One describe per finding, named B1..B6 after the audit report:
//   B1  a DB that will not open destroys the session's episode buffer, silently (HIGH)
//   B2  recall served superseded lessons AND re-promoted them (HIGH)
//   B3  npm/settings.json installs never registered PreCompact (MED)
//   B6  scripts/post-tool-recall.js was shipped + signed but wired into no registry (MED)
//
// Every case states, in a comment, the input that makes it fail — an assertion whose
// failing input nobody can name is not a test.
//
// ISOLATION: every spawned process gets CLAUDE_MEM_DIR + HOME pointed at a mkdtemp
// sandbox, and a cwd inside it, so nothing can reach the live ~/.claude-mem-lite DB or
// write into this repo. The sandbox is removed in an afterAll `finally`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { recallByFile } from '../lib/recall-core.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');

// ─── Sandbox shared by the subprocess-driven cases ─────────────────────────────────

let ROOT, HOME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-silent0814-'));
  HOME_DIR = join(ROOT, 'home');
  mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });

  BASE_ENV = { ...process.env };
  // The developer's own plugin flags would otherwise flip default-OFF surfaces on in the
  // child (the #8608 leak class). Everything needed is set explicitly below.
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    HOME: HOME_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),   // no LLM spend, no network
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
  });
  delete BASE_ENV.CLAUDE_PROJECT_DIR;   // cwd is the only project source
  delete BASE_ENV.PWD;
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));   // let any detached worker settle
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** A sandbox dir under ROOT (cwd / data dir), created on demand. */
function sandboxDir(...parts) {
  const d = join(ROOT, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function fire(cmd, args, { cwd, stdin = '', env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...BASE_ENV, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} did not exit within ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});   // a hook that returns before reading stdin: EPIPE is fine
    child.stdin.end(stdin);
  });
}

// ─── B2 — recall served retracted lessons and pushed them back up the decay system ──
// lib/recall-core.mjs filtered `compressed_into` but not `superseded_at`, so a lesson a
// later save explicitly overturned (`--supersedes N`) was still returned by `recall
// <file>` / `mem_recall` — one of the tools the project CLAUDE.md points agents at
// before an Edit — AND the same rows then took an access_count bump, re-promoting the
// retracted row in the tier/decay system. Every sibling read path (search-engine,
// recent-core, search-core, timeline-core, hook-memory, pre-tool-recall) already
// filtered it; recall was the sole outlier.

describe('B2 — recall does not serve, or re-promote, a superseded observation', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-b2', project: 'test' });
  });
  afterEach(() => db.close());

  /** A retracted row and its replacement, both linked to the same file. */
  function seedSupersededPair() {
    const stale = insertObs(db, {
      sessionId: 'sess-b2', type: 'bugfix', importance: 3, epochOffset: -60000,
      title: 'retry backoff must reset per hop',
      lessonLearned: 'Reset the backoff on every redirect hop',
      filesModified: '["/repo/src/transport.mjs"]',
      supersededAt: Date.now(), supersededBy: 999,
    });
    const live = insertObs(db, {
      sessionId: 'sess-b2', type: 'bugfix', importance: 3,
      title: 'retry backoff must persist across hops',
      lessonLearned: 'Carry the backoff across redirect hops, never reset it',
      filesModified: '["/repo/src/transport.mjs"]',
    });
    return { staleId: Number(stale.lastInsertRowid), liveId: Number(live.lastInsertRowid) };
  }

  // FAILS IF: the `superseded_at IS NULL` clause is dropped from recall-core's WHERE —
  // both rows come back and the retracted lesson leads the list (it is the same file, and
  // only the ORDER BY separates them).
  it('returns the replacement only, never the retracted row', () => {
    const { staleId, liveId } = seedSupersededPair();
    const { rows } = recallByFile(db, '/repo/src/transport.mjs');
    expect(rows.map((r) => r.id)).toEqual([liveId]);
    expect(rows.map((r) => r.lesson_learned).join('\n'))
      .not.toContain('Reset the backoff on every redirect hop');
    expect(staleId).not.toBe(liveId);   // the pair really is two rows, not one
  });

  // The second half of the defect: lines 37-38 bump access_count over exactly the rows the
  // SELECT returned, so an unfiltered SELECT also re-promoted the tombstone in the decay /
  // tier system. The live row's bump is asserted alongside, so "nothing was bumped" cannot
  // satisfy this case.
  // FAILS IF: the filter is dropped (stale.access_count becomes 1), or the bump is moved
  // ahead of the filter / applied to a wider id set.
  it('leaves the retracted row cold while the replacement is warmed', () => {
    const { staleId, liveId } = seedSupersededPair();
    recallByFile(db, 'transport.mjs');
    const read = (id) => db.prepare('SELECT access_count, last_accessed_at FROM observations WHERE id = ?').get(id);
    expect(read(staleId).access_count || 0).toBe(0);
    expect(read(staleId).last_accessed_at).toBeNull();
    expect(read(liveId).access_count).toBe(1);
    expect(read(liveId).last_accessed_at).toBeGreaterThan(0);
  });

  // includeNoise is the only documented escape hatch on this query and it is about
  // LOW_SIGNAL titles, not about retraction — a caller asking for noise must still not get
  // tombstones.
  // FAILS IF: the filter is applied only on the default (noiseClause) branch.
  it('includeNoise still excludes the retracted row', () => {
    const { liveId } = seedSupersededPair();
    const { rows } = recallByFile(db, 'transport.mjs', { includeNoise: true });
    expect(rows.map((r) => r.id)).toEqual([liveId]);
  });

  // Surface proof, end to end through the real CLI (`recall` renders recall-core's rows):
  // save a lesson, retract it with a second save, and read the file back.
  // FAILS IF: recall-core stops filtering — the retracted lesson text reappears in the
  // rendered output that an agent would read before editing that file.
  it('CLI recall prints the replacement lesson and not the retracted one', async () => {
    const dataDir = sandboxDir('data-b2');
    const cwd = sandboxDir('work', 'b2');
    const target = join(cwd, 'transport.mjs');
    writeFileSync(target, 'export const transport = 1;\n');
    const run = (args) => fire(process.execPath, [CLI_PATH, ...args], { cwd, env: { CLAUDE_MEM_DIR: dataDir } });

    const first = await run(['save', 'Traced the redirect backoff reset to every hop of the chain',
      '--type', 'bugfix', '--importance', '3', '--files', target,
      '--lesson', 'RETRACTED reset the backoff on every redirect hop']);
    expect(first.code, first.stderr).toBe(0);
    const staleId = Number(first.stdout.match(/#(\d+)/)[1]);

    const second = await run(['save', 'Corrected the redirect backoff rule after re-reading the RFC',
      '--type', 'bugfix', '--importance', '3', '--files', target,
      '--lesson', 'CURRENT carry the backoff across redirect hops',
      '--supersedes', String(staleId)]);
    expect(second.code, second.stderr).toBe(0);

    // The retraction really landed — otherwise this case would pass on a store where the
    // stale row was simply never marked.
    const raw = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    try {
      expect(raw.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(staleId).superseded_at)
        .toBeTruthy();
    } finally { raw.close(); }

    const recalled = await run(['recall', target]);
    expect(recalled.code, recalled.stderr).toBe(0);
    expect(recalled.stdout).toContain('CURRENT carry the backoff across redirect hops');
    expect(recalled.stdout, 'a retracted lesson must not be served as current')
      .not.toContain('RETRACTED reset the backoff on every redirect hop');
  }, 60000);
});
