// scripts/setup.sh must write its `.deps-broken` flag where hook.mjs READS it.
//
// The flag is the only surface that tells a user their hooks are degraded — hook.mjs's
// SessionStart dashboard reads `join(RUNTIME_DIR, '.deps-broken')`, and RUNTIME_DIR comes
// from `hook-shared.mjs`, i.e. `resolveRuntimeDir(resolveDataDir(CLAUDE_MEM_DIR))`. setup.sh
// hardcoded `$HOME/.claude-mem-lite` instead, so with CLAUDE_MEM_DIR set the writer and the
// reader named two different directories and the banner never rendered. Measured 2026-09-14
// before the fix, two arms: flag planted where setup.sh writes → banner rendered 0 times;
// planted where hook.mjs reads → 1 time.
//
// This is the failure shape `lib/resolve-data-dir.mjs` already documents at length ("it did
// not relocate the runtime dir — it SPLIT it"), and the sweep that guards against it,
// `tests/runtime-dir-single-home.test.mjs`, is built on `walkShipped` — "every shipped
// .mjs/.js module". A bash hook is structurally outside that population, which is why this
// survived. The assertion below is behavioural for the same reason: a text scan of setup.sh
// would be one more ruler with a file-type blind spot.
//
// Observation trick: forcing a real dependency failure is not hermetic, but `mark_deps_ok`
// (the healthy branch) REMOVES the flag — so planting one in each candidate directory and
// seeing which one setup.sh deletes observes the live code path exactly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { resolveDataDir, resolveRuntimeDir } from '../lib/resolve-data-dir.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETUP_SH = join(REPO_ROOT, 'scripts', 'setup.sh');
const FLAG_BODY = JSON.stringify({
  ts: '2026-09-14T00:00:00Z',
  reason: 'planted by setup-sh-deps-flag-relocation.test.mjs',
  root: '/nowhere',
  repair: 'npm install --omit=dev',
});

let sandbox;

/**
 * A ROOT whose dependency state reads as HEALTHY without any probe or npm call:
 * `node_modules/better-sqlite3/` present makes setup.sh skip the install block, and the
 * ABI-keyed marker makes it take the `mark_deps_ok` fast path instead of spawning
 * binding-probe-cli.mjs. Hermetic — it must never depend on this repo's own node_modules,
 * which on a fresh `npm ci` carries no marker and would send the test into `npm rebuild`.
 *
 * It also carries `lib/resolve-data-dir.mjs`, because every shipped shape does: under a
 * plugin install $ROOT IS the directory holding scripts/setup.sh, and under npx / npm /
 * git-clone $ROOT is derived from the script's own location. A fixture without it is not a
 * smaller install, it is a shape that does not ship — and it silently sends setup.sh down
 * the truncated-tree fallback, which is how the first draft of this test stayed red against
 * a correct fix.
 */
function makeHealthyRoot() {
  const root = join(sandbox, 'plugin-root');
  mkdirSync(join(root, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(root, 'node_modules', `.mem-binding-ok-${process.versions.modules}`), '');
  mkdirSync(join(root, 'lib'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'lib', 'resolve-data-dir.mjs'), join(root, 'lib', 'resolve-data-dir.mjs'));
  return root;
}

function plantFlag(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, '.deps-broken'), `${FLAG_BODY}\n`);
  return join(runtimeDir, '.deps-broken');
}

function runSetup({ home, dataDir }) {
  const r = spawnSync('bash', [SETUP_SH], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_ROOT: makeHealthyRoot(),
      CLAUDE_MEM_DIR: dataDir ?? '',
      CLAUDE_MEM_RUNTIME_DIR: '',
      MEM_NO_AUTO_ADOPT: '1',
    },
  });
  return r;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mem-setup-reloc-'));
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('setup.sh .deps-broken flag location', () => {
  it('control: HOME is sandboxed, so nothing here can reach the real home', () => {
    // Premise for every arm below. The plugin-cache prune inside setup.sh is rooted at
    // $HOME/.claude/plugins/cache and DELETES directories; an unsandboxed HOME would make
    // this suite destructive rather than merely wrong.
    expect(resolve(sandbox).startsWith(resolve(tmpdir()))).toBe(true);
    // ...and the fixture must be a shape that ships, or the arms below measure the
    // truncated-tree fallback instead of the resolver.
    expect(existsSync(join(makeHealthyRoot(), 'lib', 'resolve-data-dir.mjs'))).toBe(true);
  });

  it('control: on a healthy install setup.sh clears the flag it can see (default dir)', () => {
    // If this arm ever goes red, a red arm below means "the harness never reached
    // mark_deps_ok", NOT "the flag went to the wrong directory". The two have opposite fixes.
    const home = join(sandbox, 'home');
    mkdirSync(home, { recursive: true });
    const flag = plantFlag(join(home, '.claude-mem-lite', 'runtime'));

    const r = runSetup({ home, dataDir: undefined });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(flag)).toBe(false);
  });

  it('clears the flag in the RELOCATED runtime dir when CLAUDE_MEM_DIR is set', () => {
    const home = join(sandbox, 'home');
    const relocated = join(sandbox, 'relocated-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(relocated, { recursive: true });

    // The target is derived from the shared resolver, not spelled out here — the guard has
    // to move with the resolver rather than pin a second copy of its rule.
    const readerRuntimeDir = resolveRuntimeDir(resolveDataDir(relocated), {});
    expect(readerRuntimeDir).toBe(join(relocated, 'runtime'));

    const relocatedFlag = plantFlag(readerRuntimeDir);
    const homeFlag = plantFlag(join(home, '.claude-mem-lite', 'runtime'));

    const r = runSetup({ home, dataDir: relocated });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    // The one the reader looks at must be the one setup.sh manages.
    expect(existsSync(relocatedFlag)).toBe(false);
    // And the homedir copy is not the flag any more — left untouched rather than
    // double-written, so a stale one cannot masquerade as current.
    expect(existsSync(homeFlag)).toBe(true);
  });

  // The two fallback arms of the same gate. Both matter more than they look: setup.sh runs
  // under `set -euo pipefail` as a SessionStart hook, so an arm that aborts does not merely
  // pick the wrong directory — it fails the user's session start.
  it('falls back to the default dir, exit 0, when CLAUDE_MEM_DIR is invalid', () => {
    const home = join(sandbox, 'home');
    mkdirSync(home, { recursive: true });
    const flag = plantFlag(join(home, '.claude-mem-lite', 'runtime'));

    // resolveDataDir THROWS on a relative value rather than resolving it against cwd.
    const r = runSetup({ home, dataDir: 'not/absolute' });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(flag)).toBe(false);
  });

  it('falls back to the default dir, exit 0, when the resolver is absent (truncated tree)', () => {
    const home = join(sandbox, 'home');
    const relocated = join(sandbox, 'relocated-data');
    mkdirSync(home, { recursive: true });
    mkdirSync(relocated, { recursive: true });
    const flag = plantFlag(join(home, '.claude-mem-lite', 'runtime'));

    const root = makeHealthyRoot();
    rmSync(join(root, 'lib', 'resolve-data-dir.mjs'));

    const r = spawnSync('bash', [SETUP_SH], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_MEM_DIR: relocated,
        CLAUDE_MEM_RUNTIME_DIR: '',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(flag)).toBe(false);
  });

  it('honours CLAUDE_MEM_RUNTIME_DIR the same way hook-shared.mjs does', () => {
    const home = join(sandbox, 'home');
    const runtimeOverride = join(sandbox, 'runtime-override');
    mkdirSync(home, { recursive: true });

    const flag = plantFlag(runtimeOverride);

    const r = spawnSync('bash', [SETUP_SH], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: makeHealthyRoot(),
        CLAUDE_MEM_DIR: '',
        CLAUDE_MEM_RUNTIME_DIR: runtimeOverride,
        MEM_NO_AUTO_ADOPT: '1',
      },
    });

    expect(r.status, `setup.sh stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(flag)).toBe(false);
  });
});
