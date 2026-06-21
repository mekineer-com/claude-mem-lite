// tests/lesson-idents.test.mjs
import { describe, it, expect } from 'vitest';
import { extractIdents, presentIdents } from '../lib/lesson-idents.mjs';

describe('extractIdents', () => {
  it('pulls camelCase, snake_case, and backtick tokens (len >= 5)', () => {
    const ids = extractIdents('recover via recoverChildrenOf; null compressed_into; keep `purgeStale`');
    expect(ids).toContain('recoverChildrenOf');
    expect(ids).toContain('compressed_into');
    expect(ids).toContain('purgeStale');
  });
  it('ignores plain prose words and short tokens', () => {
    expect(extractIdents('recover the rows first and delete them')).toEqual([]);
  });
  it('dedupes repeats', () => {
    expect(extractIdents('recoverChildrenOf and recoverChildrenOf again')).toEqual(['recoverChildrenOf']);
  });
  it('empty / null → []', () => {
    expect(extractIdents('')).toEqual([]);
    expect(extractIdents(null)).toEqual([]);
  });
});

describe('presentIdents', () => {
  it('keeps only identifiers literally present in the content', () => {
    const lesson = 'call recoverChildrenOf; touches compressed_into';
    const content = 'function recoverChildrenOf() {} // no compressed col here';
    expect(presentIdents(lesson, content)).toEqual(['recoverChildrenOf']);
  });
  it('identifier absent from content → excluded (no "didn\'t add" false positive)', () => {
    expect(presentIdents('add recoverChildrenOf', 'function foo() {}')).toEqual([]);
  });
  it('empty content → []', () => {
    expect(presentIdents('recoverChildrenOf', '')).toEqual([]);
  });
});
