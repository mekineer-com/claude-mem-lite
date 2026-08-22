// task_imperative as a METERED face (v3.76).
//
// The imperative line — `Memory — a past lesson applies to THIS task. You must: … (#NN)`
// — has been a live injection since v3.23 and was never counted. It rides the SAME
// attachment as the `<memory-context>` block (both are stdout writes from one
// `hook.mjs user-prompt` invocation), which is why it could hide: the `ups` matcher
// gates on `<memory-context` and collects only `- [` rows, so the imperative row was
// walked past on every Stop. With no row in citation_surface_log, D#137-shaped questions
// ("is the imperative framing earning its budget?") could only be answered by offline
// replay, and D#150/D#151 are blocked on the same missing denominator.
//
// The two faces overlap by construction — one attachment, two rows — which is the
// documented per-face VIEW semantics, not a partition. What must NOT happen is
// cross-contamination: neither face may collect the other's ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import {
  extractInjectedBySurface,
  extractAllInjected,
  recordCitationSurfaces,
  computeSurfaceFunnel,
  CITATION_SURFACES,
  DECAY_DENOMINATOR_SURFACES,
} from '../lib/citation-tracker.mjs';
import { formatTaskImperative } from '../lib/task-imperative.mjs';

// The real emitter's shape: handleUserPrompt writes the block and then the imperative
// line to the same stdout, so ONE attachment carries both. Built through the real
// formatter so a change to the framing breaks this test instead of silently unmetering
// the face — the drift that let this surface go uncounted for a whole major line.
const bothInOne = (blockId, imperativeId, lesson = 'stamp the guard on both dedup channels') => ({
  type: 'attachment',
  attachment: {
    type: 'hook_success',
    command: 'node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
    stdout:
      `<memory-context relevance="high">\n- [decision] picked X | Lesson: Y (#${blockId})\n</memory-context>\n`
      + `${formatTaskImperative(lesson, imperativeId)}\n`,
  },
});

describe('task_imperative surface', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-imp-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });

  const writeTranscript = (entries) => {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  };

  it('is a member of the recordable enum', () => {
    // recordCitationSurfaces DROPS unknown labels silently, so a matcher without an
    // enum entry extracts ids that never reach a row — unmetered in a way that reads
    // as "this face injects nothing".
    expect(CITATION_SURFACES).toContain('task_imperative');
  });

  it('splits one attachment into both faces without either taking the other id', () => {
    const path = writeTranscript([bothInOne(202, 909)]);
    const s = extractInjectedBySurface(path);
    expect([...s.ups]).toEqual([202]);
    expect([...s.task_imperative]).toEqual([909]);
  });

  it('takes the trailing id, not one quoted inside the lesson body', () => {
    // Lessons routinely cross-reference other observations; the emitter puts THIS
    // lesson's id in trailing parens. Collecting every (#NN) on the line would credit
    // the face with injections it never made.
    const path = writeTranscript([bothInOne(202, 909, 'follow the chain from (#7) rather than re-deriving it')]);
    expect([...extractInjectedBySurface(path).task_imperative]).toEqual([909]);
  });

  it('ignores an imperative-shaped line under a different hook command', () => {
    // Same prose, wrong origin: a transcript can quote the framing (this very test file
    // does). Only the UserPromptSubmit hook's own attachment counts as an injection.
    const path = writeTranscript([{
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        command: 'node "/home/sds/.claude-mem-lite/scripts/user-prompt-search.js"',
        stdout: `${formatTaskImperative('quoted, not injected', 909)}\n`,
      },
    }]);
    expect(extractInjectedBySurface(path).task_imperative.size).toBe(0);
  });

  it('honors mainOnly', () => {
    const path = writeTranscript([{ ...bothInOne(202, 909), isSidechain: true }]);
    expect([...extractInjectedBySurface(path).task_imperative]).toEqual([909]);
    expect(extractInjectedBySurface(path, { mainOnly: true }).task_imperative.size).toBe(0);
  });

  // Metering is the whole change; the decay denominator is deliberately NOT widened in
  // the same step. Widening it would demote the LESSONS this face carried on the basis
  // of a framing whose effectiveness is the open question (D#137) — and it would do so
  // on upgrade, in every live install, before anyone had read a single rate.
  it('is metered WITHOUT entering the decay denominator', () => {
    const path = writeTranscript([bothInOne(202, 909)]);
    expect([...extractInjectedBySurface(path).task_imperative]).toEqual([909]);
    expect([...extractAllInjected(path)]).toEqual([202]);
  });

  // The v45 union was built to widen automatically so a new face could not be forgotten.
  // The exclusion set above is the escape hatch, so it needs its own guard: every matcher
  // face must be either in the denominator or named in the exclusion list. A face that is
  // in neither would have silently dropped out of decay — the original defect, re-opened
  // through the escape hatch instead of through the union.
  it('leaves no face undeclared — each is in the denominator or explicitly excluded', () => {
    const path = writeTranscript([bothInOne(202, 909)]);
    const faces = Object.keys(extractInjectedBySurface(path));
    const declared = new Set([...DECAY_DENOMINATOR_SURFACES, 'task_imperative']);
    expect(faces.filter((f) => !declared.has(f))).toEqual([]);
    // …and the exclusion is not vacuous: the denominator is a strict subset.
    expect(DECAY_DENOMINATOR_SURFACES).not.toContain('task_imperative');
    expect(DECAY_DENOMINATOR_SURFACES.length).toBe(faces.length - 1);
  });

  it('records and reads back as its own row in the funnel', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-imp', project: 'p1' });
    const mk = (title) => Number(insertObs(db, {
      sessionId: 'sess-imp', project: 'p1', type: 'bugfix', title, importance: 2,
    }).lastInsertRowid);
    const imperativeId = mk('imperative pick');
    const blockId = mk('block pick');

    recordCitationSurfaces(db, 'p1', 'cc-sess-1', {
      ups: new Set([blockId]),
      task_imperative: new Set([imperativeId]),
    }, new Set([imperativeId]));

    const faces = Object.fromEntries(
      computeSurfaceFunnel(db, { days: 7, project: 'p1' }).surfaces.map((s) => [s.surface, s]),
    );
    expect(faces.task_imperative).toMatchObject({ injected: 1, cited: 1 });
    expect(faces.ups).toMatchObject({ injected: 1, cited: 0 });
    db.close();
  });
});
