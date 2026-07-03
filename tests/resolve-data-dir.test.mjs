// Guard for the CLAUDE_MEM_DIR resolver: a JS `undefined`/`null` stringified
// into the env (or a relative path) must NOT silently become a data directory.
// Regression: benchmark/efficacy-harness.mjs shell-interpolated an undefined
// sandbox → child saw CLAUDE_MEM_DIR='undefined' → the resolver created a
// relative `undefined/` dir at cwd (observed residue at repo root, 2026-06-25).
import { describe, test, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';

describe('resolveDataDir', () => {
  const DEFAULT = join(homedir(), '.claude-mem-lite');

  test('unset (undefined arg) falls back to the homedir default', () => {
    expect(resolveDataDir(undefined)).toBe(DEFAULT);
  });

  test('empty string falls back to the homedir default', () => {
    expect(resolveDataDir('')).toBe(DEFAULT);
  });

  test('a valid absolute path passes through unchanged', () => {
    expect(resolveDataDir('/tmp/mem-sandbox')).toBe('/tmp/mem-sandbox');
  });

  test('the literal string "undefined" throws instead of creating undefined/', () => {
    expect(() => resolveDataDir('undefined')).toThrow(/absolute path/);
  });

  test('the literal string "null" throws', () => {
    expect(() => resolveDataDir('null')).toThrow(/absolute path/);
  });

  test('a relative path throws instead of scattering data under cwd', () => {
    expect(() => resolveDataDir('relative/mem')).toThrow(/absolute path/);
  });
});
