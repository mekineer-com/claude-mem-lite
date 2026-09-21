// Every file in `lib/` is shipped product code, and shipped product code is registered twice.
//
// CLAUDE.md: "Register every new `lib/` module in BOTH `source-files.mjs` and
// `package.json#files` — a missed registration has shipped a broken tarball three times."
// That rule had no machine gate, and it could not have one, because `lib/` held two files
// that deliberately belonged to neither list: `efficacy-arms.mjs` and
// `efficacy-bridge-select.mjs` served `benchmark/efficacy-harness.mjs` and their own tests.
// A rule with a standing exception is a rule a reviewer has to remember, and the directory
// gave no signal about which kind of file they were looking at. Both now live in
// `benchmark/`, beside their only consumer, and this asserts the rule outright.
//
// NOT a duplicate of tests/npm-tarball-completeness.test.mjs. That one walks the dependency
// graph FROM the user-facing entry points and asks whether everything reachable is shipped —
// reachability, which by construction cannot see a `lib/` file no entry point imports. This
// one starts from the DIRECTORY. The two populations are different and so are the defects
// they catch: the graph walk catches "imported but not shipped", this catches "sitting in the
// shipped directory and registered nowhere".

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// D#207: join(), never new URL('../x.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const libModules = readdirSync(join(REPO, 'lib'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => `lib/${f}`)
  .sort();

const pkgFiles = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).files;
const sourceFilesSrc = readFileSync(join(REPO, 'source-files.mjs'), 'utf8');

describe('every lib/ module is registered in both manifests', () => {
  it('has a non-trivial population to check', () => {
    // Premise: an empty directory listing satisfies every assertion below. This is the case
    // that fails when the walk breaks rather than when the tree does.
    expect(libModules.length).toBeGreaterThan(50);
    expect(pkgFiles.length).toBeGreaterThan(50);
  });

  it('is listed in package.json#files', () => {
    const missing = libModules.filter((m) => !pkgFiles.includes(m));
    expect(
      missing,
      'these lib/ modules are not in package.json#files, so the published tarball will not ' +
        'contain them and the first import of one is ERR_MODULE_NOT_FOUND on a user machine:\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('is listed in source-files.mjs', () => {
    const missing = libModules.filter((m) => !sourceFilesSrc.includes(`'${m}'`));
    expect(
      missing,
      'these lib/ modules are not in source-files.mjs, so a direct/manual install copies a ' +
        'tree that is missing them:\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('neither manifest names a lib/ file that is gone', () => {
    // The other direction. A stale entry survives a delete silently, and the next reader
    // takes the manifest for the tree.
    const onDisk = new Set(libModules);
    const stalePkg = pkgFiles.filter((f) => f.startsWith('lib/') && !onDisk.has(f));
    const staleSrc = [...sourceFilesSrc.matchAll(/'(lib\/[\w.-]+\.mjs)'/g)]
      .map((m) => m[1])
      .filter((f) => !onDisk.has(f));
    expect(stalePkg, `package.json#files names missing lib files: ${stalePkg.join(', ')}`).toEqual([]);
    expect(staleSrc, `source-files.mjs names missing lib files: ${staleSrc.join(', ')}`).toEqual([]);
  });
});
