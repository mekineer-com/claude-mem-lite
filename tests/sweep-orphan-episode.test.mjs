// Tests for sweepOrphanEpisodeFiles — the SessionStart auto-maintain helper
// that removes crashed `ep-flush-*` / `pending-*` runtime files. Locks the
// age-gated contract: in-flight files (mtime newer than ageMs) are NEVER
// touched, only orphans are reaped.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sweepOrphanEpisodeFiles } from '../hook-shared.mjs';

describe('sweepOrphanEpisodeFiles', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-orphan-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function writeWithMtime(name, ageMs) {
    const full = join(dir, name);
    writeFileSync(full, '{}');
    if (ageMs > 0) {
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(full, t, t);
    }
    return full;
  }

  it('returns 0 when the directory does not exist', () => {
    expect(sweepOrphanEpisodeFiles(join(dir, 'missing'))).toBe(0);
  });

  it('returns 0 when no matching files exist', () => {
    writeWithMtime('not-an-episode.json', 99 * 3600 * 1000);
    writeWithMtime('reads-foo.txt', 99 * 3600 * 1000);
    expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
    expect(existsSync(join(dir, 'not-an-episode.json'))).toBe(true);
    expect(existsSync(join(dir, 'reads-foo.txt'))).toBe(true);
  });

  it('sweeps ep-flush-* files older than ageMs', () => {
    const stale = writeWithMtime('ep-flush-1234-aaaa.json', 2 * 3600 * 1000); // 2h old
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 60 * 60 * 1000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it('sweeps pending-* files older than ageMs', () => {
    const stale = writeWithMtime('pending-xyz.json', 2 * 3600 * 1000);
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 60 * 60 * 1000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it('does NOT touch in-flight files (mtime newer than cutoff)', () => {
    const fresh = writeWithMtime('ep-flush-fresh.json', 5 * 60 * 1000); // 5 min old
    const stale = writeWithMtime('ep-flush-stale.json', 2 * 3600 * 1000); // 2h old
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 60 * 60 * 1000 })).toBe(1);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('only matches the two known prefixes (no over-broad sweep)', () => {
    writeWithMtime('ep-flush-orphan.json', 99 * 3600 * 1000);
    writeWithMtime('pending-orphan.json', 99 * 3600 * 1000);
    writeWithMtime('cite-recall-foo.json', 99 * 3600 * 1000); // cite-recall lives forever
    writeWithMtime('session-bar', 99 * 3600 * 1000);
    writeWithMtime('reads-baz.txt', 99 * 3600 * 1000);

    expect(sweepOrphanEpisodeFiles(dir)).toBe(2);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(['cite-recall-foo.json', 'reads-baz.txt', 'session-bar']);
  });

  it('honors a custom `now` so callers can pin time for deterministic assertions', () => {
    const t0 = 1_000_000_000_000;
    const stale = writeWithMtime('ep-flush-stale.json', 0);
    utimesSync(stale, (t0 - 2 * 3600 * 1000) / 1000, (t0 - 2 * 3600 * 1000) / 1000);
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 3600 * 1000, now: t0 })).toBe(1);
  });
});
