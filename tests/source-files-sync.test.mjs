// Regression test: hook-update.mjs's SOURCE_FILES must stay aligned with
// install.mjs's SOURCE_FILES so auto-update never leaves a ~/.claude-mem-lite/
// install missing a file that runtime entry points statically import.
//
// Historical bug (v2.32.x memory audit): hook-llm.mjs:18 `import './lib/activity.mjs'`
// was added in v2.31 and wired into install.mjs SOURCE_FILES, but hook-update.mjs
// kept its own independent SOURCE_FILES list that was never updated. Npx/npm users
// on v2.30- auto-updating to v2.32+ would download the new hook-llm.mjs without
// lib/activity.mjs → ERR_MODULE_NOT_FOUND on next SessionStart.
//
// Fix: extract SOURCE_FILES to a single shared module, imported by both.
// This test asserts the shared list covers every module reachable from the runtime
// entry points, catching any future file added without being shipped.

import { test, expect } from 'vitest';
import { SOURCE_FILES, HOOK_SCRIPT_FILES } from '../source-files.mjs';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve, relative } from 'path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

// Modules that run from ~/.claude-mem-lite/ — every transitive static/dynamic
// import from any of these must be copied by install.mjs / hook-update.mjs.
const ENTRY_MODULES = [
  'cli.mjs',
  'hook.mjs',
  'server.mjs',
  'mem-cli.mjs',
  'install.mjs',
];

function stripComments(src) {
  // Strip `// ...` line comments and `/* ... */` block comments so the
  // import regex doesn't false-fire on example strings inside docblocks.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function extractLocalImports(sourcePath) {
  const src = stripComments(readFileSync(sourcePath, 'utf8'));
  const out = new Set();
  for (const m of src.matchAll(/(?:from|import)\s+['"](\.\/[^'"]+)['"]/g)) out.add(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*['"](\.\/[^'"]+)['"]/g)) out.add(m[1]);
  return out;
}

function walk(entryRel, seen = new Set()) {
  if (seen.has(entryRel)) return seen;
  seen.add(entryRel);
  const abs = resolve(ROOT, entryRel);
  if (!existsSync(abs)) return seen;
  for (const rel of extractLocalImports(abs)) {
    const resolvedAbs = resolve(dirname(abs), rel);
    const relFromRoot = relative(ROOT, resolvedAbs);
    if (/\.(mjs|js)$/.test(relFromRoot)) walk(relFromRoot, seen);
  }
  return seen;
}

test('SOURCE_FILES covers every .mjs statically or dynamically imported by runtime entry points', () => {
  const shipped = new Set(SOURCE_FILES);
  const missing = [];
  for (const entry of ENTRY_MODULES) {
    for (const mod of walk(entry)) {
      if (mod === entry) continue;
      if (!/\.mjs$/.test(mod)) continue;
      if (!shipped.has(mod)) missing.push(`${mod} (reached from ${entry})`);
    }
  }
  const unique = [...new Set(missing)].sort();
  expect(unique, `\nsource-files.mjs SOURCE_FILES is missing:\n  ${unique.join('\n  ')}\n`).toEqual([]);
});

test('install.mjs and hook-update.mjs both reference the shared SOURCE_FILES module', () => {
  const installSrc = readFileSync(resolve(ROOT, 'install.mjs'), 'utf8');
  const hookUpdateSrc = readFileSync(resolve(ROOT, 'hook-update.mjs'), 'utf8');
  expect(installSrc).toMatch(/from\s+['"]\.\/source-files\.mjs['"]/);
  expect(hookUpdateSrc).toMatch(/from\s+['"]\.\/source-files\.mjs['"]/);
});

// scripts/launch.mjs is the MCP server's actual entry point. Pre-2.53.0 it was
// import-free so it didn't need transitive coverage; v2.53.0 added a relative
// import (./launch-preflight.mjs) and the regression class is now identical to
// issue #15 — just one directory level up. scripts/ is whole-tree copied by
// install.mjs / hook-update.mjs (NOT via SOURCE_FILES), so the invariant we
// assert is different: every relative .mjs reachable from scripts/launch.mjs
// must (a) exist on disk and (b) live under scripts/, so the directory copy
// catches it.
test('scripts/launch.mjs and its transitive .mjs imports stay under scripts/', () => {
  const visited = walk('scripts/launch.mjs');
  const errors = [];
  for (const mod of visited) {
    if (!/\.mjs$/.test(mod)) continue;
    const abs = resolve(ROOT, mod);
    if (!existsSync(abs)) {
      errors.push(`${mod} — referenced from scripts/launch.mjs but missing on disk`);
      continue;
    }
    if (!mod.startsWith('scripts/')) {
      errors.push(`${mod} — scripts/launch.mjs imports outside scripts/, breaks plugin-cache install`);
    }
  }
  expect(errors, `\nscripts/launch.mjs companion-file invariant broken:\n  ${errors.join('\n  ')}\n`).toEqual([]);
});

test('package.json files array ships source-files.mjs and every SOURCE_FILES entry', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const files = new Set(pkg.files);
  expect(files.has('source-files.mjs')).toBe(true);
  // package.json and package-lock.json are implicitly included by npm in every
  // tarball regardless of the files[] array — SOURCE_FILES lists them because
  // install.mjs copies them to INSTALL_DIR so `npm install` can run there.
  const IMPLICITLY_SHIPPED = new Set(['package.json', 'package-lock.json']);
  const missingFromPkg = SOURCE_FILES.filter(f => !files.has(f) && !IMPLICITLY_SHIPPED.has(f));
  expect(missingFromPkg, `\npackage.json files missing SOURCE_FILES entries:\n  ${missingFromPkg.join('\n  ')}\n`).toEqual([]);
});

// Blind-spot closer: the SOURCE_FILES coverage test above only walks the 5 main
// ENTRY_MODULES, so a lib/ module imported ONLY by a standalone hook script (e.g.
// scripts/pre-tool-recall.js) could be left out of SOURCE_FILES + files[] and
// silently dropped from the npm tarball — exactly how lib/file-intel.mjs and
// lib/reread-guard.mjs slipped through before this guard. Hook scripts have a
// mixed import model: lib/root deps ship via SOURCE_FILES; sibling scripts ship
// via the scripts/ directory copy. So every .mjs reachable from a hook script
// must be EITHER in SOURCE_FILES OR under scripts/.
//
// Local walker (not the shared one above): hook scripts sit under scripts/ and
// import parents via `../`, but extractLocalImports only matches `./`. Widening
// the shared regex would also change the ENTRY_MODULES / launch.mjs walks, so we
// keep a `../`-aware extractor scoped to this test.
function hookWalk(entryRel, seen = new Set()) {
  if (seen.has(entryRel)) return seen;
  seen.add(entryRel);
  const abs = resolve(ROOT, entryRel);
  if (!existsSync(abs)) return seen;
  const src = readFileSync(abs, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const specs = new Set();
  for (const m of src.matchAll(/(?:from|import\()\s*['"](\.\.?\/[^'"]+)['"]/g)) specs.add(m[1]);
  for (const rel of specs) {
    const relFromRoot = relative(ROOT, resolve(dirname(abs), rel));
    if (/\.(mjs|js)$/.test(relFromRoot)) hookWalk(relFromRoot, seen);
  }
  return seen;
}

test('hook scripts: every transitive .mjs import is shipped (SOURCE_FILES or under scripts/)', () => {
  const shipped = new Set(SOURCE_FILES);
  const missing = [];
  for (const script of HOOK_SCRIPT_FILES) {
    if (!/\.(mjs|js)$/.test(script)) continue; // skip .sh
    const entry = `scripts/${script}`;
    for (const mod of hookWalk(entry)) {
      if (!/\.mjs$/.test(mod)) continue;
      if (mod.startsWith('scripts/')) continue; // shipped via the scripts/ tree copy
      if (!shipped.has(mod)) missing.push(`${mod} (reached from ${entry})`);
    }
  }
  const unique = [...new Set(missing)].sort();
  expect(unique, `\nhook-script imports missing from SOURCE_FILES:\n  ${unique.join('\n  ')}\n`).toEqual([]);
});
