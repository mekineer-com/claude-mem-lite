// Contract tests for the cross-hook injected-ids marker — lib/injected-ids.mjs.
//
// Written when the freshness + same-session gate was consolidated out of its five
// hand-typed copies (audit 2026-09-02 P1-2). Mutation-checking that consolidation turned up
// something worse than the duplication: deleting the M-6 SAME-SESSION GATE outright left
// all 5,569 tests in the suite green. That gate is the entire fix for "two concurrent CC
// windows in one project share one suppression state" — session A's injections silently
// deduping session B's, and B inheriting A's count cap — and nothing anywhere pinned it.
// So these are not tests of a refactor; they are the first tests this contract has had.
//
// Deliberately NOT in tests/pathA-exclude-inert.test.mjs, whose own header instructs a
// future reader to DELETE that file in the commit that repairs D#213. The union/replace
// typing rule and the session gate outlive that repair, so they need a home that survives it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readInjectedMarker,
  mergeInjectedMarker,
  injectedIdsFileName,
  MAX_MARKER_IDS,
} from '../lib/injected-ids.mjs';
import { shouldSkipByDedup, MAX_SESSION_INJECTIONS } from '../scripts/prompt-search-utils.mjs';

let dir, file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inj-marker-'));
  file = join(dir, 'marker.json');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const onDisk = () => JSON.parse(readFileSync(file, 'utf8'));
const seed = (payload) => writeFileSync(file, JSON.stringify(payload));
const W = 60000;

describe('readInjectedMarker — the M-6 same-session gate', () => {
  it('rejects a payload written by a DIFFERENT session', () => {
    seed({ ids: [1, 2], ts: Date.now(), count: 3, session: 'other-window' });
    // Premise first: the same payload IS accepted by its own session, so a `fresh:false`
    // below cannot be the staleness gate or a parse failure wearing this gate's name.
    expect(readInjectedMarker(file, { sessionId: 'other-window', maxAgeMs: W }).fresh).toBe(true);
    expect(readInjectedMarker(file, { sessionId: 'mine', maxAgeMs: W })).toEqual({
      ids: [],
      count: 0,
      // B-5 added a second counter and the pre-ship review added its clock; the empty
      // shape carries both for the same reason it carries `count` — a caller reading it
      // must not see another session's budget, nor the clock keeping it alive.
      upsCount: 0,
      upsTs: 0,
      fresh: false,
    });
  });

  it('accepts a LEGACY payload that carries no session at all', () => {
    // Pre-M-6 files must keep the old window-only behaviour rather than being dropped —
    // the marker rotates within minutes, but dropping them would disable dedup meanwhile.
    seed({ ids: [7], ts: Date.now(), count: 1 });
    expect(readInjectedMarker(file, { sessionId: 'mine', maxAgeMs: W }).ids).toEqual([7]);
  });

  it('accepts when the READER has no session id (env-less harnesses)', () => {
    seed({ ids: [8], ts: Date.now(), count: 1, session: 'someone' });
    expect(readInjectedMarker(file, { maxAgeMs: W }).ids).toEqual([8]);
  });
});

describe('readInjectedMarker — freshness and malformed input', () => {
  it('rejects a payload older than the window and keeps a fresh one', () => {
    seed({ ids: [1], ts: Date.now() - 5000, count: 2, session: 's' });
    expect(readInjectedMarker(file, { sessionId: 's', maxAgeMs: 1000 }).fresh).toBe(false);
    expect(readInjectedMarker(file, { sessionId: 's', maxAgeMs: 60000 }).fresh).toBe(true);
  });

  it('returns the empty shape for a missing file, invalid JSON, or a non-array ids', () => {
    // A torn concurrent write leaving invalid JSON is the exact failure M-6's atomic write
    // exists to prevent; the reader must fail closed, never throw into a hook.
    expect(readInjectedMarker(join(dir, 'nope.json'), { maxAgeMs: W }).fresh).toBe(false);
    writeFileSync(file, '{"ids":[1],"ts":');
    expect(readInjectedMarker(file, { maxAgeMs: W }).fresh).toBe(false);
    seed({ ids: 'not-an-array', ts: Date.now() });
    expect(readInjectedMarker(file, { maxAgeMs: W }).fresh).toBe(false);
    seed({ ids: [1] }); // no ts
    expect(readInjectedMarker(file, { maxAgeMs: W }).fresh).toBe(false);
  });
});

describe('mergeInjectedMarker — union vs replace', () => {
  it('union merges with a fresh same-session payload and stringifies the result', () => {
    seed({ ids: ['1'], ts: Date.now(), count: 4, session: 's' });
    mergeInjectedMarker(file, [2, 'D3'], { sessionId: 's', maxAgeMs: W, mode: 'union' });
    const got = onDisk();
    expect(got.ids.sort()).toEqual(['1', '2', 'D3']);
    expect(got.count).toBe(5); // inherited and incremented
    expect(got.session).toBe('s');
  });

  it('replace writes newIds verbatim, preserving the raw-number/string mix', () => {
    seed({ ids: ['9'], ts: Date.now(), count: 4, session: 's' });
    mergeInjectedMarker(file, [10, 'P11'], { sessionId: 's', maxAgeMs: W, mode: 'replace' });
    // Verbatim means the CALLER's ids, not the whole file: B-6 carries '9' forward rather
    // than erasing another hook's seen-set. The typing claim is unchanged — 10 is still a
    // number, which is what D#213 rests on, and the carried id is still a string.
    expect(onDisk().ids).toEqual([10, 'P11', '9']); // NOT ['10','P11'] — see D#213
  });

  it("does not inherit another session's ids or count, in either mode", () => {
    seed({ ids: ['99'], ts: Date.now(), count: 7, session: 'other-window' });
    mergeInjectedMarker(file, [1], { sessionId: 'mine', maxAgeMs: W, mode: 'union' });
    const got = onDisk();
    expect(got.ids, "another window's ids leaked into this session").toEqual(['1']);
    expect(got.count, "another window's count cap was inherited").toBe(1);
  });

  it('does not inherit a STALE same-session payload', () => {
    seed({ ids: ['99'], ts: Date.now() - 5000, count: 7, session: 's' });
    mergeInjectedMarker(file, [1], { sessionId: 's', maxAgeMs: 1000, mode: 'union' });
    expect(onDisk()).toMatchObject({ ids: ['1'], count: 1 });
  });

  it('omits `session` entirely when the caller has no session id (legacy shape)', () => {
    mergeInjectedMarker(file, [1], { maxAgeMs: W, mode: 'union' });
    expect(Object.keys(onDisk())).not.toContain('session');
  });
});

// R12 B-5. `MAX_SESSION_INJECTIONS` is the UPS face's per-session injection budget, but it
// was charged against `count`, which mergeInjectedMarker bumps on EVERY write regardless of
// caller — and pre-tool-recall shares this file, writing once per triggered Edit/Read. So a
// session that touched 15 lesson-bearing files spent the fyi face's whole budget without the
// fyi face injecting anything. The trigger condition is "a heavy session", i.e. exactly when
// recall is worth most.
describe('shouldSkipByDedup — the injection cap is charged to the UPS face only (B-5)', () => {
  const SID = 'sess-cap';
  const merge = (mode, ids, opts = {}) =>
    mergeInjectedMarker(file, ids, { sessionId: SID, maxAgeMs: 5 * 60 * 1000, mode, ...opts });

  it("another hook's writes do not consume the cap", () => {
    for (let i = 0; i < MAX_SESSION_INJECTIONS; i++) merge('union', [`E${i}`]);
    expect(
      JSON.parse(readFileSync(file, 'utf8')).count,
      'premise: the shared counter must actually have reached the cap, or this proves nothing',
    ).toBeGreaterThanOrEqual(MAX_SESSION_INJECTIONS);
    expect(shouldSkipByDedup([9001, 9002], file, SID)).toBe(false);
  });

  it("the UPS face's own injections still hit the cap", () => {
    for (let i = 0; i < MAX_SESSION_INJECTIONS; i++) merge('replace', [i], { bumpUpsCount: true });
    expect(shouldSkipByDedup([9001, 9002], file, SID)).toBe(true);
  });

  // Complementary to the case above: without it, "delete the cap entirely" passes the
  // first case and would look like a fix.
  it('an expired marker releases the cap instead of holding it until the session id changes', () => {
    writeFileSync(
      file,
      JSON.stringify({
        ids: [1],
        ts: Date.now() - 60 * 60 * 1000,
        upsCount: MAX_SESSION_INJECTIONS,
        count: MAX_SESSION_INJECTIONS,
        session: SID,
      }),
    );
    expect(shouldSkipByDedup([9001, 9002], file, SID)).toBe(false);
  });
});

// R12 B-6. The UPS main leg writes `mode:'replace'`, and replace wrote `newIds` as the
// WHOLE array — so one fyi injection erased every id pre-tool-recall had accumulated in the
// window, and the PreToolUse face re-injected lessons it had already shown. The :1013
// comment argues replace entirely on id TYPING (D#213) and never mentions that it also
// clears another hook's state; the D# leg's comment acknowledges the clobber but scopes the
// cost to its own ids.
describe("mergeInjectedMarker — replace keeps the other hook's seen-set (B-6)", () => {
  const SID = 'sess-b6';
  const W = 5 * 60 * 1000;

  it("does not erase another hook's ids", () => {
    mergeInjectedMarker(file, ['101', 'E102', '103', 'E104'], { sessionId: SID, maxAgeMs: W, mode: 'union' });
    mergeInjectedMarker(file, [55], { sessionId: SID, maxAgeMs: W, mode: 'replace' });
    const { ids } = readInjectedMarker(file, { sessionId: SID, maxAgeMs: W });
    expect(ids, 'the fyi injection wiped the PreToolUse seen-set').toContain('E102');
    expect(ids).toContain('E104');
    expect(ids).toContain(55);
  });

  // The pin the audit asked for alongside the fix. D#213 is inert precisely BECAUSE the
  // exclude set is compared with `Set.has(<number from SQLite>)` and the carried ids are
  // strings; the UPS leg's own ids are the one raw-number population, and stringifying
  // them here would turn that exclude live — a measured behaviour change with its own
  // ruler (lib/patha-exclude-meter.mjs) and its own decision, not a side effect of B-6.
  it("still writes the UPS leg's own ids as RAW NUMBERS, leaving D#213 inert", () => {
    mergeInjectedMarker(file, ['101', 'E102'], { sessionId: SID, maxAgeMs: W, mode: 'union' });
    mergeInjectedMarker(file, [55, 'P7'], { sessionId: SID, maxAgeMs: W, mode: 'replace' });
    const { ids } = readInjectedMarker(file, { sessionId: SID, maxAgeMs: W });
    expect(ids, 'a raw number became a string — D#213 would flip from inert to live').toContain(55);
    expect(
      ids.filter((i) => typeof i === 'number'),
      'the raw-number population changed size',
    ).toEqual([55]);
    expect(ids).toContain('P7');
    // And everything carried over is a string, which is what keeps it inert.
    for (const carried of ids.filter((i) => i !== 55 && i !== 'P7')) {
      expect(typeof carried, `carried id ${carried} is not a string`).toBe('string');
    }
  });

  it('a stale or foreign marker carries nothing over, exactly as before', () => {
    writeFileSync(
      file,
      JSON.stringify({ ids: ['901', 'E902'], ts: Date.now() - 60 * 60 * 1000, session: SID }),
    );
    mergeInjectedMarker(file, [55], { sessionId: SID, maxAgeMs: W, mode: 'replace' });
    expect(readInjectedMarker(file, { sessionId: SID, maxAgeMs: W }).ids).toEqual([55]);
  });
});

// Pre-ship defect review of v6.8.2, P1. B-6 stopped `replace` from erasing the file — and
// `replace` was the ONLY thing that ever shrank it. `union` has always accumulated, and
// `ts` is rewritten on every write, so the staleness gate never fires in a session where
// any hook writes within the window. Measured before the cap: 520 ids after 40 rounds,
// linear and unbounded. The consequence is written down at scripts/pre-tool-recall.js:100-105
// — the dedup slack caps at 5, so a large seen-set starves the face it is meant to dedup.
// Pre-ship defect review of v6.8.2, P3. B-5 moved the counter to the spender but left the
// CLOCK shared: readInjectedMarker zeroes upsCount once the single `ts` is stale, and every
// writer refreshes `ts`. So a tool-heavy session still extends the fyi face's budget — by
// keeping it alive rather than by incrementing it. Same coupling, opposite mechanism.
describe('shouldSkipByDedup — the UPS budget runs on its own clock (pre-ship P3)', () => {
  const SID = 'sess-clock';
  const W = 5 * 60 * 1000;

  it('an idle UPS face releases its budget even while another hook keeps writing', () => {
    // 15 UPS emissions, the last one well outside the window, with another hook writing
    // recently enough to keep the shared `ts` fresh.
    writeFileSync(
      file,
      JSON.stringify({
        ids: ['E1'],
        ts: Date.now(), // the OTHER hook wrote just now
        upsCount: MAX_SESSION_INJECTIONS,
        upsTs: Date.now() - 8 * 60 * 1000, // the UPS face last injected 8 minutes ago
        count: 40,
        session: SID,
      }),
    );
    expect(shouldSkipByDedup([9001, 9002], file, SID)).toBe(false);
  });

  it('still caps a UPS face that is actively injecting', () => {
    writeFileSync(
      file,
      JSON.stringify({
        ids: ['E1'],
        ts: Date.now(),
        upsCount: MAX_SESSION_INJECTIONS,
        upsTs: Date.now(),
        count: 40,
        session: SID,
      }),
    );
    expect(shouldSkipByDedup([9001, 9002], file, SID)).toBe(true);
  });

  it('carries upsTs across another hook’s write and stamps it on its own', () => {
    mergeInjectedMarker(file, [1], { sessionId: SID, maxAgeMs: W, mode: 'replace', bumpUpsCount: true });
    const stamped = JSON.parse(readFileSync(file, 'utf8')).upsTs;
    expect(stamped, 'the UPS write left no clock of its own').toBeGreaterThan(0);
    mergeInjectedMarker(file, ['E9'], { sessionId: SID, maxAgeMs: W, mode: 'union' });
    expect(
      JSON.parse(readFileSync(file, 'utf8')).upsTs,
      "another hook's write moved the UPS face's clock",
    ).toBe(stamped);
  });
});

describe('mergeInjectedMarker — the id list is bounded (pre-ship P1)', () => {
  const SID = 'sess-bound';
  const W = 5 * 60 * 1000;

  it('stays bounded across a long session of interleaved writes', () => {
    for (let round = 0; round < 40; round++) {
      for (let k = 0; k < 5; k++) {
        mergeInjectedMarker(file, [`E${round}_${k}`], { sessionId: SID, maxAgeMs: W, mode: 'union' });
      }
      mergeInjectedMarker(file, [round * 100], {
        sessionId: SID,
        maxAgeMs: W,
        mode: 'replace',
        bumpUpsCount: true,
      });
    }
    const { ids } = readInjectedMarker(file, { sessionId: SID, maxAgeMs: W });
    expect(ids.length, 'the marker grew without bound').toBeLessThanOrEqual(MAX_MARKER_IDS);
  });

  it('keeps the most recent ids and drops the oldest, in both arms', () => {
    for (let i = 0; i < MAX_MARKER_IDS + 10; i++) {
      mergeInjectedMarker(file, [`E${i}`], { sessionId: SID, maxAgeMs: W, mode: 'union' });
    }
    let ids = readInjectedMarker(file, { sessionId: SID, maxAgeMs: W }).ids;
    expect(ids, 'union dropped the newest instead of the oldest').toContain(`E${MAX_MARKER_IDS + 9}`);
    expect(ids, 'union kept an id past the cap').not.toContain('E0');

    mergeInjectedMarker(file, [7, 'P8'], { sessionId: SID, maxAgeMs: W, mode: 'replace' });
    ids = readInjectedMarker(file, { sessionId: SID, maxAgeMs: W }).ids;
    expect(ids.length).toBeLessThanOrEqual(MAX_MARKER_IDS);
    expect(ids.slice(0, 2), "replace dropped the caller's own ids").toEqual([7, 'P8']);
  });
});

describe('injectedIdsFileName — one file per session', () => {
  it('separates two sessions in one project and falls back to a project-keyed name', () => {
    const a = injectedIdsFileName('proj', 'sess-a');
    const b = injectedIdsFileName('proj', 'sess-b');
    expect(a).not.toBe(b); // D#120: not one shared file
    expect(injectedIdsFileName('proj')).toBe('.claude-mem-injected-proj');
    // Sanitized and capped, so a session id with path separators cannot escape the dir.
    expect(injectedIdsFileName('proj', '../../etc/passwd')).not.toContain('/');
  });
});
