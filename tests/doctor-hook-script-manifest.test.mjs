// doctor must check the HOOK_SCRIPT_FILES manifest, not only SOURCE_FILES.
//
// `checkDevDrift` classifies whatever the caller hands it, and install.mjs hands it
// SOURCE_FILES — which holds zero `scripts/` entries. Hook scripts install from the
// separate HOOK_SCRIPT_FILES manifest into `~/.claude-mem-lite/scripts/`, and every
// settings.json hook command names one of those ABSOLUTE paths. So the failure
// source-files.mjs documents — a tarball that shipped without `scripts/` — left every
// hook dead while doctor printed an all-clear. That is the fatal-in-every-shape case
// the v3.69.0 severity split was written to grade, and it was the unmonitored one.
//
// Severity here is NOT the SOURCE_FILES severity. #10686's split turns on which path
// RESOLVES the file, and the two manifests answer differently:
//
//   • SOURCE_FILES, dev install — each entry is its own symlink into the repo, so an
//     import-only module absent from the install dir is unreachable dead weight, benign.
//   • HOOK_SCRIPT_FILES, dev install — install.mjs symlinks the whole `scripts/` DIRECTORY
//     (install.mjs:417), so the install dir *is* the repo dir. A file missing there is
//     missing from the repo: broken, not benign. There is no per-file drift to detect.
//   • HOOK_SCRIPT_FILES, copy install — entry scripts are named by hook commands (dead if
//     absent) and `user-prompt-search.js` imports `./prompt-search-utils.mjs` against the
//     install dir (ERR_MODULE_NOT_FOUND on every fire if absent). Both classes are fatal.
//
// So both classes count as issues in both shapes, and the entry/module split survives only
// in the WORDING. Asserted below in both directions so a future edit that copies the
// SOURCE_FILES demote branch over here goes red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { HOOK_SCRIPT_FILES } from '../source-files.mjs';
import { HOOK_SCRIPT_ENTRY_POINTS } from '../lib/doctor-drift.mjs';

const INSTALLER = resolve(import.meta.dirname, '../install.mjs');
const REPO_SCRIPTS = resolve(import.meta.dirname, '../scripts');
const homes = [];

// Same five paths install.mjs classifies as SOURCE_FILES entry points; created so the
// managed-files check is satisfied and only the hook-script check varies between shapes.
const ENTRIES = ['cli.mjs', 'mem-cli.mjs', 'server.mjs', 'hook.mjs', 'install.mjs'];

// Named by a hook command in install.mjs's settings template / hooks/hooks.json.
const ENTRY_SCRIPT = 'user-prompt-search.js';
// Imported BY user-prompt-search.js — never named by a command line.
const HELPER_SCRIPT = 'prompt-search-utils.mjs';

/**
 * Build a fake INSTALL_DIR under a fake HOME, then run `doctor --json`.
 *
 * @param {{scriptsDir?: 'copy'|'symlink'|'absent', omitScripts?: string[]}} opts
 */
function doctorOn({ scriptsDir = 'copy', omitScripts = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-hookscripts-'));
  homes.push(home);
  const installDir = join(home, '.claude-mem-lite');
  mkdirSync(join(installDir, 'lib'), { recursive: true });
  mkdirSync(join(installDir, 'runtime'), { recursive: true });
  for (const rel of ENTRIES) writeFileSync(join(installDir, rel), '// copy\n');

  const scripts = join(installDir, 'scripts');
  if (scriptsDir === 'symlink') {
    // What `install --dev` does: ONE symlink for the whole directory.
    symlinkSync(REPO_SCRIPTS, scripts);
  } else if (scriptsDir === 'copy') {
    mkdirSync(scripts, { recursive: true });
    for (const name of HOOK_SCRIPT_FILES) {
      if (omitScripts.includes(name)) continue;
      mkdirSync(dirname(join(scripts, name)), { recursive: true });
      writeFileSync(join(scripts, name), '// copy\n');
    }
  }
  // 'absent' → the directory is never created: the tarball-without-scripts/ failure.

  // doctor exits non-zero when it finds issues — that is its contract, so read stdout off
  // the thrown error rather than treating the exit code as a harness failure.
  let out;
  try {
    out = execFileSync(process.execPath, [INSTALLER, 'doctor', '--json'], {
      env: {
        ...process.env, HOME: home, CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1', MEM_QUIET_HOOKS: '1',
      },
      encoding: 'utf8',
    });
  } catch (e) {
    out = e.stdout || '';
  }
  const start = out.indexOf('{');
  expect(start, `doctor emitted no JSON:\n${out.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start));
}

// Label-scoped: the fake install dir is deliberately sparse, so unrelated checks also say
// "missing". Only the hook-script check is under test.
const HOOK_LABEL = /^Hook scripts:/;
function hookLines(report) {
  return (report.checks || []).filter((c) => HOOK_LABEL.test(c.message || ''));
}
const msg = (report) => hookLines(report).map((c) => c.message).join(' ');

// Five doctor subprocesses total, computed once — a 2-core runner cannot afford one spawn
// per assertion (lesson: the execFileSync suites that timed out at default budget).
let complete, noDir, noEntry, noHelper, devLinked;

describe('doctor — HOOK_SCRIPT_FILES manifest coverage', () => {
  beforeAll(() => {
    complete = doctorOn({ scriptsDir: 'copy' });
    noDir = doctorOn({ scriptsDir: 'absent' });
    noEntry = doctorOn({ scriptsDir: 'copy', omitScripts: [ENTRY_SCRIPT] });
    noHelper = doctorOn({ scriptsDir: 'copy', omitScripts: [HELPER_SCRIPT] });
    devLinked = doctorOn({ scriptsDir: 'symlink' });
  }, 240_000);

  afterAll(() => {
    for (const h of homes.splice(0)) { try { rmSync(h, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  it('reports a clean hook-script set when every manifest entry is present', () => {
    expect(hookLines(complete).length, `no hook-script line at all:\n${JSON.stringify(complete.checks, null, 1)}`)
      .toBeGreaterThan(0);
    expect(hookLines(complete).every((c) => c.level === 'ok')).toBe(true);
  });

  it('a missing scripts/ directory is an issue, not silence', () => {
    // The documented failure: a tarball published without scripts/. Every hook command
    // names an absolute path under it, so nothing fires — and doctor used to say nothing.
    expect(hookLines(noDir).length, `absent scripts/ said nothing:\n${JSON.stringify(noDir.checks, null, 1)}`)
      .toBeGreaterThan(0);
    expect(hookLines(noDir).some((c) => c.level === 'warn' || c.level === 'fail')).toBe(true);
    expect(noDir.issues,
      `an absent scripts/ dir added no issue (${noDir.issues} vs complete ${complete.issues})`)
      .toBeGreaterThan(complete.issues);
  });

  it('a missing ENTRY hook script is an issue and is named', () => {
    expect(noEntry.issues,
      `an absent hook entry script added no issue (${noEntry.issues} vs ${complete.issues})`)
      .toBeGreaterThan(complete.issues);
    expect(msg(noEntry)).toContain(ENTRY_SCRIPT);
  });

  it('a missing import-only helper is ALSO an issue here, unlike the SOURCE_FILES set', () => {
    // The demote direction. In a copy install `user-prompt-search.js` resolves
    // `./prompt-search-utils.mjs` against the install dir — ERR_MODULE_NOT_FOUND on every
    // user prompt. Copying the benign "reachable via realpath" branch from the managed-files
    // check to here would make this go green-with-no-issue; that must stay red.
    expect(noHelper.issues,
      `an absent hook-script helper added no issue (${noHelper.issues} vs ${complete.issues})`)
      .toBeGreaterThan(complete.issues);
    expect(msg(noHelper)).toContain(HELPER_SCRIPT);
  });

  it('the entry-point classification is derived from the real hook wiring, not hand-kept', () => {
    // HOOK_SCRIPT_ENTRY_POINTS is a literal list of names, and a literal list of names that
    // nothing cross-checks goes stale the moment a hook script is added — the guard would
    // then classify a genuine hook entry as an "imported helper" and describe the wrong
    // consequence. Re-derive it from the command lines Claude Code actually runs.
    //
    // hooks/hooks.json is the plugin manifest; install.mjs's settings.json template is held
    // equal to it by the existing event-set invariant (install.mjs: "Event set MUST stay
    // equal to hooks/hooks.json's"), so one source suffices.
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../hooks/hooks.json'), 'utf8'));
    const commands = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node.command === 'string') commands.push(node.command);
      for (const v of Object.values(node)) walk(v);
    })(manifest);
    expect(commands.length, 'no command strings found — the manifest shape changed').toBeGreaterThan(5);

    const invoked = HOOK_SCRIPT_FILES.filter((n) => commands.some((c) => c.includes(`scripts/${n}`)));
    expect([...HOOK_SCRIPT_ENTRY_POINTS].sort(),
      'HOOK_SCRIPT_ENTRY_POINTS drifted from the hook commands in hooks/hooks.json — '
      + 'classify the new script (entry = named by a command, helper = only imported)')
      .toEqual(invoked.sort());
    // And the set must never name a file the manifest does not ship.
    for (const name of HOOK_SCRIPT_ENTRY_POINTS) expect(HOOK_SCRIPT_FILES).toContain(name);
  });

  it('a dev install (whole scripts/ dir symlinked) is clean, not 8 non-symlink drifts', () => {
    // The false positive a naive per-file port of checkDevDrift would produce: the symlink
    // is on the DIRECTORY, so every entry lstats as a plain file. Judged by issue count so
    // no wording is load-bearing.
    expect(hookLines(devLinked).length, 'no hook-script line at all').toBeGreaterThan(0);
    expect(devLinked.issues,
      `a symlinked dev scripts/ dir was counted as drift (${devLinked.issues} vs copy-install ${complete.issues})`)
      .toBe(complete.issues);
  });
});
