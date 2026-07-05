import { describe, it, expect } from 'vitest';
import { buildIdf, textToBag, cosine, dualChannelBags } from '../benchmark/adoption-cosine.mjs';

describe('adoption-cosine', () => {
  it('cosine(x,x) == 1 and orthogonal == 0', () => {
    const idf = buildIdf(['alpha beta gamma', 'delta epsilon']);
    const a = textToBag('alpha beta gamma');
    const b = textToBag('delta epsilon');
    expect(cosine(a, a, idf)).toBeCloseTo(1, 6);
    expect(cosine(a, b, idf)).toBeCloseTo(0, 6);
  });

  it('IDF down-weights corpus-common terms', () => {
    // "the" appears in every doc → idf near 0; "rrfaccumul" rare → high idf
    const idf = buildIdf(['the merge', 'the delete', 'the rrfAccumulate merge']);
    expect(idf.get('rrfaccumul')).toBeGreaterThan(idf.get('the'));
  });

  it('dualChannelBags separates action tokens from prose tokens', () => {
    const { proseBag, actionBag } = dualChannelBags({
      prose: 'I will now update the merge',
      actions: 'const x = rrfAccumulate(a, b)',
    });
    expect([...actionBag.keys()]).toContain('rrfaccumul');
    expect([...proseBag.keys()]).not.toContain('rrfaccumul');
  });
});
