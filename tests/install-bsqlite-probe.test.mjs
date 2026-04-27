// install-bsqlite-probe.test.mjs — Bug 3 regression
// install.mjs must verify better-sqlite3 native binding is loadable AFTER
// `npm install` runs. Pre-built binaries can mismatch the user's Node ABI
// (e.g. Node v24 NODE_MODULE_VERSION 137) and `npm install` exits 0 even when
// the .node binary is unusable. Without a verify step, install completes
// "successfully" and the next launch FATALs with "Could not locate the
// bindings file". The probe exists so we can detect this and auto-rebuild
// before declaring install done.

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { probeBetterSqlite3Binding, ensureBetterSqlite3Working } from '../install.mjs';

describe('Bug 3: better-sqlite3 binding probe', () => {
  it('returns {ok:true} when binding is loadable in the given installDir', async () => {
    const result = await probeBetterSqlite3Binding(resolve('.'));
    expect(result.ok).toBe(true);
  });

  it('returns {ok:false, error} when installDir has no node_modules/better-sqlite3', async () => {
    const result = await probeBetterSqlite3Binding('/tmp/does-not-exist-' + Date.now());
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});

describe('Bug 3: ensureBetterSqlite3Working — probe → rebuild → re-probe', () => {
  it('returns {ok:true, action:"verified"} and skips rebuild when first probe passes', async () => {
    const calls = { probe: 0, rebuild: 0 };
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => { calls.probe++; return { ok: true }; },
      rebuild: async () => { calls.rebuild++; },
    });
    expect(result).toEqual({ ok: true, action: 'verified' });
    expect(calls.probe).toBe(1);
    expect(calls.rebuild).toBe(0);
  });

  it('runs rebuild and re-probes when first probe fails, returns action:"rebuilt" on success', async () => {
    let probeCount = 0;
    const calls = { rebuild: 0 };
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => {
        probeCount++;
        return probeCount === 1 ? { ok: false, error: 'bindings missing' } : { ok: true };
      },
      rebuild: async () => { calls.rebuild++; },
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(probeCount).toBe(2);
    expect(calls.rebuild).toBe(1);
  });

  it('returns {ok:false, error} when rebuild does not fix the binding', async () => {
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => ({ ok: false, error: 'bindings still missing' }),
      rebuild: async () => { /* noop */ },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bindings still missing');
  });

  it('reports rebuild error when the rebuild step itself throws', async () => {
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => ({ ok: false, error: 'first probe fail' }),
      rebuild: async () => { throw new Error('npm rebuild crashed'); },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('npm rebuild crashed');
  });
});
