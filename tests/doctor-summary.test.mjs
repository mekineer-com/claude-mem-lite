// Tests for buildDoctorSummary — locks in the 4-way contract so the
// pre-fix bug ("All checks passed!" while ⚠ warnings rendered) cannot
// regress: warnings count separately from issues, and the summary line
// always reflects both.

import { describe, it, expect } from 'vitest';
import { buildDoctorSummary } from '../install.mjs';

describe('buildDoctorSummary', () => {
  it('returns "All checks passed!" only when both counters are 0', () => {
    expect(buildDoctorSummary(0, 0)).toBe('All checks passed!');
  });

  it('does NOT claim all-passed when warnings are present', () => {
    const out = buildDoctorSummary(0, 2);
    expect(out).not.toContain('All checks passed!');
    expect(out).toContain('All critical checks passed');
    expect(out).toContain('2 warnings');
  });

  it('uses singular "warning" for warnings === 1', () => {
    expect(buildDoctorSummary(0, 1)).toContain('1 warning)');
    expect(buildDoctorSummary(0, 1)).not.toContain('1 warnings');
  });

  it('reports issues without warnings cleanly', () => {
    expect(buildDoctorSummary(3, 0)).toBe('3 issue(s) found.');
  });

  it('appends warning suffix when both issues and warnings present', () => {
    const out = buildDoctorSummary(2, 4);
    expect(out).toContain('2 issue(s) found.');
    expect(out).toContain('+4 warnings');
  });

  it('singular warning suffix when warnings === 1 alongside issues', () => {
    expect(buildDoctorSummary(1, 1)).toContain('+1 warning)');
  });
});
