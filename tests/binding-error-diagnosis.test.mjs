// The ABI diagnosis must reach the user, not just the path it happened in.
//
// `probeBindingInFreshProcess`'s error for a stale binding is five lines, and line 0
// is only a filename:
//
//   [0] The module '/…/better_sqlite3.node'
//   [1] was compiled against a different Node.js version using
//   [2] NODE_MODULE_VERSION 127. This version of Node.js requires   ← the diagnosis
//   [3] NODE_MODULE_VERSION 137. Please try re-compiling or re-installing
//   [4] the module (for instance, using `npm rebuild` or `npm install`).
//
// Four surfaces rendered it with `.split('\n')[0]`, so for the one fault family this
// whole subsystem exists to detect, every one of them showed a bare path and dropped
// the ABI numbers. `lib/binding-probe.mjs` even asserts in a comment that this string
// is "the highest-value line doctor prints" — for this family it carried no diagnosis
// at all. Worse on an unowned root, where doctor rendered a path from the ANCESTOR
// tree immediately followed by "this install owns no node_modules": two halves naming
// different trees.
//
// Reproduced live, not from a fixture: on a machine with a stale ~/node_modules
// better-sqlite3, `probeBindingInFreshProcess('/nonexistent-root')` resolves up the
// directory tree and returns exactly the five lines above.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { flattenBindingError } from '../lib/binding-probe.mjs';
import { recordNativeBindingBreakage, readNativeBindingBreakage } from '../lib/native-binding-hint.mjs';

// The real shape, copied from a live probe against a genuinely ABI-127 tree.
const ABI_ERROR = [
  "The module '/home/u/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
  'was compiled against a different Node.js version using',
  'NODE_MODULE_VERSION 127. This version of Node.js requires',
  'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing',
  'the module (for instance, using `npm rebuild` or `npm install`).',
].join('\n');

describe('flattenBindingError', () => {
  it('keeps the ABI numbers — the only part that identifies the fault', () => {
    const out = flattenBindingError(ABI_ERROR);
    expect(out).toContain('NODE_MODULE_VERSION 127');
    expect(out).toContain('NODE_MODULE_VERSION 137');
  });

  it('collapses to a single line, so it cannot split a JSON envelope or a log record', () => {
    const out = flattenBindingError(ABI_ERROR);
    expect(out).not.toContain('\n');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('keeps the offending path too — which tree failed still matters', () => {
    expect(flattenBindingError(ABI_ERROR)).toContain('better_sqlite3.node');
  });

  it('bounds the length so one probe cannot flood a hook receipt', () => {
    const out = flattenBindingError('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(240);
  });

  it('marks truncation rather than ending mid-word with no signal', () => {
    expect(flattenBindingError('y'.repeat(5000))).toMatch(/…$/);
  });

  it('passes a short single-line error through untouched', () => {
    expect(flattenBindingError('Could not locate the bindings file. Tried: x'))
      .toBe('Could not locate the bindings file. Tried: x');
  });

  it('survives null / undefined / a thrown non-Error', () => {
    expect(flattenBindingError(null)).toBe('unknown');
    expect(flattenBindingError(undefined)).toBe('unknown');
    expect(flattenBindingError({ toString: () => 'weird' })).toBe('weird');
  });
});

describe('the diagnosis reaches every surface that renders it', () => {
  let runtimeDir;
  beforeEach(() => { runtimeDir = mkdtempSync(join(tmpdir(), 'mem-abidiag-')); });
  afterEach(() => { try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('the persisted breakage marker keeps the ABI numbers', () => {
    // doctor reads this back hours later as "a fire failed ~Nh ago (<reason>)". A bare
    // path there tells the user nothing about what to do.
    recordNativeBindingBreakage(runtimeDir, { reason: ABI_ERROR, event: 'PreToolUse' });
    const back = readNativeBindingBreakage(runtimeDir);
    expect(back.reason).toContain('NODE_MODULE_VERSION 127');
    expect(back.reason).not.toContain('\n');
  });

  it("doctor's per-root message keeps the ABI numbers", async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const [r] = probeRuntimeRoots(
      [{ label: 'managed install', root: '/nowhere', ownDeps: true }],
      { probe: () => ({ ok: false, error: ABI_ERROR }) },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('NODE_MODULE_VERSION 127');
    expect(r.error).toContain('NODE_MODULE_VERSION 137');
    expect(r.error).not.toContain('\n');
  });

  it('an unowned root still names its own tree alongside the ancestor path it failed in', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const [r] = probeRuntimeRoots(
      [{ label: 'managed install', root: '/opt/app', ownDeps: false }],
      { probe: () => ({ ok: false, error: ABI_ERROR }) },
    );
    // Both facts have to be legible together: where it failed, and that this install
    // has nothing of its own to rebuild.
    expect(r.error).toContain('better_sqlite3.node');
    expect(r.error).toContain('owns no node_modules');
    expect(r.repair).toContain('npm install');
  });
});
