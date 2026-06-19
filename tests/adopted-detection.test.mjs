// Phase D (Invited-Memory plan, T16): conditional trim based on sentinel.
// Verifies effectiveQuiet() flips to true under either env or adoption,
// and that buildSessionContextLines / buildServerInstructions follow suit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { effectiveQuiet, isAdoptedHere, isQuietHooks } from '../hook-shared.mjs';
import { writePluginSection, removePluginSection, memdirPath } from '../memdir.mjs';
import { PLUGIN_SLUG, CURRENT_SENTINEL_VERSION, getIndexLine } from '../adopt-content.mjs';
import { buildServerInstructions } from '../server-internals.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

function setupSandbox() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'adopt-detect-'));
  const fakeCwd = join(tmpHome, 'myproj');
  mkdirSync(fakeCwd, { recursive: true });
  return { tmpHome, fakeCwd };
}

describe('isAdoptedHere / effectiveQuiet', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet;

  beforeEach(() => {
    ({ tmpHome, fakeCwd } = setupSandbox());
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = origCwd;
    if (origQuiet === undefined) delete process.env.MEM_QUIET_HOOKS; else process.env.MEM_QUIET_HOOKS = origQuiet;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('isAdoptedHere reflects sentinel presence in current-project memdir', () => {
    expect(isAdoptedHere()).toBe(false);
    const memdir = memdirPath(fakeCwd);
    writePluginSection(memdir, {
      slug: PLUGIN_SLUG, version: CURRENT_SENTINEL_VERSION, contentLine: getIndexLine(),
    });
    expect(isAdoptedHere()).toBe(true);
    removePluginSection(memdir, PLUGIN_SLUG);
    expect(isAdoptedHere()).toBe(false);
  });

  it('effectiveQuiet = false when neither env nor adoption', () => {
    expect(isQuietHooks()).toBe(false);
    expect(isAdoptedHere()).toBe(false);
    expect(effectiveQuiet()).toBe(false);
  });

  it('effectiveQuiet = true when adopted (no env)', () => {
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG, version: CURRENT_SENTINEL_VERSION, contentLine: 'x',
    });
    expect(effectiveQuiet()).toBe(true);
  });

  it('effectiveQuiet = true when env set (no adoption)', () => {
    process.env.MEM_QUIET_HOOKS = '1';
    expect(effectiveQuiet()).toBe(true);
  });

  it('env and adoption combine OR — either path works independently', () => {
    process.env.MEM_QUIET_HOOKS = '1';
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG, version: CURRENT_SENTINEL_VERSION, contentLine: 'x',
    });
    expect(effectiveQuiet()).toBe(true);
  });
});

describe('Phase D conditional trim — buildServerInstructions via effectiveQuiet', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet;

  beforeEach(() => {
    ({ tmpHome, fakeCwd } = setupSandbox());
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = origCwd;
    if (origQuiet === undefined) delete process.env.MEM_QUIET_HOOKS; else process.env.MEM_QUIET_HOOKS = origQuiet;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('produces verbose instructions when NOT adopted and env unset', () => {
    const instr = buildServerInstructions(effectiveQuiet());
    expect(instr).toContain('WHEN TO USE');
  });

  it('produces slim instructions when adopted (no env)', () => {
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG, version: CURRENT_SENTINEL_VERSION, contentLine: 'x',
    });
    const instr = buildServerInstructions(effectiveQuiet());
    expect(instr).not.toContain('WHEN TO USE');
    expect(instr).toContain('cli.mjs search'); // base CLI help still present (resolvable path form)
  });
});

describe('Phase D conditional trim — buildSessionContextLines via effectiveQuiet', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet, db;

  beforeEach(() => {
    ({ tmpHome, fakeCwd } = setupSandbox());
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;

    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'bugfix',
      title: 'Fix pagination boundary', importance: 3,
      lessonLearned: 'always pin cursor', filesModified: JSON.stringify(['pagination.mjs']),
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'decision',
      title: 'Adopt pattern', importance: 3,
      lessonLearned: 'sentinel + hash', filesModified: '[]',
    });
  });
  afterEach(() => {
    try { db.close(); } catch {}
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = origCwd;
    if (origQuiet === undefined) delete process.env.MEM_QUIET_HOOKS; else process.env.MEM_QUIET_HOOKS = origQuiet;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('emits verbose (File Lessons + Key Context) when NOT adopted', () => {
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).toContain('### File Lessons');
    expect(out).toContain('### Key Context');
  });

  it('drops File Lessons + Key Context once adopted (sentinel present)', () => {
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG, version: CURRENT_SENTINEL_VERSION, contentLine: 'x',
    });
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).not.toContain('### File Lessons');
    expect(out).not.toContain('### Key Context');
    expect(out).toContain('### Recent'); // #IDs still reachable
  });

  it('unadopt restores verbose output', () => {
    const memdir = memdirPath(fakeCwd);
    writePluginSection(memdir, { slug: PLUGIN_SLUG, version: 'v1', contentLine: 'x' });
    const quietOut = buildSessionContextLines(db, 'test', new Date());
    expect(quietOut).not.toContain('### File Lessons');

    removePluginSection(memdir, PLUGIN_SLUG);
    const verboseOut = buildSessionContextLines(db, 'test', new Date());
    expect(verboseOut).toContain('### File Lessons');
  });
});
