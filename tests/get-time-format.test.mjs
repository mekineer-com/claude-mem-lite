// Tests for the time-field renderer used by `mem get`. Pre-2.63.0 the
// renderObsRows path printed `last_accessed_at` and `superseded_at` as raw
// ms epochs (e.g., `last_accessed_at: 1778357330957`), inconsistent with
// `recent` / `timeline` / `recall` which all use `relativeTime()`. Locked
// contract: integer time fields render as `<raw> (<relative>)` so audit
// use-cases keep the raw ms but human readers see staleness at a glance.

import { describe, it, expect } from 'vitest';
import { formatObsFieldValue, OBS_TIME_FIELDS } from '../mem-cli.mjs';

describe('formatObsFieldValue', () => {
  it('formats time fields as `<raw> (<relative>)`', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const out = formatObsFieldValue('last_accessed_at', oneHourAgo);
    expect(out).toMatch(/^\d{13}\s+\(\d+h ago\)$/);
  });

  it('formats `superseded_at` as time-typed too', () => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const out = formatObsFieldValue('superseded_at', oneDayAgo);
    expect(out).toMatch(/^\d{13}\s+\(\d+[hd] ago\)$/);
  });

  it('passes non-time integer fields through unchanged (access_count, importance)', () => {
    expect(formatObsFieldValue('access_count', 5)).toBe(5);
    expect(formatObsFieldValue('importance', 2)).toBe(2);
  });

  it('passes string fields through unchanged', () => {
    expect(formatObsFieldValue('title', 'hello')).toBe('hello');
    expect(formatObsFieldValue('project', 'projects--mem')).toBe('projects--mem');
  });

  it('handles null/undefined gracefully (caller filters these but defense-in-depth)', () => {
    expect(formatObsFieldValue('last_accessed_at', null)).toBeNull();
    expect(formatObsFieldValue('last_accessed_at', undefined)).toBeUndefined();
  });

  it('OBS_TIME_FIELDS contains the two known time fields', () => {
    expect(OBS_TIME_FIELDS).toContain('last_accessed_at');
    expect(OBS_TIME_FIELDS).toContain('superseded_at');
  });
});
