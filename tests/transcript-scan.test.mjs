// Audit 2026-08-22 P2-8: handleStop scanned one transcript eight times, each scan doing
// its own read + JSON.parse per line (~25ms per pass on a real 5.7MB transcript; 166ms
// for the eight, against a 5s budget, growing with the session). They now share one
// parse: 30ms for the same eight, measured on the same file.
//
// Caching a file that another process is still appending to is where this goes wrong, so
// the cases below are about freshness and about the retention cap — not about speed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readTranscriptEntries, _resetTranscriptCache, TRANSCRIPT_CACHE_MAX_BYTES } from '../lib/transcript-scan.mjs';

let dir, tx;

// Whole seconds only. The two cache-HIT cases below need a size+mtime pair that survives
// a rewrite unchanged, and utimes cannot portably round-trip an arbitrary sub-millisecond
// mtime — see the comment in the first of them.
const PINNED_MTIME_SEC = 1_700_000_000;

const line = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tx-scan-'));
  tx = join(dir, 'session.jsonl');
  _resetTranscriptCache();
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

describe('readTranscriptEntries', () => {
  it('parses one record per non-empty line and drops the unparsable ones', () => {
    // A transcript being appended to right now can end in half a line.
    writeFileSync(tx, `${line('one')}\n\n${line('two')}\n{"type":"assistant","mess`);
    const entries = readTranscriptEntries(tx);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.message.content[0].text)).toEqual(['one', 'two']);
  });

  it('returns an empty array for a missing path rather than throwing', () => {
    expect(readTranscriptEntries(join(dir, 'nope.jsonl'))).toEqual([]);
    expect(readTranscriptEntries(null)).toEqual([]);
    expect(readTranscriptEntries(undefined)).toEqual([]);
  });

  it('re-reads when the file grows — Claude Code is still writing during Stop', () => {
    writeFileSync(tx, `${line('first')}\n`);
    expect(readTranscriptEntries(tx).length).toBe(1);
    writeFileSync(tx, `${line('first')}\n${line('second')}\n`);
    const after = readTranscriptEntries(tx);
    expect(after.length, 'a later scanner in the same Stop saw stale content').toBe(2);
    expect(after[1].message.content[0].text).toBe('second');
  });

  it('re-reads when the content changed but the size did not', () => {
    // Growth alone is caught by size, so a key of path+size looks sufficient — and it
    // passes the growth case above while silently serving stale entries for an in-place
    // rewrite (a truncation or compaction that lands on the same byte count). mtime is
    // what separates those, so it has to be in the key and has to be exercised.
    writeFileSync(tx, `${line('before')}\n`);
    const first = readTranscriptEntries(tx);
    expect(first[0].message.content[0].text).toBe('before');
    const sizeBefore = statSync(tx).size;
    writeFileSync(tx, `${line('affter')}\n`);   // same length, different bytes
    expect(statSync(tx).size).toBe(sizeBefore);
    expect(readTranscriptEntries(tx)[0].message.content[0].text).toBe('affter');
  });

  it('serves the same parse to repeated callers — that is the whole point', () => {
    writeFileSync(tx, `${line('cached')}\n`);
    // Pin the mtime to a WHOLE SECOND before taking the baseline, rather than capturing
    // whatever the write produced and restoring it after. The key holds mtimeMs, and a
    // captured sub-millisecond value does not round-trip through utimes portably: CI
    // returned 1787406755453.47 for a value written as 1787406755453.4705, so the key
    // changed and this case failed on a filesystem difference rather than on the cache.
    // A whole second is exactly representable everywhere.
    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const first = readTranscriptEntries(tx);
    // Rewrite the CONTENT while pinning size and mtime, so nothing in the cache key
    // changes. Only a real cache can return the old parse here; a re-reader returns the
    // new text and this case fails.
    const st = statSync(tx);
    writeFileSync(tx, `${line('rewrit')}\n`);
    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    expect(statSync(tx).size, 'the rewrite must keep the size identical').toBe(st.size);
    expect(statSync(tx).mtimeMs, 'the pinned mtime must survive the rewrite').toBe(st.mtimeMs);
    const second = readTranscriptEntries(tx);
    expect(second).toBe(first);
    expect(second[0].message.content[0].text).toBe('cached');
  });

  it('does not retain a transcript larger than the cap', () => {
    // Parsed entries cost ~3.45× the file in heap; holding that for a very large
    // transcript risks the hook being OOM-killed, which loses the session's work. Over
    // the cap each caller parses for itself, exactly as before this change.
    const padding = 'x'.repeat(4096);
    const one = `${line(padding)}\n`;
    const repeats = Math.ceil((TRANSCRIPT_CACHE_MAX_BYTES + 1024 * 1024) / one.length);
    writeFileSync(tx, one.repeat(repeats));
    expect(statSync(tx).size).toBeGreaterThan(TRANSCRIPT_CACHE_MAX_BYTES);

    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const first = readTranscriptEntries(tx);
    const st = statSync(tx);
    // Same pinned-key rewrite as above: an oversized file must come back FRESH.
    writeFileSync(tx, `${line('x'.repeat(padding.length - 6) + 'CHANGED')}\n`.padEnd(st.size, ' '));
    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const second = readTranscriptEntries(tx);
    expect(second).not.toBe(first);
    expect(JSON.stringify(second).includes('CHANGED')).toBe(true);
  });
});
