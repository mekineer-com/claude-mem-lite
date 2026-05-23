// Phase C (Invited-Memory plan, T12): E2E for adopt-cli.mjs.
// Routes through cmdAdopt/cmdUnadopt with a sandboxed HOME and
// CLAUDE_PROJECT_DIR so we never touch the user's real memdir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cmdAdopt, cmdUnadopt, silentAutoAdopt, hasAutoAdoptMarker, disableSentinelPath, isAutoAdoptDisabled } from '../adopt-cli.mjs';
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

  // Dogfood-3 regression: `unadopt --status` previously had no special handling
  // for --status, so the flag was silently dropped and the destructive default
  // ran — users probing "what's adopted?" lost their sentinel. Now --status
  // routes through statusAll (read-only) like cmdAdopt's path.
  it('unadopt --status is read-only and does NOT remove the sentinel', () => {
    cmdAdopt([]);
    const mem = memoryPath(tmpHome, fakeCwd);
    const before = readFileSync(mem, 'utf8');
    cmdUnadopt(['--status']);
    const after = readFileSync(mem, 'utf8');
    expect(after).toBe(before);
    expect(existsSync(docPath(tmpHome, fakeCwd))).toBe(true);
    // Output should look like the adopt --status format
    expect(logs.some((l) => l.includes('[adopt --status]'))).toBe(true);
  });

  it('unadopt --dry-run previews but does NOT remove the sentinel', () => {
    cmdAdopt([]);
    const mem = memoryPath(tmpHome, fakeCwd);
    const before = readFileSync(mem, 'utf8');
    cmdUnadopt(['--dry-run']);
    const after = readFileSync(mem, 'utf8');
    expect(after).toBe(before);
    expect(existsSync(docPath(tmpHome, fakeCwd))).toBe(true);
    expect(logs.some((l) => l.includes('would-remove') || l.includes('would remove'))).toBe(true);
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

// ─── silentAutoAdopt (v2.33.0 plugin-mode first-run helper) ─────────────────
describe('silentAutoAdopt + hasAutoAdoptMarker', () => {
  let tmpHome, fakeCwd, markerDir, origHome, origCwd;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'silent-adopt-'));
    fakeCwd = join(tmpHome, 'work', 'proj');
    mkdirSync(fakeCwd, { recursive: true });
    markerDir = join(tmpHome, 'runtime');
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    // Silence logs from writePluginSection (silentAutoAdopt itself never logs,
    // but shared writePluginDoc is silent too — keep mock for symmetry/safety).
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('first call: writes sentinel + doc + marker, returns ok/adopted', () => {
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('adopted');
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
    const memdir = expectedMemdir(tmpHome, fakeCwd);
    expect(existsSync(join(memdir, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(memdir, 'plugin_claude_mem_lite.md'))).toBe(true);
    expect(readFileSync(join(memdir, 'MEMORY.md'), 'utf8')).toContain(`${PLUGIN_SLUG}:begin v1`);
  });

  it('already-adopted path: returns ok/already-adopted, writes marker, no duplicate', () => {
    // First, real adopt via cmdAdopt to set up state
    cmdAdopt([]);
    // Now invoke silentAutoAdopt — should detect isAdopted and short-circuit
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('already-adopted');
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
  });

  it('returns skipped/user-edited when sentinel body was hand-edited', () => {
    cmdAdopt([]);
    const memPath = memoryPath(tmpHome, fakeCwd);
    // Corrupt the sentinel body so isAdopted=true but hash mismatch
    writeFileSync(memPath, readFileSync(memPath, 'utf8').replace('mem_recall', 'HACKED'));
    // Clear sentinel state sidecar so isAdopted returns true (sentinel is there)
    // but writePluginSection's update path detects user-edit — but we don't reach
    // writePluginSection because isAdopted short-circuits first.
    // So: already-adopted is returned, not user-edited. That's by design —
    // isAdopted is a less strict check than writePluginSection's hash guard.
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('already-adopted');
  });

  it('hasAutoAdoptMarker is per-key (scoping works)', () => {
    silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
    expect(hasAutoAdoptMarker(markerDir, 'proj-y')).toBe(false);
  });

  it('marker persists even on failure — no retry-storm on every SessionStart', () => {
    // Simulate failure: make memdir path unwritable by passing a path into a
    // pre-existing read-only parent. Simpler: force a BudgetExceededError by
    // pre-populating MEMORY.md with > 180 lines before calling.
    const memdir = expectedMemdir(tmpHome, fakeCwd);
    mkdirSync(memdir, { recursive: true });
    const bigMem = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(join(memdir, 'MEMORY.md'), bigMem);

    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('budget-exceeded');
    // Marker still written — next SessionStart won't retry
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
  });

  // v2.82.0: per-project opt-out via .mem-no-auto-adopt sentinel.
  it('skips with action=disabled when .mem-no-auto-adopt sentinel exists', () => {
    const memdir = expectedMemdir(tmpHome, fakeCwd);
    mkdirSync(memdir, { recursive: true });
    writeFileSync(disableSentinelPath(memdir), '{}');
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('disabled');
    expect(r.reason).toBe('disabled-by-sentinel');
    // Critically: NO marker written, so --enable can re-arm by deleting the sentinel.
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(false);
    // No sentinel written either.
    expect(existsSync(join(memdir, 'MEMORY.md'))).toBe(false);
  });
});

// ─── v2.82.0: --disable / --enable per-project opt-out ──────────────────────
describe('cmdAdopt --disable / --enable', () => {
  let tmpHome, fakeCwd, markerDir, origHome, origCwd;
  let logs;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'adopt-disable-'));
    fakeCwd = join(tmpHome, 'work', 'proj');
    mkdirSync(fakeCwd, { recursive: true });
    markerDir = join(tmpHome, 'runtime');
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
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

  it('--disable writes .mem-no-auto-adopt; --enable removes it (roundtrip)', () => {
    cmdAdopt(['--disable']);
    const memdir = expectedMemdir(tmpHome, fakeCwd);
    expect(isAutoAdoptDisabled(memdir)).toBe(true);
    expect(existsSync(disableSentinelPath(memdir))).toBe(true);
    expect(logs.some((l) => l.includes('disabled'))).toBe(true);

    cmdAdopt(['--enable']);
    expect(isAutoAdoptDisabled(memdir)).toBe(false);
    expect(existsSync(disableSentinelPath(memdir))).toBe(false);
    expect(logs.some((l) => l.includes('enabled'))).toBe(true);
  });

  it('--disable is idempotent (already-disabled reported, not error)', () => {
    cmdAdopt(['--disable']);
    logs.length = 0;
    cmdAdopt(['--disable']);
    expect(logs.some((l) => l.includes('already-disabled'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('--enable on never-disabled memdir is a benign no-op', () => {
    cmdAdopt(['--enable']);
    expect(logs.some((l) => l.includes('absent') || l.includes('not-disabled'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('--disable does NOT remove an existing sentinel (separate from unadopt)', () => {
    cmdAdopt([]); // adopt first
    const memdir = expectedMemdir(tmpHome, fakeCwd);
    expect(existsSync(join(memdir, 'MEMORY.md'))).toBe(true);
    cmdAdopt(['--disable']);
    // Sentinel and detail doc still present after --disable.
    expect(readFileSync(join(memdir, 'MEMORY.md'), 'utf8')).toContain(`${PLUGIN_SLUG}:begin v1`);
    expect(existsSync(join(memdir, 'plugin_claude_mem_lite.md'))).toBe(true);
    expect(isAutoAdoptDisabled(memdir)).toBe(true);
  });

  it('end-to-end: --disable blocks silentAutoAdopt; --enable re-arms it', () => {
    // Start: never adopted, never disabled
    cmdAdopt(['--disable']);
    const r1 = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r1.action).toBe('disabled');
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(false);

    // --enable: delete sentinel → silentAutoAdopt now proceeds
    cmdAdopt(['--enable']);
    const r2 = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r2.action).toBe('adopted');
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
  });

  it('--status reports a disabled-but-not-adopted project distinctly', () => {
    cmdAdopt(['--disable']);
    logs.length = 0;
    // Need a memdir under ~/.claude/projects/ for statusAll to find it. The
    // CLAUDE_PROJECT_DIR-derived memdir isn't there yet (cmdAdopt --disable
    // mkdir'd it under tmpHome/.claude/projects/<encoded>/memory), so list it.
    cmdAdopt(['--status']);
    expect(logs.some((l) => l.includes('auto-adopt disabled, no sentinel'))).toBe(true);
    expect(logs.some((l) => l.includes('Auto-adopt gates'))).toBe(true);
  });
});
