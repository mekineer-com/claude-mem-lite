// Phase A (Invited-Memory plan, T3): MEM_QUIET_HOOKS env switch.
// Covers:
//   1. isQuietHooks() reads env freshly, only '1' is truthy.
//   2. buildServerInstructions(quiet) drops WHEN-TO-USE + Decision rules when quiet.
//   3. buildSessionContextLines drops File Lessons / Key Context / Recent Activity
//      fallback sections when quiet=true; Recent (date) table still emitted.
//
// See docs/plans/2026-04-16-invited-memory-pattern.md for rationale.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isQuietHooks } from '../hook-shared.mjs';
import { buildServerInstructions } from '../server-internals.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('isQuietHooks()', () => {
  let original;
  beforeEach(() => { original = process.env.MEM_QUIET_HOOKS; });
  afterEach(() => {
    if (original === undefined) delete process.env.MEM_QUIET_HOOKS;
    else process.env.MEM_QUIET_HOOKS = original;
  });

  it('returns false when MEM_QUIET_HOOKS is unset', () => {
    delete process.env.MEM_QUIET_HOOKS;
    expect(isQuietHooks()).toBe(false);
  });

  it('returns true when MEM_QUIET_HOOKS="1"', () => {
    process.env.MEM_QUIET_HOOKS = '1';
    expect(isQuietHooks()).toBe(true);
  });

  it('returns false for other truthy-ish values', () => {
    // Only exact '1' counts; '0', 'true', 'yes', 'on', '' all keep default verbose
    for (const v of ['0', 'true', 'yes', 'on', '', ' ', 'False', '2']) {
      process.env.MEM_QUIET_HOOKS = v;
      expect(isQuietHooks()).toBe(false);
    }
  });

  it('reflects env changes between calls (not cached)', () => {
    delete process.env.MEM_QUIET_HOOKS;
    expect(isQuietHooks()).toBe(false);
    process.env.MEM_QUIET_HOOKS = '1';
    expect(isQuietHooks()).toBe(true);
    delete process.env.MEM_QUIET_HOOKS;
    expect(isQuietHooks()).toBe(false);
  });
});

describe('buildServerInstructions(quiet)', () => {
  it('verbose mode (default) contains WHEN TO USE + Decision rules', () => {
    const out = buildServerInstructions(false);
    expect(out).toContain('WHEN TO USE');
    expect(out).toContain('Decision rules');
    expect(out).toContain('mem_recall');
    expect(out).toContain('Hook-injected context mentions #ID');
  });

  it('quiet mode drops WHEN TO USE + Decision rules sections', () => {
    const out = buildServerInstructions(true);
    expect(out).not.toContain('WHEN TO USE');
    expect(out).not.toContain('Decision rules');
    expect(out).not.toContain('proactive triggers');
  });

  it('quiet mode still includes base CLI + tool list', () => {
    const out = buildServerInstructions(true);
    expect(out).toContain('cli.mjs search'); // resolvable absolute-path form (v3.1.1)
    expect(out).toContain('MCP tools:');
    expect(out).toContain('Long-term memory across sessions');
  });

  it('quiet output is meaningfully shorter than verbose', () => {
    const verbose = buildServerInstructions(false);
    const quiet = buildServerInstructions(true);
    // Verbose adds ~900 chars of WHEN-TO-USE + Decision rules; expect >= 30% drop.
    expect(quiet.length).toBeLessThan(verbose.length * 0.7);
  });

  it('default arg (no quiet) is verbose', () => {
    expect(buildServerInstructions()).toBe(buildServerInstructions(false));
  });
});

describe('server.mjs instructions-mode stderr trace', () => {
  const serverPath = join(process.cwd(), 'server.mjs');

  async function runServer(env) {
    const { spawnSync } = await import('child_process');
    return spawnSync('node', [serverPath], {
      input: '',
      env,
      timeout: 3000,
      encoding: 'utf8',
    });
  }

  it('emits BASE+VERBOSE reason=none when not adopted and MEM_QUIET_HOOKS unset', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mem-trace-'));
    try {
      // Minimal env — strip MEM_QUIET_HOOKS + point CLAUDE_PROJECT_DIR at a clean dir
      // so effectiveQuiet returns false.
      const env = { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_PROJECT_DIR: fresh, PWD: fresh };
      const r = await runServer(env);
      expect(r.stderr).toContain('[mem] instructions: BASE+VERBOSE reason=none');
    } finally {
      try { rmSync(fresh, { recursive: true, force: true }); } catch {}
    }
  });

  it('emits BASE reason=env when MEM_QUIET_HOOKS=1', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mem-trace-'));
    try {
      const env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        MEM_QUIET_HOOKS: '1',
        CLAUDE_PROJECT_DIR: fresh,
        PWD: fresh,
      };
      const r = await runServer(env);
      expect(r.stderr).toContain('[mem] instructions: BASE reason=env:MEM_QUIET_HOOKS=1');
    } finally {
      try { rmSync(fresh, { recursive: true, force: true }); } catch {}
    }
  });

  it('emits BASE reason=adopted when project has claude-mem-lite sentinel', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mem-trace-'));
    try {
      // Mirror memdirPath encoding: every non-alphanumeric → '-'.
      const encoded = fresh.replace(/[^a-zA-Z0-9]/g, '-');
      const mdir = join(process.env.HOME, '.claude', 'projects', encoded, 'memory');
      mkdirSync(mdir, { recursive: true });
      const fs = await import('fs');
      fs.writeFileSync(
        join(mdir, 'MEMORY.md'),
        '# Index\n<!-- claude-mem-lite:begin v1 -->\n## 插件契约\n- stub\n<!-- claude-mem-lite:end -->\n',
      );
      try {
        const env = { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_PROJECT_DIR: fresh, PWD: fresh };
        const r = await runServer(env);
        expect(r.stderr).toContain('[mem] instructions: BASE reason=adopted:MEMORY.md-sentinel');
      } finally {
        try { rmSync(join(process.env.HOME, '.claude', 'projects', encoded), { recursive: true, force: true }); } catch {}
      }
    } finally {
      try { rmSync(fresh, { recursive: true, force: true }); } catch {}
    }
  });

  it('opts out with CLAUDE_MEM_QUIET_TRACE=0 — no trace on stderr', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mem-trace-'));
    try {
      const env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        CLAUDE_MEM_QUIET_TRACE: '0',
        CLAUDE_PROJECT_DIR: fresh,
        PWD: fresh,
      };
      const r = await runServer(env);
      expect(r.stderr).not.toMatch(/\[mem\] instructions:/);
    } finally {
      try { rmSync(fresh, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('buildSessionContextLines — QUIET_HOOKS gating', () => {
  let db;
  let original, origHome, origCwd, tmpHome;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });

    // Seed a bugfix obs WITH lesson + file → triggers File Lessons branch
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'bugfix',
      title: 'Fix pagination boundary',
      narrative: 'off-by-one on cursor',
      importance: 3,
      lessonLearned: 'always pin cursor to created_at_epoch',
      filesModified: JSON.stringify(['pagination.mjs']),
    });
    // Seed a decision obs WITH lesson, NO file → triggers Key Context branch
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'decision',
      title: 'Adopted invited memory pattern',
      narrative: 'n',
      importance: 3,
      lessonLearned: 'sentinel + hash guards user edits',
      filesModified: '[]',
    });

    // buildSessionContextLines routes through effectiveQuiet() which also
    // returns true when isAdoptedHere(cwd) detects the sentinel in the current
    // project's memdir. The dogfood repo IS adopted, so without a sandbox the
    // "unset" branch below sees quiet=true and drops File Lessons / Key Context.
    // Pin HOME + CLAUDE_PROJECT_DIR to an unadopted tmpdir.
    tmpHome = mkdtempSync(join(tmpdir(), 'quiet-hooks-'));
    const fakeCwd = join(tmpHome, 'proj');
    mkdirSync(fakeCwd, { recursive: true });
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;

    original = process.env.MEM_QUIET_HOOKS;
  });

  afterEach(() => {
    db.close();
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = origCwd;
    rmSync(tmpHome, { recursive: true, force: true });
    if (original === undefined) delete process.env.MEM_QUIET_HOOKS;
    else process.env.MEM_QUIET_HOOKS = original;
  });

  it('emits File Lessons + Key Context when MEM_QUIET_HOOKS is unset', () => {
    delete process.env.MEM_QUIET_HOOKS;
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).toContain('### File Lessons');
    expect(out).toContain('### Key Context');
    expect(out).toContain('always pin cursor');
    expect(out).toContain('sentinel + hash guards');
  });

  it('drops File Lessons + Key Context when MEM_QUIET_HOOKS=1', () => {
    process.env.MEM_QUIET_HOOKS = '1';
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).not.toContain('### File Lessons');
    expect(out).not.toContain('### Key Context');
    expect(out).not.toContain('always pin cursor');
    expect(out).not.toContain('sentinel + hash guards');
  });

  it('Recent (date) table still emitted under QUIET — #IDs stay reachable', () => {
    process.env.MEM_QUIET_HOOKS = '1';
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).toContain('### Recent');
    expect(out).toContain('| ID |');
    expect(out).toMatch(/#\d+/); // at least one row ID
  });

  it('Recent Activity fallback is skipped under QUIET when no summary exists', () => {
    // No summary row inserted → with QUIET unset and no keyObs, would emit
    // "### Recent Activity". Here both keyObs exist, but we also verify the
    // else-branch behavior by deleting the keyObs pool above and retrying.
    db.prepare('DELETE FROM observations').run();
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'change',
      title: 'trivial tweak',
      importance: 1,
      filesModified: '[]',
    });
    process.env.MEM_QUIET_HOOKS = '1';
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).not.toContain('### Recent Activity');
  });
});
