// v3.75.0 shipped the UserPromptSubmit query cap on ONE of that event's two hooks.
//
// UserPromptSubmit registers two commands: `scripts/user-prompt-search.js` (path A, the
// FYI block) and `hook.mjs user-prompt` (path B, the `<memory-context>` block). P2-13
// capped path A and the release notes said "UserPromptSubmit query building" — but path B
// called `sanitizeFtsQuery(userPrompt)` with no options, on the full prompt, every turn.
//
// Path B is the worse half: path A's stdin is bounded by MAX_UPS_PROMPT_BYTES (64KB),
// path B's by MAX_HOOK_STDIN_BYTES (256KB), and nothing truncates between stdin and the
// query builder. So the cost the change set out to remove was still being paid on the
// sibling hook of the same event, at up to 4x the input size.
//
// This is the project's most-repeated defect shape (a guard wired into one path and
// missing on its sibling), so the fix is a shared module rather than a second copy of
// the constants: lib/ups-query.mjs is the one cap definition both faces import.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { sanitizeFtsQuery } from '../utils.mjs';
import { UPS_QUERY_CAPS, upsFtsQuery } from '../lib/ups-query.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('UserPromptSubmit query caps — both hooks of the event', () => {
  it('caps are one definition, imported by both faces', () => {
    // A second copy of `{ maxChars: 2000, maxTokens: 64 }` would satisfy every behavioural
    // assertion below while re-opening the exact drift this fix closes.
    const pathA = read('../scripts/user-prompt-search.js');
    const pathB = read('../hook-memory.mjs');
    for (const [name, src] of [['user-prompt-search.js', pathA], ['hook-memory.mjs', pathB]]) {
      expect(src, `${name} must import the shared cap`).toMatch(/from '\.\.?\/lib\/ups-query\.mjs'/);
      expect(src, `${name} must not re-declare the caps`).not.toMatch(/maxChars:\s*2000/);
    }
  });

  it('path B no longer builds an uncapped query from the raw prompt', () => {
    // The precise shape that shipped: sanitizeFtsQuery(userPrompt) with no second arg.
    expect(read('../hook-memory.mjs')).not.toMatch(/sanitizeFtsQuery\(\s*userPrompt\s*\)/);
  });

  it('the cap actually changes the query on an oversized prompt', () => {
    // Anti-vacuity for the two source assertions above: if capped and uncapped agreed,
    // they would be pinning a distinction that does not exist.
    // DISTINCT terms, not a repeated phrase: repetition dedups down to a handful of
    // tokens, so neither cap fires and capped === uncapped — the fixture would report
    // "no difference" while the caps work perfectly. (My first version did exactly that.)
    const huge = Array.from({ length: 300 }, (_, i) => `zzterm${i}alpha`).join(' ');
    expect(huge.length).toBeGreaterThan(UPS_QUERY_CAPS.maxChars);
    const capped = upsFtsQuery(huge);
    const uncapped = sanitizeFtsQuery(huge);
    expect(capped).not.toBe(uncapped);
    expect(capped.length).toBeLessThan(uncapped.length);
  });

  it('leaves a normal prompt byte-identical, capped or not', () => {
    // The caps must be invisible in the case that matters most — every ordinary turn.
    const normal = 'why does the dedup guard skip superseded rows';
    expect(upsFtsQuery(normal)).toBe(sanitizeFtsQuery(normal));
  });
});
