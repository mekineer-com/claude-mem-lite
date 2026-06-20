// Regression lock for the memory-input injection guard (MEMORY_INPUT_GUARD).
//
// These are STATIC SOURCE assertions: we deliberately do NOT import hook-llm.mjs
// because it transitively pulls in better-sqlite3 (a native addon), which can
// hang vitest collection (see the vitest-hang-traps skill). The guard is a
// shipped-prompt security control, so what we must prevent is a future prompt
// edit silently deleting or weakening it — that is exactly what source-level
// assertions catch. They do NOT (and cannot cheaply) prove Haiku's runtime
// behavior; per lesson #8605 prompt wording barely moves Haiku anyway, so the
// value here is defense-in-depth wiring, not a behavioral guarantee.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../hook-llm.mjs', import.meta.url)),
  'utf8',
);

describe('MEMORY_INPUT_GUARD', () => {
  it('is exported and keeps its load-bearing security semantics', () => {
    const m = src.match(/export const MEMORY_INPUT_GUARD\s*=\s*'([^']*)'/);
    expect(m, 'MEMORY_INPUT_GUARD export must exist').toBeTruthy();
    const guard = m[1];
    expect(guard).toMatch(/untrusted/i);
    expect(guard).toMatch(/DATA only/i);
    expect(guard).toMatch(/never obey/i);
  });

  it('is wired into every prompt path that ingests untrusted content', () => {
    // >=2 interpolations: SHARED_OBS_SCHEMA_TAIL (covers single- + multi-entry
    // episode extraction) and the session-summary system prompt. If a prompt
    // edit drops one injection point this count regresses and the test fails.
    const interpolations = src.match(/\$\{MEMORY_INPUT_GUARD\}/g) || [];
    expect(interpolations.length).toBeGreaterThanOrEqual(2);
  });

  it('leads the shared episode schema tail with the guard', () => {
    expect(src).toMatch(/SHARED_OBS_SCHEMA_TAIL\s*=\s*`\$\{MEMORY_INPUT_GUARD\}/);
  });
});
