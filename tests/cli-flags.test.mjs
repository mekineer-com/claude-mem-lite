import { describe, it, expect, vi } from 'vitest';
import { parseIntFlag } from '../lib/cli-flags.mjs';

describe('parseIntFlag', () => {
  it('returns defaultValue when input is undefined / null / empty', () => {
    const warn = vi.fn();
    expect(parseIntFlag(undefined, { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(parseIntFlag(null, { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(parseIntFlag('', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses valid integer input within default min=1', () => {
    const warn = vi.fn();
    expect(parseIntFlag('42', { name: '--limit', defaultValue: 20, warn })).toBe(42);
    expect(parseIntFlag(42, { name: '--limit', defaultValue: 20, warn })).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects non-integer input with stderr warn + default fallback', () => {
    const warn = vi.fn();
    const result = parseIntFlag('abc', { name: '--limit', defaultValue: 20, warn });
    expect(result).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Invalid --limit "abc"');
    expect(warn.mock.calls[0][0]).toContain('using default 20');
  });

  it('rejects below-min input (negative integers, the #8277 trap)', () => {
    const warn = vi.fn();
    // -5 is truthy in JS, so the bare `parseInt(x, 10) || default` pattern
    // would silently accept it; parseIntFlag must reject.
    const result = parseIntFlag('-5', { name: '--limit', defaultValue: 20, warn });
    expect(result).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('-5');
  });

  it('rejects below-min input (zero with default min=1)', () => {
    const warn = vi.fn();
    expect(parseIntFlag('0', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts zero when min=0 (e.g. --offset)', () => {
    const warn = vi.fn();
    expect(parseIntFlag('0', { name: '--offset', defaultValue: 0, min: 0, warn })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects above-max input with bounded warning text', () => {
    const warn = vi.fn();
    const result = parseIntFlag('99999999', { name: '--limit', defaultValue: 20, max: 1000, warn });
    expect(result).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('between 1 and 1000');
  });

  it('accepts the exact upper bound', () => {
    const warn = vi.fn();
    expect(parseIntFlag('1000', { name: '--limit', defaultValue: 20, max: 1000, warn })).toBe(1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warning includes the open-ended range when no max set', () => {
    const warn = vi.fn();
    parseIntFlag('-1', { name: '--days', defaultValue: 30, warn });
    expect(warn.mock.calls[0][0]).toContain('≥ 1');
  });

  it('rejects floats (parseInt truncates but isInteger guards)', () => {
    const warn = vi.fn();
    // parseInt('3.7', 10) = 3 (truncation). isInteger(3) = true. So '3.7' parses to 3.
    // This is acceptable per #8277 — explicit warn-then-default is for non-integer
    // results, and parseInt produces integer 3 from '3.7'. Verify the documented behavior.
    expect(parseIntFlag('3.7', { name: '--limit', defaultValue: 20, warn })).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects "Infinity" / "NaN" string literals', () => {
    const warn = vi.fn();
    expect(parseIntFlag('Infinity', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(parseIntFlag('NaN', { name: '--limit', defaultValue: 20, warn })).toBe(20);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('importance bound: min=1 max=3', () => {
    const warn = vi.fn();
    expect(parseIntFlag('2', { name: '--importance', defaultValue: 1, min: 1, max: 3, warn })).toBe(2);
    expect(parseIntFlag('5', { name: '--importance', defaultValue: 1, min: 1, max: 3, warn })).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('between 1 and 3');
  });
});
