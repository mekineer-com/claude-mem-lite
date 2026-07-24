// Cross-platform basename derivation (audit P2-3).
//
// Hook payloads originate on the CLIENT machine, so `tool_input.file_path` can
// carry a Windows path (`C:\proj\src\file.mjs`) while the code deriving its
// basename may run anywhere. POSIX `path.basename` does NOT treat '\' as a
// separator, so neither `split('/').pop()` nor plain `basename()` is enough for
// data that crosses OS boundaries — see lib/file-edge-match.mjs:10-21, which
// documents observation_files.filename as heterogeneous with EITHER separator.
//
// These tests assert separator-handling logic only; they never branch on
// process.platform, so they are meaningful on the Linux CI host.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { basename, win32, posix } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { recallForFile } from '../hook-memory.mjs';

// ─── The shared helper ──────────────────────────────────────────────────────

describe('basenameAnySep (utils.mjs)', () => {
  // Namespace-style dynamic import: a missing export reads as `undefined`
  // instead of throwing a link-time error that would mask the sibling suites.
  let basenameAnySep;
  beforeEach(async () => {
    ({ basenameAnySep } = await import('../utils.mjs'));
  });

  it('is exported', () => {
    expect(typeof basenameAnySep).toBe('function');
  });

  it('splits Windows backslash paths regardless of host OS', () => {
    expect(basenameAnySep('C:\\proj\\src\\hook-memory.mjs')).toBe('hook-memory.mjs');
    expect(basenameAnySep('\\\\server\\share\\utils.mjs')).toBe('utils.mjs');
  });

  it('splits POSIX forward-slash paths', () => {
    expect(basenameAnySep('/mnt/Sda2/dev/claude-mem-lite/utils.mjs')).toBe('utils.mjs');
  });

  it('splits mixed-separator paths on the last separator of either kind', () => {
    expect(basenameAnySep('C:/proj/src\\hook.mjs')).toBe('hook.mjs');
    expect(basenameAnySep('C:\\proj\\src/hook.mjs')).toBe('hook.mjs');
  });

  it('returns a bare filename unchanged', () => {
    expect(basenameAnySep('hook.mjs')).toBe('hook.mjs');
  });

  it('ignores trailing separators, matching path.basename', () => {
    expect(basenameAnySep('/a/b/')).toBe('b');
    expect(basenameAnySep('C:\\a\\b\\')).toBe('b');
  });

  it('returns empty string for empty / nullish input', () => {
    expect(basenameAnySep('')).toBe('');
    expect(basenameAnySep(undefined)).toBe('');
    expect(basenameAnySep(null)).toBe('');
  });
});

// ─── recallForFile: proactive file-history recall (hook-memory.mjs) ──────────

describe('recallForFile handles Windows-style file paths', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => { db?.close(); });

  it('recalls history stored under a bare basename when given a backslash path', () => {
    insertObs(db, {
      type: 'bugfix', title: 'Fix null deref in hook-memory.mjs',
      text: 'hook-memory.mjs null deref fix',
      importance: 2, filesModified: '["hook-memory.mjs"]',
      epochOffset: -3 * 86400000
    });
    const results = recallForFile(db, 'C:\\proj\\src\\hook-memory.mjs', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/hook-memory\.mjs/);
  });

  it('recalls history stored under a different Windows path with the same basename', () => {
    // observation_files.filename is heterogeneous: an earlier session may have
    // recorded the file under another absolute Windows path.
    insertObs(db, {
      type: 'decision', title: 'Chose FTS5 over LIKE in parser.mjs',
      text: 'parser.mjs FTS5 decision',
      importance: 3, filesModified: '["C:\\\\old\\\\checkout\\\\parser.mjs"]',
      epochOffset: -2 * 86400000
    });
    const results = recallForFile(db, 'C:\\proj\\src\\parser.mjs', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/parser\.mjs/);
  });

  it('still escapes LIKE wildcards when the path is backslash-separated', () => {
    insertObs(db, {
      type: 'bugfix', title: 'Fix in test_100%.mjs',
      text: 'test_100%.mjs fix',
      importance: 2, filesModified: '["test_100%.mjs"]',
      epochOffset: -2 * 86400000
    });
    insertObs(db, {
      type: 'bugfix', title: 'Fix in testX100Y.mjs',
      text: 'testX100Y.mjs fix',
      importance: 2, filesModified: '["testX100Y.mjs"]',
      epochOffset: -2 * 86400000
    });
    const results = recallForFile(db, 'C:\\proj\\test_100%.mjs', 'test');
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('test_100%.mjs');
  });

  it('does not over-match: a backslash path with no history returns empty', () => {
    insertObs(db, {
      type: 'bugfix', title: 'Fix in hook-memory.mjs',
      text: 'hook-memory.mjs fix',
      importance: 2, filesModified: '["hook-memory.mjs"]',
      epochOffset: -2 * 86400000
    });
    expect(recallForFile(db, 'C:\\proj\\src\\brand-new.mjs', 'test')).toEqual([]);
  });

  it('keeps working for POSIX absolute paths (regression)', () => {
    insertObs(db, {
      type: 'bugfix', title: 'Fix race in hook.mjs',
      text: 'hook.mjs race fix',
      importance: 2, filesModified: '["hook.mjs"]',
      epochOffset: -2 * 86400000
    });
    const results = recallForFile(db, '/mnt/data/projects/mem/hook.mjs', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── install.mjs prune log line ─────────────────────────────────────────────

describe('install prune log derives basenames with node:path', () => {
  // pruneStaleInstallFiles returns host-`join`ed absolute paths, so the display
  // mapping at install.mjs:436 only needs the host-native separator — but it
  // must be `basename`, whose Windows implementation accepts BOTH separators,
  // not a hardcoded '/' split. On a POSIX host these two agree, so this suite
  // locks the invariant rather than reproducing a Linux-visible failure.
  it('basename resolves both separator styles per host implementation', () => {
    expect(win32.basename('C:\\Users\\me\\.claude-mem-lite\\dispatch.mjs')).toBe('dispatch.mjs');
    expect(win32.basename('C:/Users/me/.claude-mem-lite/dispatch.mjs')).toBe('dispatch.mjs');
    expect(posix.basename('/home/me/.claude-mem-lite/dispatch.mjs')).toBe('dispatch.mjs');
  });

  it('maps real pruneStaleInstallFiles output to bare filenames', async () => {
    const { pruneStaleInstallFiles } = await import('../install.mjs');
    const { SOURCE_FILES } = await import('../source-files.mjs');
    const tmpDir = mkdtempSync(join(tmpdir(), 'cml-prune-basename-'));
    try {
      writeFileSync(join(tmpDir, 'server.mjs'), 'real');
      writeFileSync(join(tmpDir, 'dispatch.mjs'), 'stale');
      const removed = pruneStaleInstallFiles(tmpDir, SOURCE_FILES);
      expect(removed.map(p => basename(p))).toEqual(['dispatch.mjs']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
