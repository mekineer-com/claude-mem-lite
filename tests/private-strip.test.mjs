import { describe, it, expect } from 'vitest';
import { stripPrivate } from '../lib/private-strip.mjs';

describe('stripPrivate', () => {
  it('replaces a single well-formed block with [redacted]', () => {
    expect(stripPrivate('foo <private>secret</private> bar')).toBe('foo [redacted] bar');
  });

  it('replaces multiple blocks independently (non-greedy)', () => {
    expect(stripPrivate('a <private>x</private> b <private>y</private> c'))
      .toBe('a [redacted] b [redacted] c');
  });

  it('handles multiline content inside the block', () => {
    expect(stripPrivate('pre\n<private>line1\nline2\nline3</private>\npost'))
      .toBe('pre\n[redacted]\npost');
  });

  it('is case-insensitive on the tag name', () => {
    expect(stripPrivate('<PRIVATE>x</PRIVATE>')).toBe('[redacted]');
    expect(stripPrivate('<Private>x</Private>')).toBe('[redacted]');
    expect(stripPrivate('<private>x</PRIVATE>')).toBe('[redacted]');
  });

  it('replaces empty block', () => {
    expect(stripPrivate('a<private></private>b')).toBe('a[redacted]b');
  });

  it('leaves unclosed open tag intact (user may be mid-typing)', () => {
    expect(stripPrivate('hello <private>not closed yet')).toBe('hello <private>not closed yet');
  });

  it('leaves stray closing tag intact', () => {
    expect(stripPrivate('hello </private> tail')).toBe('hello </private> tail');
  });

  it('leaves text without any tag unchanged (fast path)', () => {
    const plain = 'just a normal user prompt about pagination cursors';
    expect(stripPrivate(plain)).toBe(plain);
  });

  it('non-string input passes through unchanged', () => {
    expect(stripPrivate(undefined)).toBe(undefined);
    expect(stripPrivate(null)).toBe(null);
    expect(stripPrivate(42)).toBe(42);
  });

  it('empty string returns empty string', () => {
    expect(stripPrivate('')).toBe('');
  });

  it('block at the very start of the string', () => {
    expect(stripPrivate('<private>X</private> rest')).toBe('[redacted] rest');
  });

  it('block at the very end of the string', () => {
    expect(stripPrivate('prefix <private>X</private>')).toBe('prefix [redacted]');
  });

  it('two adjacent blocks with no separator', () => {
    expect(stripPrivate('<private>a</private><private>b</private>')).toBe('[redacted][redacted]');
  });

  it('preserves surrounding punctuation around the block', () => {
    expect(stripPrivate('Compare X with <private>token123</private>.'))
      .toBe('Compare X with [redacted].');
  });
});
