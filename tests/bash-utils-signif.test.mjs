// bash-utils-signif.test.mjs — detectBashSignificance regression fixtures.
//
// History: bun/jest/vitest green test summaries contain "0 fail" / "0 failed"
// / "0 failures", and the prior regex `fail(ed|ure)?` matched the bare "fail"
// token in "0 fail", driving episode.isError=true and polluting memory with
// "Error: <file>.ts: bun test ... N pass 0 fail" titles for passing runs
// (5 such observations were found in a live cluster-merge audit). The
// green-test-summary exemption requires an `\b0\s+(fail|failed|failures)\b`
// marker AND no hard-error signal to flip isError back to false.

import { describe, it, expect } from 'vitest';
import { detectBashSignificance } from '../bash-utils.mjs';

describe('detectBashSignificance — green test summary exemption', () => {
  it('does NOT mark "0 fail" bun-test output as error', () => {
    const sig = detectBashSignificance(
      { command: 'bun test logger.test.ts' },
      'bun test v1.3.5\n logger.test.ts:\n  ✓ logs info\n  ✓ logs warn\n 5 pass\n 0 fail\n ran 5 tests across 1 file'
    );
    expect(sig.isError).toBe(false);
    expect(sig.isTest).toBe(true);
  });

  it('does NOT mark "0 failed" jest-style output as error', () => {
    const sig = detectBashSignificance(
      { command: 'npm test' },
      'Tests:       0 failed, 12 passed, 12 total\nSuites:      0 failed, 3 passed, 3 total\nTime:        2.5s'
    );
    expect(sig.isError).toBe(false);
  });

  it('does NOT mark "0 failures" pytest-style output as error', () => {
    const sig = detectBashSignificance(
      { command: 'pytest tests/' },
      'collected 12 items\n\n12 passed in 0.34s\nresult: 0 failures, 0 errors'
    );
    expect(sig.isError).toBe(false);
  });

  it('DOES mark "5 fail" bun-test output as error (red run)', () => {
    const sig = detectBashSignificance(
      { command: 'bun test logger.test.ts' },
      'bun test v1.3.5\n logger.test.ts:\n  ✓ logs info\n  ✗ logs warn\n 3 pass\n 5 fail\n ran 8 tests'
    );
    expect(sig.isError).toBe(true);
  });

  it('DOES mark "0 fail" plus hard error signal as error (test crashed)', () => {
    const sig = detectBashSignificance(
      { command: 'bun test logger.test.ts' },
      'TypeError: cannot read property of undefined\n  at logger.ts:42\n 0 pass\n 0 fail\n ran 0 tests (process crashed)'
    );
    expect(sig.isError).toBe(true);
  });

  it('DOES mark "AssertionError" as error even when output mentions 0 fail elsewhere', () => {
    const sig = detectBashSignificance(
      { command: 'npm test' },
      'AssertionError: expected 5 got 3\n  at logger.test.ts:12\nsuites: 0 failed (crashed before run)'
    );
    expect(sig.isError).toBe(true);
  });

  it('DOES mark traditional "failed" prose as error', () => {
    const sig = detectBashSignificance(
      { command: 'npm install' },
      'npm ERR! code ENOENT\nnpm ERR! Install failed: package not found'
    );
    expect(sig.isError).toBe(true);
  });

  it('does NOT mark grep output containing "error" as error', () => {
    const sig = detectBashSignificance(
      { command: 'grep -r error src/' },
      'src/foo.ts:42: throw new Error("oh no")\nsrc/bar.ts:10: // error handler'
    );
    expect(sig.isError).toBe(false);
  });
});
