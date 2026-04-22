// P4 citation tracker — transcript scanning + access_count bump.
//
// Verifies #NN citations in assistant text are extracted (not from user/tool
// messages), deduped, and bumped against observations scoped by project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractCitationsFromTranscript,
  bumpCitationAccess,
} from '../lib/citation-tracker.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('extractCitationsFromTranscript', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'citation-test-'));
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('extracts #NN from assistant text blocks', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Per #42 and #7556, I avoided the regression.' }] },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(42)).toBe(true);
    expect(ids.has(7556)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('dedupes repeated citations', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '#42 and #42 again' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'still #42' }] },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.size).toBe(1);
    expect(ids.has(42)).toBe(true);
  });

  it('ignores #NN in user messages', () => {
    const path = writeTranscript([
      { type: 'user', message: { content: [{ type: 'text', text: 'look at #99' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I see #42' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(99)).toBe(false);
    expect(ids.has(42)).toBe(true);
  });

  it('ignores non-text content blocks (tool_use / tool_result / thinking)', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'x' } },
            { type: 'thinking', thinking: 'Considering #77 but not citing' },
            { type: 'text', text: 'Actually, per #42 it works.' },
          ],
        },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.size).toBe(1);
    expect(ids.has(42)).toBe(true);
    expect(ids.has(77)).toBe(false);
  });

  it('rejects out-of-range IDs (0, >= 1e7, negative)', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '#0 and #99999999 and #1234567 are weird' }] },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(0)).toBe(false);
    expect(ids.has(99999999)).toBe(false);
    expect(ids.has(1234567)).toBe(true); // boundary: 7 digits OK, 8 digits rejected
  });

  it('returns empty set for missing transcript path', () => {
    expect(extractCitationsFromTranscript('/nonexistent/path').size).toBe(0);
    expect(extractCitationsFromTranscript('').size).toBe(0);
    expect(extractCitationsFromTranscript(null).size).toBe(0);
  });

  it('tolerates malformed JSONL lines', () => {
    const path = join(tmp, 'bad.jsonl');
    writeFileSync(path, 'not json\n{"type":"assistant","message":{"content":[{"type":"text","text":"#42"}]}}\nalso bad');
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(42)).toBe(true);
    expect(ids.size).toBe(1);
  });
});

describe('bumpCitationAccess', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'projects--test' });
  });

  afterEach(() => {
    db.close();
  });

  const newObs = (opts) => Number(insertObs(db, opts).lastInsertRowid);

  it('increments access_count for matched project obs', () => {
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const id2 = newObs({ title: 'Y', type: 'decision', project: 'projects--test' });

    const n = bumpCitationAccess(db, [id1, id2], 'projects--test');
    expect(n).toBe(2);
    const rows = db.prepare('SELECT id, access_count, last_accessed_at FROM observations WHERE id IN (?, ?)').all(id1, id2);
    for (const r of rows) {
      expect(r.access_count).toBe(1);
      expect(r.last_accessed_at).toBeGreaterThan(0);
    }
  });

  it('ignores IDs belonging to other projects', () => {
    insertSession(db, { id: 'sess-other', project: 'projects--other' });
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const id2 = newObs({ title: 'Y', type: 'bugfix', project: 'projects--other', sessionId: 'sess-other' });

    const n = bumpCitationAccess(db, [id1, id2], 'projects--test');
    expect(n).toBe(1);
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id1).access_count).toBe(1);
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id2).access_count).toBe(0);
  });

  it('returns 0 for empty id list', () => {
    expect(bumpCitationAccess(db, [], 'projects--test')).toBe(0);
    expect(bumpCitationAccess(db, new Set(), 'projects--test')).toBe(0);
  });

  it('returns 0 for non-existent IDs (no crash)', () => {
    expect(bumpCitationAccess(db, [999999], 'projects--test')).toBe(0);
  });

  it('accumulates across multiple citation rounds', () => {
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    bumpCitationAccess(db, [id1], 'projects--test');
    bumpCitationAccess(db, [id1], 'projects--test');
    bumpCitationAccess(db, [id1], 'projects--test');
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id1).access_count).toBe(3);
  });

  it('accepts Set and Array iterables', () => {
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const n = bumpCitationAccess(db, new Set([id1]), 'projects--test');
    expect(n).toBe(1);
  });
});
