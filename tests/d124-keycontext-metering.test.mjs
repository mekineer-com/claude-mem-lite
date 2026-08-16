// D#124 — Key Context rows were shown but never counted.
//
// SessionStart (and PreCompact) render up to 10 obs into the
// <claude-mem-context> File Lessons / Key Context sections. Those rows got
// NEITHER an injection_count bump (unlike the UPS surface, hook-memory.mjs:350)
// NOR a citation extractor (extractAllInjected covered 4 faces). So an entire
// injection surface was invisible to the promote/demote loop: rows shown every
// single session could never accrue a denominator, and a row the agent DID cite
// off the SessionStart block could never be promoted for it.
//
// v3.65.0 already persists the ACTUALLY-rendered ids to a per-session marker
// (the D#123 review C-1 fix). This wires that same list into both halves:
//   ① bump at render time, from the rendered list — not from a re-run query;
//   ② a 5th extractor face reading the marker, session-gated.
//
// Both writers go through ONE recorder so the SessionStart / PreCompact pair
// cannot drift — the twin-drift class this repo has re-opened repeatedly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createTestDb } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { keyContextIdsFileName } from '../lib/injected-ids.mjs';
import { recordKeyContextInjection } from '../lib/keyctx-marker.mjs';
import { extractInjectedFromKeyContext, extractAllInjected } from '../lib/citation-tracker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'keyctx--test';
const SESSION = 'cc-session-aaa';

let runtimeDir;
let db;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'keyctx-'));
  db = createTestDb();
});
afterEach(() => {
  db.close();
  rmSync(runtimeDir, { recursive: true, force: true });
});

// Titles must be mutually dissimilar: saveObservation's tier-1 dedup drops a
// title within Jaccard 0.85 of one saved in the last 5 minutes, which would
// silently hand this test fewer rows than it asked for.
const SEED_TITLES = [
  'FTS trigger stopped firing after the schema rebuild',
  'Proxy CONNECT tunnel drops keep-alive on redirect',
  'Vector vocabulary omitted lesson text entirely',
];

function seed(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = saveObservation(db, {
      project: PROJECT,
      type: 'bugfix',
      content: `${SEED_TITLES[i]} — full body describing the root cause and the fix applied`,
      title: SEED_TITLES[i],
    });
    expect(r.kind, `seed ${i} was deduped`).toBe('saved');
    ids.push(r.id);
  }
  expect(new Set(ids).size).toBe(n);
  return ids;
}

function markerPath(session = SESSION) {
  return join(runtimeDir, keyContextIdsFileName(PROJECT, session));
}

describe('recordKeyContextInjection — render-time metering', () => {
  it('bumps injection_count and last_injected_at for exactly the rendered ids', () => {
    const [a, b, c] = seed(3);
    const before = db.prepare('SELECT id, injection_count FROM observations').all();
    expect(before.every((r) => !r.injection_count)).toBe(true);

    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [a, c] });

    const rows = Object.fromEntries(
      db.prepare('SELECT id, injection_count, last_injected_at FROM observations').all().map((r) => [r.id, r])
    );
    expect(rows[a].injection_count).toBe(1);
    expect(rows[c].injection_count).toBe(1);
    // The un-rendered row must stay at zero — bumping the QUERY rather than the
    // rendered list is exactly the mistake D#123's review reversed.
    expect(rows[b].injection_count ?? 0).toBe(0);
    expect(rows[a].last_injected_at).toBeGreaterThan(0);
    expect(rows[b].last_injected_at ?? null).toBeNull();
  });

  it('accumulates across renders (SessionStart then PreCompact)', () => {
    const [a] = seed(1);
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [a] });
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [a] });
    expect(db.prepare('SELECT injection_count FROM observations WHERE id = ?').get(a).injection_count).toBe(2);
  });

  it('writes the marker even when nothing rendered (quiet/adopted project)', () => {
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [] });
    expect(existsSync(markerPath())).toBe(true);
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).ids).toEqual([]);
  });

  it('never throws when the runtime dir is unwritable — rendering must not break', () => {
    const [a] = seed(1);
    expect(() => recordKeyContextInjection(db, {
      runtimeDir: '/nonexistent-dir-for-keyctx-test', project: PROJECT, sessionId: SESSION, ids: [a],
    })).not.toThrow();
    // The bump still lands: a marker-write failure must not cost the metering.
    expect(db.prepare('SELECT injection_count FROM observations WHERE id = ?').get(a).injection_count).toBe(1);
  });
});

describe('extractInjectedFromKeyContext — the 5th extractor face', () => {
  it('returns the ids the marker says were rendered', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [11, 22], ts: Date.now(), session: SESSION }));
    expect([...extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION })].sort())
      .toEqual([11, 22]);
  });

  it('ignores a marker written by a DIFFERENT session', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [11, 22], ts: Date.now(), session: 'cc-session-other' }));
    expect(extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION }).size).toBe(0);
  });

  it('is empty (not throwing) when no marker exists or the file is corrupt', () => {
    expect(extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION }).size).toBe(0);
    writeFileSync(markerPath(), 'not json{');
    expect(extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION }).size).toBe(0);
  });

  it('rejects non-id junk in the marker', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [7, 'abc', -1, 0, 1e9, null], session: SESSION }));
    expect([...extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION })]).toEqual([7]);
  });
});

describe('extractAllInjected wiring', () => {
  it('unions the Key Context face when the caller supplies the marker coordinates', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [4242], ts: Date.now(), session: SESSION }));
    const withCoords = extractAllInjected(null, {
      mainOnly: true, runtimeDir, project: PROJECT, sessionId: SESSION,
    });
    expect(withCoords.has(4242)).toBe(true);
  });

  it('does NOT read any marker when the caller supplies no coordinates', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [4242], ts: Date.now(), session: SESSION }));
    // Callers like computeCiteRecall analyse an arbitrary transcript with no
    // session context; they must stay on the four transcript-derived faces.
    expect(extractAllInjected(null, { mainOnly: true }).has(4242)).toBe(false);
  });
});

describe('both render surfaces go through the one recorder', () => {
  // FAILS-IF a future edit re-inlines writeFileSync at either surface: the twin
  // that skips the recorder silently loses the injection_count bump again.
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');

  for (const file of ['hook.mjs', 'hook-precompact.mjs']) {
    it(`${file} calls recordKeyContextInjection`, () => {
      // Must match the CALL, not the import line — an earlier version of this
      // pin passed while the surface had stopped calling the recorder entirely,
      // because `import { recordKeyContextInjection }` still satisfied it.
      expect(read(file)).toMatch(/\brecordKeyContextInjection\(\s*db\b/);
    });

    it(`${file} no longer hand-writes the keyctx marker`, () => {
      const src = read(file);
      // The marker filename helper may only be referenced by the recorder now
      // (hook.mjs still reads the marker back on the prompt path, so allow reads
      // — what must be gone is a writeFileSync whose path is the keyctx name).
      expect(src).not.toMatch(/writeFileSync\(\s*\n?\s*join\([^)]*keyContextIdsFileName/);
    });
  }

  it('the Stop handler passes the marker coordinates into extractAllInjected', () => {
    const src = read('hook.mjs');
    const call = src.match(/extractAllInjected\(transcriptPath,\s*\{[^}]*\}/s);
    expect(call, 'extractAllInjected call site not found').not.toBeNull();
    expect(call[0]).toContain('runtimeDir');
    expect(call[0]).toContain('project');
  });
});
