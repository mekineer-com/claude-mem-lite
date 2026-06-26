// tests/rrf.test.mjs — regression lock for the shared RRF core (D#42, lib/rrf.mjs).
// The refactor extracted rrfAccumulate as the single source the two adapters delegate
// to (tfidf.rrfMerge → minimal {id,rrfScore}; deep-search.rrfFuseN → full row,
// score=-rrfScore). Byte-identity with the old hand-written loops was verified by an
// adversarial diff harness; these tests lock the load-bearing EDGE behaviors (id=0,
// null/undefined-id skip, first-list-first ties, best-rank row) the prior suite left
// uncovered, so a future edit to rrfAccumulate can't silently break the adapters.
import { describe, it, expect } from 'vitest';
import { rrfAccumulate } from '../lib/rrf.mjs';
import { rrfMerge } from '../tfidf.mjs';
import { rrfFuseN } from '../deep-search.mjs';

describe('rrfAccumulate (shared RRF core)', () => {
  it('sums 1/(k+rank+1) across lists, sorts desc, first-list-first ties', () => {
    const out = rrfAccumulate([[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]], 60);
    // id:1 ranks {0,1}, id:2 ranks {1,0} → equal score → tie broken by insertion (list0 first)
    expect(out.map(r => r.id)).toEqual([1, 2]);
    expect(out[0].score).toBeCloseTo(1 / 61 + 1 / 62, 10);
  });

  it('treats id===0 as a valid key (not falsy-dropped)', () => {
    const out = rrfAccumulate([[{ id: 0 }, { id: 5 }]], 60);
    expect(out.map(r => r.id)).toEqual([0, 5]);
  });

  it('skips rows with null/undefined id', () => {
    const out = rrfAccumulate([[{ id: 1 }, { id: undefined }, { id: null }, { id: 2 }]], 60);
    expect(out.map(r => r.id)).toEqual([1, 2]);
  });

  it('keeps the best-ranked (lowest-index) row for an id across lists', () => {
    const a = [{ id: 9 }, { id: 1, tag: 'A-rank1' }];
    const b = [{ id: 1, tag: 'B-rank0' }, { id: 9 }];
    expect(rrfAccumulate([a, b], 60).find(r => r.id === 1).row.tag).toBe('B-rank0');
  });

  it('ignores non-array entries', () => {
    expect(rrfAccumulate([null, [{ id: 1 }], undefined], 60).map(r => r.id)).toEqual([1]);
  });
});

describe('RRF adapters preserve their output shapes', () => {
  it('rrfMerge emits minimal { id, rrfScore }, first-list-first ties', () => {
    const out = rrfMerge([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }], 60);
    expect(out.map(r => r.id)).toEqual([1, 2]);
    expect(Object.keys(out[0]).sort()).toEqual(['id', 'rrfScore']);
  });

  it('rrfFuseN emits full row with score=-rrfScore + rrfScore', () => {
    const out = rrfFuseN([[{ id: 1, title: 't' }]], 60);
    expect(out[0].id).toBe(1);
    expect(out[0].title).toBe('t');
    expect(out[0].score).toBeCloseTo(-out[0].rrfScore, 12);
  });
});
