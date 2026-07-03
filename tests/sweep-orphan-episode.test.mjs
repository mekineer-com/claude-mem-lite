// Tests for sweepOrphanEpisodeFiles — the SessionStart auto-maintain helper
// that removes crashed `ep-flush-*` / `pending-*` runtime files (1h floor) and
// abandoned `reads-*.txt` Read trackers (24h floor). Locks the age-gated
// contract: in-flight episode files AND active read sessions (mtime newer than
// their respective cutoff) are NEVER touched, only orphans are reaped.

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

  it('returns 0 when no sweep-eligible files exist (unrelated file + fresh reads survive)', () => {
    writeWithMtime('not-an-episode.json', 99 * 3600 * 1000); // never a sweep target
    writeWithMtime('reads-foo.txt', 2 * 3600 * 1000);        // reads tracker, but < 24h → active
    expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
    expect(existsSync(join(dir, 'not-an-episode.json'))).toBe(true);
    expect(existsSync(join(dir, 'reads-foo.txt'))).toBe(true);
  });

  it('sweeps reads-*.txt older than the 24h floor but keeps active (< 24h) ones', () => {
    const abandoned = writeWithMtime('reads-old.txt', 25 * 3600 * 1000); // 25h → abandoned
    const active = writeWithMtime('reads-active.txt', 12 * 3600 * 1000);  // 12h → long read session
    expect(sweepOrphanEpisodeFiles(dir)).toBe(1);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(active)).toBe(true);
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

  it('only matches known prefixes (ep-flush/pending/reads) — no over-broad sweep', () => {
    writeWithMtime('ep-flush-orphan.json', 99 * 3600 * 1000);
    writeWithMtime('pending-orphan.json', 99 * 3600 * 1000);
    writeWithMtime('reads-baz.txt', 99 * 3600 * 1000);       // abandoned tracker → swept (>24h)
    writeWithMtime('cite-recall-foo.json', 99 * 3600 * 1000); // cite-recall lives forever
    writeWithMtime('session-bar', 99 * 3600 * 1000);

    expect(sweepOrphanEpisodeFiles(dir)).toBe(3);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(['cite-recall-foo.json', 'session-bar']);
  });

  it('honors a custom `now` so callers can pin time for deterministic assertions', () => {
    const t0 = 1_000_000_000_000;
    const stale = writeWithMtime('ep-flush-stale.json', 0);
    utimesSync(stale, (t0 - 2 * 3600 * 1000) / 1000, (t0 - 2 * 3600 * 1000) / 1000);
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 3600 * 1000, now: t0 })).toBe(1);
  });
});
