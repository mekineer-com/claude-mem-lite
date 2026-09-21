// `get D#<missing>` said "Deferred item(s) not found" twice, the second line a superset of
// the first.
//
// The two writers answer different questions and both are wanted. mem-cli.mjs's early
// stderr note names which D# ids missed while OTHER sections still render — a mixed request
// has to say that, because its output otherwise looks complete. The terminal `fail()` below
// it reports "nothing at all was found" and adds the `defer list` hint. They overlap on
// exactly one shape: a deferred-only request where nothing matched, which is what a user
// typing a stale `D#` id hits.
//
// So the guard has to pin BOTH directions. Suppressing the early note outright would be the
// obvious over-fix and would silence the mixed case, which is the one that needs it most.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO = resolve(import.meta.dirname, '..');
const CLI = join(REPO, 'cli.mjs');

let sandbox;

// spawnSync, not execFileSync: the note under test goes to STDERR, and execFileSync returns
// stderr only on the throwing path. The mixed-request case exits 0, so its stderr would have
// been dropped and the arm would have read zero notes against a healthy surface.
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: join(sandbox, 'home'),
      CLAUDE_MEM_DIR: join(sandbox, 'home', '.claude-mem-lite'),
      CLAUDE_PROJECT_DIR: join(sandbox, 'proj'),
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
    },
  });
  return (r.stdout || '') + (r.stderr || '');
}

const missCount = (out) => out.split('Deferred item(s) not found').length - 1;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mem-get-deferred-'));
  mkdirSync(join(sandbox, 'home', '.claude-mem-lite'), { recursive: true });
  mkdirSync(join(sandbox, 'proj'), { recursive: true });
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('get D# reports a missing deferred item once', () => {
  it('says it once when nothing at all matched', () => {
    const out = run(['get', 'D#99']);

    // Premise: this is the not-found path, not some other failure that never reached it.
    expect(out).toMatch(/Deferred item\(s\) not found/);
    expect(missCount(out)).toBe(1);
    // And the surviving line is the useful one — it carries the way out.
    expect(out).toMatch(/defer list/);
  });

  it('still names the misses when part of the request DID resolve', () => {
    const added = run(['defer', 'add', 'check the retry budget', '--priority', '2']);
    expect(added, `defer add did not report an id:\n${added}`).toMatch(/D#1\b/);

    const out = run(['get', 'D#1,D#99']);

    expect(out).toMatch(/check the retry budget/);
    expect(missCount(out)).toBe(1);
  });
});
