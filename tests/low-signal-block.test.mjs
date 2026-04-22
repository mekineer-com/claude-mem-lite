// P0 write-side noise filter — isNoiseObservation()
//
// Contract: low-signal-titled observations are blocked at insert time when they
// carry NO downstream signal (no lesson, importance<2, empty facts, thin narrative).
// Substantive titles pass unchanged. Env CLAUDE_MEM_KEEP_LOW_SIGNAL=1 opts out.

import { describe, it, expect } from 'vitest';
import { isNoiseObservation } from '../lib/low-signal-patterns.mjs';

const EMPTY_ENV = {};

describe('isNoiseObservation — P0 write-side filter', () => {
  it('blocks LOW_SIGNAL title with empty facts, null lesson, thin narrative', () => {
    expect(isNoiseObservation({
      title: 'Modified install.mjs, source-files.mjs',
      facts: [],
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
  });

  it('blocks Error: title with stderr-looking narrative', () => {
    expect(isNoiseObservation({
      title: 'Error: hook.mjs, schema.mjs',
      narrative: 'Error: Cannot find module better-sqlite3',
      facts: [],
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
  });

  it('blocks Worked on X with no signal', () => {
    expect(isNoiseObservation({
      title: 'Worked on schema.mjs',
      facts: [],
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
  });

  it('blocks Codebase exploration without facts', () => {
    expect(isNoiseObservation({
      title: 'Codebase exploration: projects--mem schema',
      facts: [],
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
  });

  it('keeps LOW_SIGNAL title when facts has >=1 non-empty string', () => {
    expect(isNoiseObservation({
      title: 'Modified hook-llm.mjs',
      facts: ['added saveObservation guard for null lesson'],
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(false);
  });

  it('keeps LOW_SIGNAL title when lesson_learned is substantive', () => {
    expect(isNoiseObservation({
      title: 'Error: schema.mjs',
      lessonLearned: 'FTS5 trigger fires on any column UPDATE — wrap access_count in try/catch',
      facts: [],
      importance: 1,
    }, EMPTY_ENV)).toBe(false);
  });

  it('treats lesson_learned="none" as no signal (Haiku fallback)', () => {
    expect(isNoiseObservation({
      title: 'Modified schema.mjs',
      lessonLearned: 'none',
      facts: [],
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
  });

  it('accepts snake_case lesson_learned field', () => {
    expect(isNoiseObservation({
      title: 'Modified schema.mjs',
      lesson_learned: 'Real lesson: observations_au trigger corrupts FTS on partial updates',
      facts: [],
      importance: 1,
    }, EMPTY_ENV)).toBe(false);
  });

  it('keeps LOW_SIGNAL title when importance >= 2', () => {
    expect(isNoiseObservation({
      title: 'Modified schema.mjs',
      facts: [],
      importance: 2,
    }, EMPTY_ENV)).toBe(false);
  });

  it('keeps LOW_SIGNAL title when narrative is substantive (>=40 chars, not stderr)', () => {
    expect(isNoiseObservation({
      title: 'Modified hook-llm.mjs',
      facts: [],
      narrative: 'Wrapped saveObservation vector write in try-catch to prevent FTS corruption from propagating during multi-session flushes.',
      importance: 1,
    }, EMPTY_ENV)).toBe(false);
  });

  it('blocks when narrative is substantive but looks like raw stderr', () => {
    expect(isNoiseObservation({
      title: 'Error: hook.mjs',
      facts: [],
      narrative: 'Error: Cannot find module better-sqlite3 at require (node:internal/modules/cjs/loader.js:123)',
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
  });

  it('keeps substantive title regardless of other fields being empty', () => {
    expect(isNoiseObservation({
      title: 'FTS5 external-content trigger needs orig values on UPDATE',
      facts: [],
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(false);
  });

  it('respects CLAUDE_MEM_KEEP_LOW_SIGNAL=1 opt-out (pre-P0 behavior)', () => {
    expect(isNoiseObservation({
      title: 'Modified install.mjs',
      facts: [],
      narrative: '',
      importance: 1,
    }, { CLAUDE_MEM_KEEP_LOW_SIGNAL: '1' })).toBe(false);
  });

  it('treats empty/missing facts array consistently with no-facts case', () => {
    expect(isNoiseObservation({
      title: 'Modified a.mjs',
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
    expect(isNoiseObservation({
      title: 'Modified a.mjs',
      facts: ['', '  '],
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(true);
  });

  it('empty title is not low-signal (substantive fallthrough)', () => {
    expect(isNoiseObservation({
      title: '',
      facts: [],
      narrative: '',
      importance: 1,
    }, EMPTY_ENV)).toBe(false);
  });
});

describe('isNoiseObservation — P2 tool-output passthrough detection', () => {
  // buildImmediateObservation joins entry descs with "; ", each desc is "cmd → output"
  // from post-tool-use.sh. Such narratives are raw tool output, not curated prose.
  const longStderr = 'git diff 7caa0dc~1..a01ab45 -- schema.mjs tests/schema.test.mjs → diff --git a/schema.mjs b/schema.mjs\nindex abc..def 100644\n@@ -1,5 +1,7 @@';

  it('blocks narrative with " → " passthrough (buildImmediateObservation format)', () => {
    expect(isNoiseObservation({
      title: 'Error: schema.mjs',
      narrative: longStderr,
      facts: [],
      importance: 1,
    }, {})).toBe(true);
  });

  it('blocks narrative with stack trace fragments', () => {
    expect(isNoiseObservation({
      title: 'Error: app.mjs',
      narrative: 'ReferenceError: foo is not defined\n    at bar (/app/src/lib.js:42:10)\n    at baz (/app/src/main.js:7:3)',
      facts: [],
      importance: 1,
    }, {})).toBe(true);
  });

  it('blocks narrative with node:internal/ references', () => {
    expect(isNoiseObservation({
      title: 'Error: index.mjs',
      narrative: 'Uncaught TypeError at something in node:internal/process/task_queues:95:5 — process exited with code 1',
      facts: [],
      importance: 1,
    }, {})).toBe(true);
  });

  it('blocks narrative with test-runner failure banner', () => {
    expect(isNoiseObservation({
      title: 'Error: tests/foo.test.mjs',
      narrative: ' FAIL  tests/foo.test.mjs > suite > it works\nAssertionError: expected 1 to equal 2 at assertEqual\n  +expected -actual',
      facts: [],
      importance: 1,
    }, {})).toBe(true);
  });

  it('blocks narrative with raw diff output', () => {
    expect(isNoiseObservation({
      title: 'Modified schema.mjs',
      narrative: 'diff --git a/schema.mjs b/schema.mjs\n@@ -10,5 +10,7 @@ export function\n-  old line\n+  new line 1\n+  new line 2',
      facts: [],
      importance: 1,
    }, {})).toBe(true);
  });

  it('blocks narrative with multi-"; " join and no sentence prose', () => {
    expect(isNoiseObservation({
      title: 'Modified app.mjs',
      narrative: 'Created app.mjs (1234 chars); Created helper.mjs (432 chars); Modified index.mjs',
      facts: [],
      importance: 1,
    }, {})).toBe(true);
  });

  it('keeps narrative that is curated prose (Haiku-generated)', () => {
    expect(isNoiseObservation({
      title: 'Modified schema.mjs',
      narrative: 'Refactored schema guard so the migration-check hook runs before DB open. Eliminates race with module-level init that created DB_DIR early. No behavior change for users.',
      facts: [],
      importance: 1,
    }, {})).toBe(false);
  });

  it('keeps narrative with single "; " and sentence prose', () => {
    expect(isNoiseObservation({
      title: 'Modified hook.mjs',
      narrative: 'Wrapped vector write in try-catch; ensures FTS trigger corruption does not cascade. Prior code could throw during multi-session flushes.',
      facts: [],
      importance: 1,
    }, {})).toBe(false);
  });
});
