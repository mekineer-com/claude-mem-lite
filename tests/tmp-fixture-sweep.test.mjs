import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sweepStaleTestFixtures } from '../lib/tmp-fixture-sweep.mjs';

describe('sweepStaleTestFixtures', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sweep-orphan-'));
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  // Backdate a dir's mtime to `ageMs` ago so the age gate treats it as stale.
  function makeDir(name, ageMs) {
    const p = join(root, name);
    mkdirSync(p);
    writeFileSync(join(p, 'test.db'), 'x'); // simulate a leaked sandbox DB
    if (ageMs > 0) {
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(p, t, t);
    }
    return p;
  }

  it('removes stale mem-namespaced fixture dirs older than ageMs', () => {
    const stale = makeDir('mem-e2e-abc123', 2 * 60 * 60 * 1000); // 2h old
    const { removed, names } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000 });
    expect(removed).toBe(1);
    expect(names).toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it('keeps fresh fixture dirs (younger than ageMs) — never disturbs an in-flight run', () => {
    const fresh = makeDir('mem-audit-fresh', 0); // just created
    const { removed } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000 });
    expect(removed).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never touches non-mem dirs (other tools, e.g. code-graph-mcp .tmp/index.db)', () => {
    const other = makeDir('.tmpXYZ', 5 * 60 * 60 * 1000); // code-graph-mcp style
    const generic = makeDir('plans-abc', 5 * 60 * 60 * 1000); // generic prefix, intentionally excluded
    const { removed } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000 });
    expect(removed).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(generic)).toBe(true);
  });

  it('dryRun lists without deleting', () => {
    const stale = makeDir('cite-ups-xyz', 5 * 60 * 60 * 1000);
    const { removed, names } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000, dryRun: true });
    expect(removed).toBe(1);
    expect(names).toContain(stale);
    expect(existsSync(stale)).toBe(true); // not deleted
  });

  it('handles a missing root dir gracefully', () => {
    const { removed } = sweepStaleTestFixtures({ dirs: [join(root, 'does-not-exist')], ageMs: 1000 });
    expect(removed).toBe(0);
  });
});

// E2E round 2026-09-29: the user-facing `install.mjs cleanup` — the command doctor sends
// people to — ran this sweep over os.tmpdir(), ~/.claude/tmp and ~/.cache/tmp, and the
// prefixes are this repo's fixture names: `mem-`, `cite-`, `adopt-`. It deleted another
// program's `mem-profiler-snapshots/` (contents and all). The sweep is the test suite's own
// reaper (tests/global-setup.mjs); a user's cleanup must not reach it.
describe('install.mjs cleanup leaves temp dirs it did not create', () => {
  it('keeps an old `mem-` / `cite-` / `adopt-` dir in every temp root', async () => {
    const { spawnSync } = await import('node:child_process');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const root = mkdtempSync(join(tmpdir(), 'cml-cleanup-foreign-'));
    try {
      const home = join(root, 'home');
      const tmp = join(root, 'tmp');
      const dirs = [
        join(tmp, 'mem-profiler-snapshots'),
        join(home, '.claude', 'tmp', 'cite-bibtex-cache'),
        join(home, '.cache', 'tmp', 'adopt-a-pet-scrape'),
      ];
      const old = (Date.now() - 3 * 86400000) / 1000;
      for (const d of dirs) {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'data.json'), '{}');
        utimesSync(d, old, old);
      }
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'cleanup'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: tmp,
          CLAUDE_MEM_DIR: join(root, 'data'),
          MEM_NO_AUTO_ADOPT: '1',
        },
      });
      expect(r.status).toBe(0);
      for (const d of dirs) expect(existsSync(join(d, 'data.json')), d).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
