// benchmark-baseline-age.test.mjs — v2.41 stale-baseline warning guard.
// Directly parses the ci-gate source to verify the age-check constants and
// logic shape are present. A full integration test would need to spawn the
// benchmark (slow + flaky on CI); the constants check catches regressions
// without requiring a real run.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI_GATE_PATH = join(__dirname, '..', 'benchmark', 'ci-gate.mjs');
const REPO_ROOT = join(__dirname, '..');

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

// FIX 3a: the absolute-metric check must run the PRODUCTION-HYBRID path
// (searchObservationsHybrid via --production-hybrid), the path users hit — not
// the lexical FTS-only default that left vector drift invisible.
describe('benchmark/ci-gate.mjs — absolute metric check uses production-hybrid (FIX 3a)', () => {
  const source = readFileSync(CI_GATE_PATH, 'utf8');
  const baseline = JSON.parse(readFileSync(join(__dirname, '..', 'benchmark', 'baseline.json'), 'utf8'));

  it('runs benchmark with --production-hybrid for the absolute-metric pass', () => {
    expect(source).toMatch(/execSync\('node benchmark\/benchmark\.mjs --production-hybrid'/);
  });

  it('baseline.json was captured from the production_hybrid path (so baseline == gate)', () => {
    expect(baseline.mode).toBe('production_hybrid');
  });
});

// FIX 3c: a stale baseline must FAIL the gate in strict mode (--strict /
// CI_GATE_STRICT=1) while staying advisory-only by default (backward-compatible).
describe('benchmark/ci-gate.mjs — strict stale-baseline failure (FIX 3c)', () => {
  const source = readFileSync(CI_GATE_PATH, 'utf8');

  it('declares a STRICT flag from --strict or CI_GATE_STRICT', () => {
    expect(source).toMatch(/const STRICT\s*=/);
    expect(source).toMatch(/--strict/);
    expect(source).toMatch(/CI_GATE_STRICT/);
  });

  it('records a staleFailure and folds it into the final non-zero exit', () => {
    expect(source).toMatch(/staleFailure\s*=\s*true/);
    // Final exit must consider staleFailure (so strict stale → exit 1).
    expect(source).toMatch(/totalFailures\s*>\s*0\s*\|\|\s*staleFailure/);
  });

  it('keeps the advisory (non-strict) branch — default runs do NOT fail on stale', () => {
    // The advisory wording must remain for the default path so local iteration
    // is unaffected and the v2.41 contract holds.
    expect(source).toMatch(/advisory, not a failure/i);
  });

  // Behavioral guard: with a FRESH baseline (the repo's regenerated one), strict
  // mode must NOT false-fail — it should pass exactly like the default run. This
  // exercises the real spawn end-to-end without needing a slow stale fixture.
  it('strict mode with a fresh baseline still PASSES (exit 0)', () => {
    let code = 0;
    try {
      execFileSync('node', ['benchmark/ci-gate.mjs', '--strict', '--skip-matrix'], {
        cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe',
      });
    } catch (err) {
      code = err.status ?? 1;
    }
    expect(code).toBe(0);
  }, 30000);
});
