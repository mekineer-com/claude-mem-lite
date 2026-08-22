// D#136: the error-recall surface was searching the COMMAND's topic, not the error.
//
// Root cause (diagnosed 2026-08-22 against the live DB, obs #10730): the surface fires
// on detectBashSignificance's isHardError, but that gate and the error-LINE filter use
// DIFFERENT pattern lists. HARD_ERROR_RE accepts `ERR!`, `enoent`, `traceback`; the
// line filter only matches the whole word `error`. npm's own failure output clears the
// trigger and yields ZERO error lines — `npm ERR! code ENOENT … no such file or
// directory` has no `error`, no `fail`, no `not found`. The keyword set then degraded
// to pure command words (['npm','run','build']) and the FTS query searched the
// COMMAND'S TOPIC rather than the failure. Same shape for a Python traceback's head.
//
// A second mechanism was diagnosed at the same time — command words and error tokens
// share ONE OR-query with equal weight, and `npm`/`run`/`grep` are generic enough to
// dominate BM25 — but demoting them was TRIED AND REJECTED on measurement (see the
// replay evidence on the second describe block below). Command words turned out to
// carry domain anchoring. Only the gate ships.
//
// planErrorRecall() is the decision seam (same discipline as formatErrorRecallHints
// in format-utils.mjs — pure, so the gate is testable without spawning the hook):
//   - no error-signal tokens → null, i.e. DO NOT inject
//   - otherwise → the same merged term list extractErrorKeywords already produced
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { planErrorRecall, extractErrorKeywords, detectBashSignificance } from '../bash-utils.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(REPO, 'cli.mjs');
const HOOK_PATH = join(REPO, 'hook.mjs');

// npm's real ENOENT output — the highest-frequency shape that reaches this surface
// with no error-signal token in it.
const NPM_ENOENT_OUT = [
  'npm ERR! code ENOENT',
  'npm ERR! syscall open',
  'npm ERR! path /x/package.json',
  'npm ERR! errno -2',
  "npm ERR! enoent ENOENT: no such file or directory, open '/x/package.json'",
].join('\n');
const PY_TRACEBACK_HEAD = 'Traceback (most recent call last):\n  File "train.py", line 42, in <module>\n    main()';
const NPM_BUILD_OUT = "Error: Cannot find module './lib/observation-write.mjs'\n    at Module._resolveFilename";

describe('planErrorRecall — gate (no error signal ⇒ no injection)', () => {
  // THE case: isHardError says "recall now", the line filter finds nothing to recall
  // ON. Without the gate this injected a query for ['npm','run','build'].
  it('suppresses npm ENOENT — which DOES trip isHardError, so the gate is load-bearing', () => {
    expect(detectBashSignificance({ command: 'npm run build' }, NPM_ENOENT_OUT).isHardError,
      'npm ENOENT must still reach this surface, else the gate would be dead code').toBe(true);
    expect(extractErrorKeywords('npm run build', NPM_ENOENT_OUT),
      'the old path queried the command topic').toEqual(['npm', 'run', 'build']);
    expect(planErrorRecall('npm run build', NPM_ENOENT_OUT)).toBeNull();
  });

  it('suppresses a Python traceback head for the same reason', () => {
    expect(detectBashSignificance({ command: 'python train.py' }, PY_TRACEBACK_HEAD).isHardError).toBe(true);
    expect(planErrorRecall('python train.py', PY_TRACEBACK_HEAD)).toBeNull();
  });

  it('returns null when the output is empty or whitespace', () => {
    expect(planErrorRecall('npm run build', '')).toBeNull();
    expect(planErrorRecall('npm run build', '   \n  \n')).toBeNull();
  });

  it('does NOT fall back to command words when the error line yields only stop words', () => {
    // 'Error:' / 'failed' / 'cannot' are all in ERROR_STOP_WORDS, and the remaining
    // tokens are <=3 chars — so there is no discriminative error term to search on.
    expect(planErrorRecall('npm run build', 'Error: it failed')).toBeNull();
  });
});

// Dropping command words from the query was tried and REJECTED on measurement —
// replaying five real failures against the live DB, error-terms-only fixed the
// missing-module case but lost #8673 for a failed DB open (dropped `database`) and
// #8725 for a test failure (dropped `vitest`). These lock in that command words stay,
// so a future "obvious cleanup" has to re-measure rather than re-break it.
describe('planErrorRecall — term selection deliberately unchanged', () => {
  it('keeps the discriminative error token in the query', () => {
    const plan = planErrorRecall('npm run build', NPM_BUILD_OUT);
    expect(plan).not.toBeNull();
    expect(plan.terms).toContain('observation-write.mjs');
  });

  it('KEEPS command words — they carry domain anchoring, not just BM25 noise', () => {
    const plan = planErrorRecall('npx vitest run tests/scope-label.test.mjs', 'FAIL tests/scope-label.test.mjs\nError: expected 2 to be 3');
    expect(plan).not.toBeNull();
    // `vitest` is exactly the anchor whose removal cost #8725 in the replay.
    expect(plan.terms).toContain('vitest');
  });

  it('emits the same merged term list as extractErrorKeywords when it fires', () => {
    // The gate changes WHETHER we query, never WITH WHAT — this is the invariant
    // that keeps the fix from silently becoming a retrieval change too.
    const plan = planErrorRecall('npm run build', NPM_BUILD_OUT);
    expect(plan.terms).toEqual(extractErrorKeywords('npm run build', NPM_BUILD_OUT));
  });

  it('caps the query so one noisy stack frame cannot explode the OR-query', () => {
    const noisy = Array.from({ length: 40 }, (_, i) => `Error: distinctToken${i}Failure at frame${i}`).join('\n');
    const plan = planErrorRecall('cmd', noisy);
    expect(plan).not.toBeNull();
    expect(plan.terms.length).toBeLessThanOrEqual(6);
  });
});

describe('extractErrorKeywords — existing contract unchanged (regression)', () => {
  it('still returns command words merged with error tokens', () => {
    const result = extractErrorKeywords('npm install express', 'Error: EACCES permission denied');
    expect(result).toContain('npm');
    expect(result).toContain('install');
    expect(result).toContain('express');
  });

  it('still returns null when nothing survives filtering', () => {
    expect(extractErrorKeywords('', '')).toBeNull();
  });
});

// ─── Wiring (the seam the unit tests above canNOT reach) ────────────────────
//
// planErrorRecall is pure, so nothing above proves hook.mjs actually consults it —
// deleting `if (!plan) return;` leaves every unit test green. That gap is not
// hypothetical: this same change first shipped with hook.mjs importing planErrorRecall
// from utils.mjs, which did not re-export it, and hook.mjs failed to load entirely.
// These two cases drive the real PostToolUse entry point.
describe('error-recall wiring: hook.mjs honours the gate', () => {
  let ROOT, HOME_DIR, BASE_ENV, dataDir, cwd;

  beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'mem-errgate-'));
    HOME_DIR = join(ROOT, 'home');
    mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });
    dataDir = join(ROOT, 'data');
    cwd = join(ROOT, 'proj');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    BASE_ENV = { ...process.env };
    for (const k of Object.keys(BASE_ENV)) {
      if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
    }
    Object.assign(BASE_ENV, {
      HOME: HOME_DIR,
      CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),   // no LLM spend, no network
      ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '',
      CLAUDE_MEM_SKIP_UPDATE: '1', CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1', CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1', CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      CLAUDE_MEM_SKIP_REPOS: '1', CLAUDE_MEM_NO_DELAY: '1',
      CLAUDE_MEM_DIR: dataDir,
    });
    delete BASE_ENV.CLAUDE_PROJECT_DIR;
    delete BASE_ENV.PWD;

    // BAIT. Without a row the command words WOULD have matched, "nothing injected"
    // proves nothing — the suppression case would pass on an empty store.
    const bait = await fire(process.execPath, [CLI_PATH, 'save',
      'Recovering an npm run build that fails during the bundle step',
      '--type', 'bugfix', '--importance', '3',
      '--lesson', 'npm run build recovery: clear the cache before rebuilding'], { cwd });
    expect(bait.code, bait.stderr).toBe(0);
    const vitestRow = await fire(process.execPath, [CLI_PATH, 'save',
      'A vitest suite that fails only on the shared sqlite temp file',
      '--type', 'bugfix', '--importance', '3',
      '--lesson', 'vitest fail: run the suite alone, the shared temp file races'], { cwd });
    expect(vitestRow.code, vitestRow.stderr).toBe(0);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function fire(cmd, args, { cwd: dir, stdin = '', timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: dir, env: BASE_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeout);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    });
  }

  async function firePostTool(command, response) {
    const r = await fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-errgate', tool_name: 'Bash',
        tool_input: { command }, tool_response: response,
      }),
    });
    expect(r.code, `post-tool-use exited ${r.code}\n${r.stderr}`).toBe(0);
    const block = r.stdout.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .map((e) => e?.hookSpecificOutput?.additionalContext)
      .find((c) => typeof c === 'string' && c.includes('Related memories found for this error'));
    return { block, stdout: r.stdout };
  }

  it('injects nothing for npm ENOENT even though a command-word match is sitting in the store', async () => {
    const { block, stdout } = await firePostTool('npm run build', NPM_ENOENT_OUT);
    expect(block, `error-recall fired on a command-topic match:\n${stdout}`).toBeUndefined();
  }, 40000);

  it('still injects for a failure that DOES carry error signal (the gate is not a mute button)', async () => {
    const { block, stdout } = await firePostTool(
      'npx vitest run tests/a.test.mjs',
      'FAIL tests/a.test.mjs > shared temp file\nAssertionError: expected 2 to be 3',
    );
    expect(block, `error-recall did not fire on a real error:\n${stdout}`).toBeTruthy();
  }, 40000);
});
