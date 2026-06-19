// Tests for lib/native-binding-hint.mjs — the rate-limited friendly hint for an
// unloadable native DB binding (better-sqlite3 ERR_DLOPEN_FAILED). Pure-fn unit
// tests with injected now + tmp runtimeDir; no schema.mjs/better-sqlite3 import.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  nativeBindingHintDue,
  formatHookError,
  NATIVE_BINDING_HINT_COOLDOWN_MS,
} from '../lib/native-binding-hint.mjs';

describe('nativeBindingHintDue', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cml-nbh-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is due on first call and records a marker', () => {
    expect(nativeBindingHintDue(dir, 1_000_000)).toBe(true);
    expect(existsSync(join(dir, 'native-binding-hint-last'))).toBe(true);
  });

  it('suppresses within the cooldown window', () => {
    const t0 = 1_000_000;
    expect(nativeBindingHintDue(dir, t0)).toBe(true);
    expect(nativeBindingHintDue(dir, t0 + NATIVE_BINDING_HINT_COOLDOWN_MS - 1)).toBe(false);
  });

  it('is due again once the cooldown elapses', () => {
    const t0 = 1_000_000;
    expect(nativeBindingHintDue(dir, t0)).toBe(true);
    expect(nativeBindingHintDue(dir, t0 + NATIVE_BINDING_HINT_COOLDOWN_MS + 1)).toBe(true);
  });

  it('is due when the marker content is garbage (best-effort)', () => {
    writeFileSync(join(dir, 'native-binding-hint-last'), 'not-a-number');
    expect(nativeBindingHintDue(dir, 1_000_000)).toBe(true);
  });
});

describe('formatHookError', () => {
  const NOW = 1_700_000_000_000; // fixed → deterministic ISO timestamp

  it('formats a non-DLOPEN error as the structured ERROR line', () => {
    const line = formatHookError(new Error('boom'), 'stop', { now: NOW });
    expect(line).toContain('[claude-mem-lite]');
    expect(line).toContain('[ERROR] stop: boom');
  });

  it('collapses ERR_DLOPEN_FAILED to a short WARN rebuild hint', () => {
    const err = Object.assign(
      new Error('The module ... was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version requires 137.'),
      { code: 'ERR_DLOPEN_FAILED' },
    );
    const line = formatHookError(err, 'stop', { now: NOW });
    expect(line).toContain('[WARN] stop:');
    expect(line).toContain('native DB binding');
    expect(line).toContain('claude-mem-lite repair');
    // the verbose original message must NOT leak through
    expect(line).not.toContain('NODE_MODULE_VERSION');
  });

  it('rate-limits the DLOPEN hint when a runtimeDir is provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cml-nbh-fmt-'));
    try {
      const err = Object.assign(new Error('x'), { code: 'ERR_DLOPEN_FAILED' });
      expect(formatHookError(err, 'stop', { now: NOW, runtimeDir: dir })).not.toBeNull();
      expect(formatHookError(err, 'stop', { now: NOW + 1000, runtimeDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
