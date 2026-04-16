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
import { SOURCE_FILES } from '../source-files.mjs';
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

function extractLocalImports(sourcePath) {
  const src = readFileSync(sourcePath, 'utf8');
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
