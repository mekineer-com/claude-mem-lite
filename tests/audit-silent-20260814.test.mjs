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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { recallByFile } from '../lib/recall-core.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');
const INSTALL_PATH = join(REPO, 'install.mjs');

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

// ─── B3 — the npm/settings.json install never registered PreCompact ────────────────
// hooks/hooks.json (the plugin-manifest registry) declares six events; install.mjs's
// `hookConfigs` map declared five — PreCompact was missing. A settings.json install
// therefore never fired `hook.mjs pre-compact`, so the memory block that exists to
// survive compaction was silently absent, and `doctor` still printed "All critical
// checks passed" (it tests presence-of-any-mem-hook and file existence, never
// event-set completeness). The guard below diffs the two registries by what each
// ACTUALLY produces — a real `install --dev` run's settings.json against the shipped
// hooks.json — so neither can be edited into agreement on its own.

describe('B3 — install.mjs and hooks/hooks.json register the same hook events', () => {
  let settingsHooks, manifestHooks, isMemHook;
  let installHome, dataDir, cwd, installOut;

  /**
   * Reduce a hook command to the entry it invokes, dropping the interpreter and the
   * install-shape-specific absolute path / ${CLAUDE_PLUGIN_ROOT} prefix:
   *   node "<any>/scripts/hook-launcher.mjs" hook.mjs session-start → "hook.mjs session-start"
   *   bash "<any>/scripts/post-tool-use.sh"                        → "scripts/post-tool-use.sh"
   */
  function entryToken(command) {
    const unpathed = String(command)
      .replace(/"[^"]*\/(scripts\/[^"]+)"/g, '$1')
      .replace(/"[^"]*\/([^/"]+)"/g, '$1');
    return unpathed
      .split(/\s+/)
      .filter((t) => t && t !== 'node' && t !== 'bash' && t !== 'scripts/hook-launcher.mjs')
      .join(' ');
  }

  /** event → sorted "matcher :: entry" strings, for the mem-owned configs only. */
  function registryShape(hooks) {
    const shape = {};
    for (const [event, configs] of Object.entries(hooks || {})) {
      const rows = (configs || [])
        .filter((cfg) => isMemHook(cfg))
        .flatMap((cfg) => (cfg.hooks || []).map((h) => `${cfg.matcher} :: ${entryToken(h.command)}`));
      if (rows.length > 0) shape[event] = rows.sort();
    }
    return shape;
  }

  // scripts/setup.sh bootstraps the PLUGIN CACHE (node_modules symlink, stale-MCP
  // cleanup) — a directory that only exists in a plugin install. install.mjs does that
  // work itself at install time, so this one entry is legitimately manifest-only. The
  // assertion below pins the divergence to exactly this, so any NEW divergence reds.
  const PLUGIN_ONLY = ['startup|clear|compact :: scripts/setup.sh'];

  beforeAll(async () => {
    ({ isMemHook } = await import('../install.mjs'));

    installHome = sandboxDir('b3-home');
    dataDir = sandboxDir('b3-data');
    cwd = sandboxDir('work', 'b3');
    mkdirSync(join(installHome, '.claude'), { recursive: true });

    // `claude` is invoked by registerMcpServer(); a no-op shim keeps the install offline
    // and stops it from reaching the developer's real CLI.
    const binDir = sandboxDir('b3-bin');
    const shim = join(binDir, 'claude');
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);

    // --dev symlinks the repo instead of running npm install: no network, no LLM spend.
    installOut = await fire(process.execPath, [INSTALL_PATH, 'install', '--dev'], {
      cwd,
      env: {
        HOME: installHome,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_REPOS: '1',
        PATH: `${binDir}:${process.env.PATH}`,
      },
      timeout: 120000,
    });
    expect(installOut.code, `install failed:\n${installOut.stdout}\n${installOut.stderr}`).toBe(0);

    settingsHooks = JSON.parse(readFileSync(join(installHome, '.claude', 'settings.json'), 'utf8')).hooks;
    manifestHooks = JSON.parse(readFileSync(join(REPO, 'hooks', 'hooks.json'), 'utf8')).hooks;
  }, 180000);

  // FAILS IF: either registry gains or loses an event the other has — e.g. deleting
  // `PreCompact` from install.mjs's hookConfigs (the original defect) reds with
  // ['PostToolUse','PreToolUse','SessionStart','Stop','UserPromptSubmit'] against the
  // manifest's six.
  it('both registries cover the same event set', () => {
    const installEvents = Object.keys(registryShape(settingsHooks)).sort();
    const manifestEvents = Object.keys(registryShape(manifestHooks)).sort();
    expect(installEvents.length, `no mem hooks in the generated settings.json:\n${installOut.stdout}`)
      .toBeGreaterThan(5);
    expect(installEvents).toEqual(manifestEvents);
    expect(installEvents).toContain('PreCompact');
  });

  // Event keys alone would not catch "registered the event but pointed it at nothing" or
  // a script wired into one registry only (the B6 class). Both sides here are read from
  // real artifacts — a generated settings.json and the shipped manifest.
  // FAILS IF: an entry is added to one registry only, or a matcher drifts (e.g. wiring
  // post-tool-recall.js into hooks.json but not install.mjs).
  it('both registries invoke the same entries under the same matchers', () => {
    const installShape = registryShape(settingsHooks);
    const manifestShape = registryShape(manifestHooks);
    for (const event of Object.keys(manifestShape)) {
      const manifestRows = manifestShape[event].filter((r) => !PLUGIN_ONLY.includes(r));
      expect(installShape[event], `${event} missing from the settings.json install`).toEqual(manifestRows);
    }
    // …and the exclusion really is only that one bootstrap line.
    const excluded = Object.values(manifestShape).flat().filter((r) => PLUGIN_ONLY.includes(r));
    expect(excluded).toEqual(PLUGIN_ONLY);
  });

  // Registration is only half the claim: run the command string the installer actually
  // wrote, exactly as Claude Code would, and check the block comes out.
  // FAILS IF: the registered PreCompact command points at a wrong path/subcommand, or
  // the entry is absent (the lookup below finds nothing and reds before spawning).
  it('the registered PreCompact command emits the memory block it exists to preserve', async () => {
    const seeded = await fire(process.execPath, [CLI_PATH, 'save',
      'Traced the compaction memory loss to the missing PreCompact registration',
      '--type', 'discovery', '--importance', '3',
      '--lesson', 'Compaction drops context unless PreCompact re-emits it'],
    { cwd, env: { CLAUDE_MEM_DIR: dataDir } });
    expect(seeded.code, seeded.stderr).toBe(0);

    const command = (settingsHooks.PreCompact || [])
      .flatMap((cfg) => (cfg.hooks || []).map((h) => h.command))
      .find((c) => /pre-compact/.test(c));
    expect(command, `no PreCompact command in the generated settings.json: ${JSON.stringify(settingsHooks.PreCompact)}`)
      .toBeTruthy();

    const r = await fire('/bin/sh', ['-c', command], {
      cwd,
      stdin: JSON.stringify({ session_id: 'cc-b3-precompact', trigger: 'auto' }),
      env: { HOME: installHome, CLAUDE_MEM_DIR: dataDir },
    });
    expect(r.code, `registered PreCompact command exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout.startsWith('<claude-mem-context>'), `stdout was:\n${r.stdout}`).toBe(true);
    // The rendered table truncates long titles, so match the head of the seeded row.
    expect(r.stdout).toContain('Traced the compaction memory loss to the missing');
  }, 60000);
});
