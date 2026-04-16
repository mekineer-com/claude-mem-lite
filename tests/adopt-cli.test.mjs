// Phase C (Invited-Memory plan, T12): E2E for adopt-cli.mjs.
// Routes through cmdAdopt/cmdUnadopt with a sandboxed HOME and
// CLAUDE_PROJECT_DIR so we never touch the user's real memdir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cmdAdopt, cmdUnadopt } from '../adopt-cli.mjs';
import { encodeProjectPath } from '../memdir.mjs';
import { PLUGIN_SLUG } from '../adopt-content.mjs';

function expectedMemdir(home, cwd) {
  return join(home, '.claude', 'projects', encodeProjectPath(cwd), 'memory');
}

function memoryPath(home, cwd) {
  return join(expectedMemdir(home, cwd), 'MEMORY.md');
}

function docPath(home, cwd) {
  return join(expectedMemdir(home, cwd), 'plugin_claude_mem_lite.md');
}

describe('cmdAdopt / cmdUnadopt (current project)', () => {
  let tmpHome, fakeCwd;
  let origHome, origCwd;
  let logs;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'adopt-cli-'));
    fakeCwd = join(tmpHome, 'work', 'myproj');
    mkdirSync(fakeCwd, { recursive: true });

    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;

    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => { logs.push(String(msg)); });

    // Reset exit code from prior tests
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    rmSync(tmpHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('writes sentinel + doc into the encoded memdir', () => {
    cmdAdopt([]);
    const mem = memoryPath(tmpHome, fakeCwd);
    const doc = docPath(tmpHome, fakeCwd);
    expect(existsSync(mem)).toBe(true);
    expect(existsSync(doc)).toBe(true);
    const body = readFileSync(mem, 'utf8');
    expect(body).toContain(`<!-- ${PLUGIN_SLUG}:begin v1 -->`);
    expect(body).toContain('mem_recall(file=');
    expect(readFileSync(doc, 'utf8')).toContain('插件契约');
    expect(process.exitCode).toBe(0);
  });

  it('re-adopt is idempotent (unchanged)', () => {
    cmdAdopt([]);
    const mem = memoryPath(tmpHome, fakeCwd);
    const first = readFileSync(mem, 'utf8');
    cmdAdopt([]);
    expect(readFileSync(mem, 'utf8')).toBe(first);
    expect(logs.some((l) => l.includes('unchanged'))).toBe(true);
  });

  it('refuses to overwrite a hand-edited sentinel without --force', () => {
    cmdAdopt([]);
    const mem = memoryPath(tmpHome, fakeCwd);
    writeFileSync(mem, readFileSync(mem, 'utf8').replace('mem_recall', 'MY_HACK'));
    cmdAdopt([]);
    const body = readFileSync(mem, 'utf8');
    expect(body).toContain('MY_HACK');
    expect(process.exitCode).toBe(1);
    expect(logs.some((l) => l.includes('refused'))).toBe(true);
  });

  it('--force overwrites user edits', () => {
    cmdAdopt([]);
    const mem = memoryPath(tmpHome, fakeCwd);
    writeFileSync(mem, readFileSync(mem, 'utf8').replace('mem_recall', 'MY_HACK'));
    process.exitCode = 0;
    cmdAdopt(['--force']);
    const body = readFileSync(mem, 'utf8');
    expect(body).not.toContain('MY_HACK');
    expect(body).toContain('mem_recall(file=');
    expect(process.exitCode).toBe(0);
  });

  it('--dry-run prints intent without writing', () => {
    cmdAdopt(['--dry-run']);
    expect(existsSync(memoryPath(tmpHome, fakeCwd))).toBe(false);
    expect(existsSync(docPath(tmpHome, fakeCwd))).toBe(false);
    expect(logs.some((l) => l.includes('--dry-run'))).toBe(true);
  });

  it('unadopt removes sentinel + doc precisely', () => {
    cmdAdopt([]);
    // Pre-seed user content around the sentinel
    const mem = memoryPath(tmpHome, fakeCwd);
    writeFileSync(mem, '# My memory\n\n' + readFileSync(mem, 'utf8') + '\n## user tail\n');
    cmdUnadopt([]);
    const body = readFileSync(mem, 'utf8');
    expect(body).not.toContain(PLUGIN_SLUG);
    expect(body).toContain('# My memory');
    expect(body).toContain('## user tail');
    expect(existsSync(docPath(tmpHome, fakeCwd))).toBe(false);
  });

  it('unadopt on a never-adopted memdir is a benign no-op', () => {
    cmdUnadopt([]);
    expect(process.exitCode).toBe(0);
    expect(logs.some((l) => l.includes('absent'))).toBe(true);
  });
});

describe('cmdAdopt / cmdUnadopt (--all)', () => {
  let tmpHome;
  let origHome, origCwd;
  let logs;

  function makeProject(name) {
    const projectsBase = join(tmpHome, '.claude', 'projects');
    const dir = join(projectsBase, name, 'memory');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'adopt-cli-all-'));
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    delete process.env.CLAUDE_PROJECT_DIR;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => { logs.push(String(msg)); });
    process.exitCode = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    rmSync(tmpHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('adopts every memdir with --all', () => {
    const a = makeProject('-proj-a');
    const b = makeProject('-proj-b');
    const c = makeProject('-proj-c');
    cmdAdopt(['--all']);
    for (const d of [a, b, c]) {
      expect(readFileSync(join(d, 'MEMORY.md'), 'utf8')).toContain(`${PLUGIN_SLUG}:begin v1`);
      expect(existsSync(join(d, 'plugin_claude_mem_lite.md'))).toBe(true);
    }
    expect(process.exitCode).toBe(0);
  });

  it('--all skips user-edited sentinels (not batch-abort)', () => {
    const a = makeProject('-proj-a');
    const b = makeProject('-proj-b');
    cmdAdopt(['--all']);
    // Hand-edit a only
    const memA = join(a, 'MEMORY.md');
    writeFileSync(memA, readFileSync(memA, 'utf8').replace('mem_recall', 'HACK'));
    // Second --all run: a is skipped, b still idempotent
    cmdAdopt(['--all']);
    expect(readFileSync(memA, 'utf8')).toContain('HACK'); // still user-edited
    expect(readFileSync(join(b, 'MEMORY.md'), 'utf8')).toContain('mem_recall');
    expect(logs.some((l) => l.includes('skipped'))).toBe(true);
    // Batch didn't fail exit code
    expect(process.exitCode).toBe(0);
  });

  it('--status reports adopted count', () => {
    makeProject('-proj-a');
    const b = makeProject('-proj-b');
    // Adopt only b via per-project call
    process.env.CLAUDE_PROJECT_DIR = join(tmpHome, 'fake-for-b');
    // Override: instead of per-project, force a write into b manually via --all after staging
    // Simpler: just adopt --all then check status counts 2/2
    cmdAdopt(['--all']);
    logs.length = 0;
    cmdAdopt(['--status']);
    const summary = logs.find((l) => /\d+\/\d+ adopted/.test(l));
    expect(summary).toMatch(/2\/2 adopted/);
    expect(logs.some((l) => l.includes('-proj-a'))).toBe(true);
    expect(logs.some((l) => l.includes('-proj-b'))).toBe(true);
    expect(b).toBeDefined(); // silence unused-var lint; b's existence is what makes --all find it
  });

  it('--status on empty ~/.claude/projects reports no memdirs', () => {
    cmdAdopt(['--status']);
    expect(logs.some((l) => l.includes('no memdirs'))).toBe(true);
  });

  it('unadopt --all removes from every memdir', () => {
    const a = makeProject('-proj-a');
    const b = makeProject('-proj-b');
    cmdAdopt(['--all']);
    cmdUnadopt(['--all']);
    expect(readFileSync(join(a, 'MEMORY.md'), 'utf8')).not.toContain(PLUGIN_SLUG);
    expect(readFileSync(join(b, 'MEMORY.md'), 'utf8')).not.toContain(PLUGIN_SLUG);
    expect(existsSync(join(a, 'plugin_claude_mem_lite.md'))).toBe(false);
    expect(existsSync(join(b, 'plugin_claude_mem_lite.md'))).toBe(false);
  });
});
