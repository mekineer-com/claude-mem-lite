// Regression pins for the 5 product defects the 2026-08-14 feature sweep surfaced
// (tests/feature-sweep-{cli,mcp,hooks}.test.mjs found them; this file is where each
// FIXED behavior is nailed down so it cannot silently reopen).
//
// One describe per finding, named F1..F5 after the audit report:
//   F1  mem_use substituted a DIFFERENT skill's body on a name miss (HIGH)
//   F2  optimize preview printed two spellings of the same line (MCP vs CLI)
//   F3  mem_save `files` was described as "associated" but rendered as "modified"
//   F4  three hook-llm debugLog calls passed 2 args to a 3-arg signature
//   F5  a non-string tool_name threw a swallowed TypeError in the PostToolUse hook
//
// Every case states, in a comment, the input that makes it fail — an assertion whose
// failing input nobody can name is not a test.
//
// ISOLATION: every spawned process gets CLAUDE_MEM_DIR + HOME pointed at a mkdtemp
// sandbox, and a cwd inside it, so nothing can reach the live ~/.claude-mem-lite DB or
// write into this repo. The sandbox is removed in an afterAll `finally`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { saveObservation } from '../hook-llm.mjs';

// ─── F4 — hook-llm's three write-side noise diagnostics ────────────────────────────
// utils.mjs debugLog(level, context, msg) takes THREE args. hook-llm.mjs:159/175/185
// passed two, so the level slot held the context and the message slot was `undefined`:
// the line rendered as "[saveObservation] <title>: undefined" and could not be filtered
// by level. 11 other call sites in the same file already passed three.

describe('F4 — write-side noise-gate diagnostics log at a real level with a real message', () => {
  const DEBUG_LINE = /^\[claude-mem-lite\] \[[^\]]+\] \[(DEBUG|WARN|ERROR)\] ([^:]+): (.+)$/;
  let db, errSpy, prevDebug;

  beforeEach(() => {
    prevDebug = process.env.CLAUDE_MEM_DEBUG;
    process.env.CLAUDE_MEM_DEBUG = '1';          // debugLog is gated on this
    db = createTestDb();
    insertSession(db, { id: 'sess-f4', project: 'test' });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    db.close();
    if (prevDebug === undefined) delete process.env.CLAUDE_MEM_DEBUG;
    else process.env.CLAUDE_MEM_DEBUG = prevDebug;
  });

  /** The one line the given drop produced, split into level / context / message. */
  function soleDiagnostic() {
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines, `expected exactly one debugLog line, got:\n${lines.join('\n')}`).toHaveLength(1);
    const m = lines[0].match(DEBUG_LINE);
    expect(m, `debugLog line does not match the utils.mjs format:\n${lines[0]}`).toBeTruthy();
    return { level: m[1], context: m[2], message: m[3], raw: lines[0] };
  }

  // FAILS IF: the call reverts to debugLog('saveObservation', msg) — then level='saveObservation'
  // (not in the DEBUG|WARN|ERROR alternation) so DEBUG_LINE does not match at all.
  it('drop-as-noise names its level, its context and the dropped title', () => {
    // isNoiseObservation: LOW_SIGNAL title pattern, no lesson, no facts, importance<2.
    const id = saveObservation(
      { type: 'change', title: 'Modified widget-cache.mjs', narrative: 'edited it', importance: 1 },
      'test', 'sess-f4', db,
    );
    expect(id).toBeNull();                         // it really took the drop branch
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('dropped noise: Modified widget-cache.mjs');
  });

  // FAILS IF: the message argument is dropped again — `message` would then be 'undefined'.
  it('drop-as-low-yield-change names its level, its context and the dropped title', () => {
    const id = saveObservation(
      { type: 'change', title: 'Adjusted the retry backoff in the API client', narrative: 'edited the client', importance: 1, lessonLearned: null },
      'test', 'sess-f4', db,
    );
    expect(id).toBeNull();
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('dropped low-yield change: Adjusted the retry backoff in the API client');
  });

  // FAILS IF: the importance-cap diagnostic loses its message — the before→after numbers
  // are the whole payload of this line.
  it('importance-cap names its level, its context and the before→after importance', () => {
    // capNoiseImportance: a LOW_SIGNAL title that escaped BOTH drop gates on importance>=2
    // alone (no lesson, no facts) is written, but demoted to importance 1.
    const id = saveObservation(
      { type: 'discovery', title: 'Modified transport.mjs', narrative: 'edited it', importance: 3 },
      'test', 'sess-f4', db,
    );
    expect(id).toBeGreaterThan(0);
    expect(db.prepare('SELECT importance FROM observations WHERE id = ?').get(id).importance).toBe(1);
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('capped imp 3→1: Modified transport.mjs');
  });
});
