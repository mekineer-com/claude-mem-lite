// P2-13 (narrowed) — DAY_MS had four definitions and ~60 bare literals.
//
// The full P2-13 item was "audit every empty catch block"; 135 non-test sites
// would have become 135 rubber-stamp comments, so only this half was taken.
// The value here is not drift-prevention — 86_400_000 is a physical constant —
// it is that a window policy now greps as a NAME. `30 * DAY_MS` states the
// unit; `2592000000` makes every reader recompute it.
//
// Scope: runtime source only. tests/ and benchmark/ keep their local literals
// on purpose — a fixture saying `epochOffset: -60 * 86400000` is stating raw
// data, and rewriting ~200 assertion sites would be churn with no reader.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DAY_MS } from '../lib/time-constants.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'benchmark', '.git', '.tmp', 'coverage', 'docs', 'tasks', '.loop']);

function runtimeSources(dir = ROOT, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { runtimeSources(full, acc); continue; }
    if (/\.(mjs|js)$/.test(name)) acc.push(full.slice(ROOT.length + 1));
  }
  return acc;
}

describe('time constants', () => {
  it('DAY_MS is a day in milliseconds', () => {
    // Derived in-module from second/minute/hour so the arithmetic is visible;
    // this pins the result the ~60 converted call sites now depend on.
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe('single-sourcing (runtime source only)', () => {
  const files = runtimeSources().filter((f) => f !== 'lib/time-constants.mjs');

  it('finds a non-trivial set of files to check', () => {
    // Guards the scan itself: a broken walker would make every assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('hook.mjs');
    expect(files).toContain('lib/metrics.mjs');
    expect(files).toContain('scripts/pre-tool-recall.js');
  });

  it('no runtime module re-declares DAY_MS', () => {
    const offenders = files.filter((f) =>
      /^\s*(?:export\s+)?const DAY_MS\s*=/m.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no runtime module carries a bare day-in-ms literal', () => {
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const n = (src.match(/\b86_?400_?000\b/g) || []).length;
      if (n > 0) offenders.push(`${f} (${n})`);
    }
    expect(offenders).toEqual([]);
  });
});
