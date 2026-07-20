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

// npm >= 12 blocks lifecycle scripts by default, so a plain
// `npm rebuild better-sqlite3` exits 0 without compiling the native binding and
// the launcher's self-heal silently no-ops (server then dies pre-handshake →
// MCP -32000). The default rebuild must re-enable scripts for this one vetted
// dep, and fall back to a plain rebuild if an older npm rejects the flag.
describe('Bug: npm 12 allow-scripts block defeats the self-heal rebuild', () => {
  it('default rebuild re-enables install scripts (--dangerously-allow-all-scripts)', async () => {
    const cmds = [];
    let probeCount = 0;
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => { probeCount++; return probeCount === 1 ? { ok: false, error: 'bindings missing' } : { ok: true }; },
      exec: (cmd) => { cmds.push(cmd); }, // capture; simulate a successful build
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('npm rebuild better-sqlite3');
    expect(cmds[0]).toContain('--dangerously-allow-all-scripts');
  });

  it('falls back to a plain rebuild when the bypass flag errors (older npm)', async () => {
    const cmds = [];
    let probeCount = 0;
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => { probeCount++; return probeCount === 1 ? { ok: false, error: 'x' } : { ok: true }; },
      exec: (cmd) => { cmds.push(cmd); if (cmd.includes('--dangerously-allow-all-scripts')) throw new Error('unknown flag'); },
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(cmds).toEqual([
      'npm rebuild better-sqlite3 --dangerously-allow-all-scripts',
      'npm rebuild better-sqlite3',
    ]);
  });
});
