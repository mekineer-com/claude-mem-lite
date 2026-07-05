// Regression test for the shipped-hook import guard in
// scripts/user-prompt-search.js. hook-launcher.mjs's self-heal retry
// (runEntry({ bustCache: true })) re-imports the entry with a cache-buster
// query appended (`?t=<ts>`) so Node's ESM cache doesn't return the earlier
// ERR_MODULE_NOT_FOUND rejection — while process.argv[1] stays query-less.
// The pre-fix guard was a strict `import.meta.url === pathToFileURL(argv1).href`,
// which evaluated FALSE on that retry and silently skipped main(), so the
// healed UserPromptSubmit fire did no memory search.
//
// isDirectInvocation is a pure, side-effect-free predicate exported from the
// script specifically so this can be tested without triggering main() (the
// script still runs main() on direct execution, but importing it here for
// the named export does not — see user-prompt-search.test.mjs's own header
// comment for why importing this module is already safe under vitest).
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import { isDirectInvocation } from '../scripts/user-prompt-search.js';

describe('isDirectInvocation', () => {
  it('returns true for a normal direct launch (metaUrl === pathToFileURL(argv1))', () => {
    const argv1 = '/x/ups.js';
    const metaUrl = pathToFileURL(argv1).href;
    expect(isDirectInvocation(metaUrl, argv1)).toBe(true);
  });

  it('REGRESSION: returns true when metaUrl carries the self-heal cache-buster query that argv1 lacks', () => {
    // Mirrors hook-launcher.mjs's runEntry({ bustCache: true }):
    //   url = pathToFileURL(entryAbs).href + '?t=' + Date.now()
    // while process.argv[1] is reset to the plain entryAbs path (no query).
    const argv1 = '/x/ups.js';
    const metaUrl = `${pathToFileURL(argv1).href}?t=123`;
    expect(isDirectInvocation(metaUrl, argv1)).toBe(true);
  });

  it('returns false when argv1 points at a different file than metaUrl', () => {
    const metaUrl = pathToFileURL('/x/ups.js').href;
    const argv1 = '/x/other.js';
    expect(isDirectInvocation(metaUrl, argv1)).toBe(false);
  });

  it('returns false when argv1 is falsy (module imported, not run directly — e.g. a benchmark/test harness importing searchByFts offline)', () => {
    const metaUrl = pathToFileURL('/x/ups.js').href;
    expect(isDirectInvocation(metaUrl, undefined)).toBe(false);
    expect(isDirectInvocation(metaUrl, '')).toBe(false);
  });
});
