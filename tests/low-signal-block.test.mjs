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
