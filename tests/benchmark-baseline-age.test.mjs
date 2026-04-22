// benchmark-baseline-age.test.mjs — v2.41 stale-baseline warning guard.
// Directly parses the ci-gate source to verify the age-check constants and
// logic shape are present. A full integration test would need to spawn the
// benchmark (slow + flaky on CI); the constants check catches regressions
// without requiring a real run.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI_GATE_PATH = join(__dirname, '..', 'benchmark', 'ci-gate.mjs');

describe('benchmark/ci-gate.mjs — stale baseline warning', () => {
  const source = readFileSync(CI_GATE_PATH, 'utf8');

  it('declares BASELINE_STALE_AGE_DAYS constant', () => {
    expect(source).toMatch(/BASELINE_STALE_AGE_DAYS\s*=\s*30/);
  });

  it('computes baselineAgeDays from timestamp or mtime', () => {
    expect(source).toMatch(/baselineAgeDays/);
    expect(source).toMatch(/Date\.parse\(baseline\.timestamp\)/);
    expect(source).toMatch(/statSync\(baselinePath\)\.mtimeMs/);
  });

  it('emits STALE BASELINE warning on stderr (advisory, does not fail gate)', () => {
    expect(source).toMatch(/STALE BASELINE/);
    expect(source).toMatch(/node benchmark\/benchmark\.mjs/);
    expect(source).toMatch(/advisory, not a failure/i);
  });

  it('stale-check happens before the benchmark run, so warning is visible even on failure', () => {
    const staleIdx = source.indexOf('STALE BASELINE');
    const benchmarkExecIdx = source.indexOf('execSync(\'node benchmark/benchmark.mjs');
    expect(staleIdx).toBeGreaterThan(0);
    expect(benchmarkExecIdx).toBeGreaterThan(0);
    expect(staleIdx).toBeLessThan(benchmarkExecIdx);
  });
});
