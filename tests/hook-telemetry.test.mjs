// hook-telemetry.test.mjs — unsampled hook-error recorder behavior.
// Regression guard: hook scripts catch-all + exit-0 left every failure
// silent. Recorder turns that into a self-observable signal without changing
// blast radius (must never throw; must never block hook).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordHookError, countRecentHookErrors, HOOK_ERROR_RETENTION_MS } from '../lib/hook-telemetry.mjs';

describe('hook-telemetry — recordHookError', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hook-telemetry-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a JSONL line on every call (no sampling)', () => {
    recordHookError('pre-recall:db-open', new Error('SQLITE_CORRUPT'), tmp);
    const dir = join(tmp, 'hook-errors');
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf8').trim());
    expect(parsed.scope).toBe('pre-recall:db-open');
    expect(parsed.msg).toBe('SQLITE_CORRUPT');
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.stack).toMatch(/hook-telemetry\.test\.mjs/);
  });

  it('appends multiple calls to the same daily shard', () => {
    recordHookError('pre-recall:json', new Error('first'), tmp);
    recordHookError('skill-bridge:registry', new Error('second'), tmp);
    const dir = join(tmp, 'hook-errors');
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).scope).toBe('pre-recall:json');
    expect(JSON.parse(lines[1]).scope).toBe('skill-bridge:registry');
  });

  it('captures optional ctx object (truncated to 240 chars)', () => {
    recordHookError('pre-recall:db-open', new Error('e'), tmp, {
      filePath: '/foo/bar.mjs',
      toolName: 'Edit',
    });
    const dir = join(tmp, 'hook-errors');
    const parsed = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim());
    expect(parsed.ctx).toBe(JSON.stringify({ filePath: '/foo/bar.mjs', toolName: 'Edit' }));
  });

  it('truncates msg to 500 chars and scope to 80 chars', () => {
    recordHookError('x'.repeat(200), new Error('y'.repeat(2000)), tmp);
    const dir = join(tmp, 'hook-errors');
    const parsed = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim());
    expect(parsed.scope.length).toBeLessThanOrEqual(80);
    expect(parsed.msg.length).toBeLessThanOrEqual(500);
  });

  it('handles non-Error thrown values (string, null, undefined)', () => {
    expect(() => recordHookError('s1', 'string-error', tmp)).not.toThrow();
    expect(() => recordHookError('s2', null, tmp)).not.toThrow();
    expect(() => recordHookError('s3', undefined, tmp)).not.toThrow();
    const dir = join(tmp, 'hook-errors');
    const lines = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n');
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).msg).toBe('string-error');
  });

  it('never throws when runtimeDir is missing or invalid', () => {
    expect(() => recordHookError('s', new Error('e'), '')).not.toThrow();
    expect(() => recordHookError('s', new Error('e'), null)).not.toThrow();
    expect(() => recordHookError('s', new Error('e'), undefined)).not.toThrow();
  });

  it('swallows write failures (parent dir unwritable)', () => {
    // Pass a path that cannot be created (under a regular file): mkdirSync
    // throws ENOTDIR and the recorder must absorb it.
    const file = join(tmp, 'blocker');
    writeFileSync(file, 'x');
    expect(() => recordHookError('s', new Error('e'), file)).not.toThrow();
  });
});

describe('hook-telemetry — countRecentHookErrors', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'hook-telemetry-count-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns 0 when no log dir exists', () => {
    expect(countRecentHookErrors(tmp, Date.now() - 86400000)).toBe(0);
  });

  it('counts only entries with ts >= sinceMs', () => {
    const dir = join(tmp, 'hook-errors');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = new Date(now - 3 * 86400000).toISOString();
    const recent = new Date(now - 100).toISOString();
    const lines = [
      JSON.stringify({ ts: old, scope: 'old', msg: 'x' }),
      JSON.stringify({ ts: recent, scope: 'r1', msg: 'x' }),
      JSON.stringify({ ts: recent, scope: 'r2', msg: 'x' }),
    ].join('\n') + '\n';
    writeFileSync(join(dir, '2026-05-23.jsonl'), lines);
    expect(countRecentHookErrors(tmp, now - 86400000)).toBe(2);
    expect(countRecentHookErrors(tmp, now - 5 * 86400000)).toBe(3);
  });

  it('tolerates malformed JSONL lines', () => {
    const dir = join(tmp, 'hook-errors');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const recent = new Date(now - 100).toISOString();
    const body = [
      '{not valid json',
      JSON.stringify({ ts: recent, scope: 'r', msg: 'x' }),
      '',
      'another bad line',
    ].join('\n') + '\n';
    writeFileSync(join(dir, '2026-05-23.jsonl'), body);
    expect(countRecentHookErrors(tmp, now - 86400000)).toBe(1);
  });

  it('ignores files that do not match the shard pattern', () => {
    const dir = join(tmp, 'hook-errors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'not a shard');
    writeFileSync(join(dir, 'garbage.txt'), JSON.stringify({ ts: new Date().toISOString() }));
    expect(countRecentHookErrors(tmp, Date.now() - 86400000)).toBe(0);
  });

  it('returns 0 on invalid runtimeDir', () => {
    expect(countRecentHookErrors('', Date.now())).toBe(0);
    expect(countRecentHookErrors(null, Date.now())).toBe(0);
  });
});

describe('hook-telemetry — retention', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'hook-telemetry-gc-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('exposes a 14-day retention constant', () => {
    expect(HOOK_ERROR_RETENTION_MS).toBe(14 * 86400000);
  });

  it('prunes shards older than retention on the next append', () => {
    const dir = join(tmp, 'hook-errors');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, '2020-01-01.jsonl');
    writeFileSync(stale, '{"ts":"2020-01-01T00:00:00.000Z"}\n');
    // Force mtime well outside retention window.
    const ancient = (Date.now() - HOOK_ERROR_RETENTION_MS - 86400000) / 1000;
    utimesSync(stale, ancient, ancient);
    expect(existsSync(stale)).toBe(true);

    // Trigger pruneOldShards via a fresh record.
    recordHookError('gc-trigger', new Error('e'), tmp);
    expect(existsSync(stale)).toBe(false);
    // Today's shard remains.
    const remaining = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    expect(remaining.length).toBe(1);
  });
});
