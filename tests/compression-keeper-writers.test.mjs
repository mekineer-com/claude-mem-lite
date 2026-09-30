// Every statement that sets `compressed_into` to a sentinel carries NOT_COMPRESSION_KEEPER_SQL.
//
// Hiding (COMPRESSED_AUTO) or queueing (COMPRESSED_PENDING_PURGE) a compression group's KEEPER
// hides every member compressed into it. 2eb44d1 put the clause on the five maintenance writers
// and its docblock (utils.mjs) said "every writer" — the v6.21.0 pre-tag claims review found a
// sixth, re-enrich's importance-0 hide in hook-optimize.mjs, that `optimize` reaches by default.
// This sweep makes the docblock's sentence executable. POPULATION: every shipped .mjs/.js
// (walkShipped); a writer in a bash script would be outside it, and none exists.
import { describe, it, expect } from 'vitest';
import { walkShipped, relShipped, sourceWithoutComments } from './shipped-tree.mjs';

/** Each sentinel UPDATE, from `SET compressed_into = ${…}` to the end of its SQL literal. */
function sentinelWrites() {
  const out = [];
  for (const file of walkShipped()) {
    const src = sourceWithoutComments(file);
    const re = /SET\s+compressed_into\s*=\s*\$\{(COMPRESSED_AUTO|COMPRESSED_PENDING_PURGE)\}/g;
    for (let m; (m = re.exec(src));) {
      const end = src.indexOf('`', m.index);
      out.push({ file: relShipped(file), sql: src.slice(m.index, end === -1 ? undefined : end) });
    }
  }
  return out;
}

describe('sentinel writers never hide a compression keeper', () => {
  it('finds the writers it is about', () => {
    const files = new Set(sentinelWrites().map((w) => w.file));
    expect(files).toContain('lib/maintain-core.mjs');
    expect(files).toContain('search-scoring.mjs');
    expect(files).toContain('hook-optimize.mjs');
    expect(sentinelWrites().length).toBeGreaterThanOrEqual(7);
  });

  it('every one carries NOT_COMPRESSION_KEEPER_SQL', () => {
    const missing = sentinelWrites().filter((w) => !w.sql.includes('NOT_COMPRESSION_KEEPER_SQL'));
    expect(missing, missing.map((w) => `${w.file}: ${w.sql.slice(0, 90)}`).join('\n')).toEqual([]);
  });
});
