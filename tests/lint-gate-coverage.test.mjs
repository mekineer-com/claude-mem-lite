// Regression test: the lint gates must keep covering scripts/.
//
// Historical bug (v3.75.1): a stray `export` keyword in
// scripts/user-prompt-search.js landed before a comment block instead of its
// declaration, silently detaching one constant's export and attaching another's.
// No gate in the repo could see it, and the reason was structural rather than
// accidental:
//
//   - eslint listed `scripts/**` in its `ignores`, so 4470 lines across 17 files
//     were never linted at all — five of them (post-tool-use, pre-agent-inject,
//     pre-tool-recall, pre-skill-bridge, user-prompt-search) fire on every hook
//     event in production.
//   - knip DOES scan the directory, but knip.json lists `scripts/*.{mjs,js}` as
//     ENTRY points, and an entry point's exports are exempt from the
//     unused-export report by definition. So the v3.75.0 "byte-identical export
//     name set" measurement was true and still could not see this file.
//
// Un-ignoring the directory turned up five real errors immediately, one of them
// a lone-surrogate corruption reaching SQLite (index-managed.mjs). This file
// pins the gate open. It asserts BINDING behaviour via eslint's own resolver,
// not a substring match on the config, so a config-format change cannot make it
// pass vacuously.
//
// The second half guards the sibling gate with the same failure mode: ci.yml
// enumerates the shellcheck targets by hand ("adding a shipped .sh means adding
// it HERE"), and pre-agent-inject.sh already spent a whole release outside that
// list. A hand-maintained list with no test is the defect, not the enumeration.

import { test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { ESLint } from 'eslint';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SCRIPTS_DIR = join(ROOT, 'scripts');

function scriptsMatching(re) {
  return readdirSync(SCRIPTS_DIR).filter(f => re.test(f)).sort();
}

test('eslint lints every JS file under scripts/ — the directory is not ignored', async () => {
  const jsFiles = scriptsMatching(/\.(mjs|js)$/);
  // Guard the guard: if the directory is ever emptied or renamed, an empty loop
  // would pass silently.
  expect(jsFiles.length).toBeGreaterThan(10);

  const eslint = new ESLint({ cwd: ROOT });
  const ignored = [];
  for (const f of jsFiles) {
    if (await eslint.isPathIgnored(join(SCRIPTS_DIR, f))) ignored.push(f);
  }
  expect(ignored).toEqual([]);
});

test('every shipped shell script under scripts/ is in the ci.yml shellcheck command', () => {
  const shFiles = scriptsMatching(/\.sh$/);
  expect(shFiles.length).toBeGreaterThan(0);

  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const runLine = ci.split('\n').find(l => l.includes('run: shellcheck'));
  expect(runLine, 'ci.yml has no `run: shellcheck` line').toBeTruthy();

  const missing = shFiles.filter(f => !runLine.includes(`scripts/${f}`));
  expect(missing).toEqual([]);
});
