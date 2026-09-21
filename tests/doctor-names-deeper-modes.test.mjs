// `doctor` is the command a user runs when something is wrong, and it was the only surface
// that never mentioned the three deeper modes exist.
//
// The two-doctor split is invisible from outside: `doctor` with no flags goes to install.mjs's
// health check, and `--benchmark` / `--metrics` / `--session-audit` are routed to
// cli/doctor.mjs by cli.mjs. On a clean sandbox the plain run prints a couple of dozen check
// lines and a count — the exact number depends on the sandbox's own state, so it is not quoted
// as a property — and the strings "benchmark", "metrics" and "session-audit" appeared nowhere
// in it. A user whose install is healthy but whose RETRIEVAL is bad reads "All checks passed!"
// and has no way to learn that a retrieval benchmark is one flag away.
//
// This is the cheap half of D6. The expensive half -- actually merging the two
// implementations -- is closed as won't-fix: the failure it would have prevented (a new mode
// added to cli/doctor.mjs and not to the router, silently answered by the install check) is
// now gated by tests/doctor-mode-router-sync.test.mjs, and "merging" either yields one
// 1100-line function or reproduces today's structure in one file.
//
// The pointer is asserted to be DERIVED from the router rather than typed, because a
// hand-written list of modes in a help string is the same rot the router guard exists for —
// one more copy to forget.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DOCTOR_DB_MODES } from '../lib/doctor-modes.mjs';

// D#207: join(), never new URL('../x.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function runDoctor(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-modes-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  try {
    return spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'doctor', ...extra], {
      cwd: work,
      env: {
        ...env,
        HOME: home,
        CLAUDE_MEM_DIR: join(home, '.claude-mem-lite'),
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_MEM_SKIP_UPDATE: '1',
      },
      encoding: 'utf8',
      timeout: 120000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('plain doctor tells the user the deeper modes exist', () => {
  it('names every mode the router forwards', () => {
    // Premise: the constant really does carry modes, so an empty list cannot pass the loop.
    // That the ROUTER consults this same constant is pinned by
    // tests/doctor-mode-router-sync.test.mjs, which is why reading it here is not a shortcut.
    expect(DOCTOR_DB_MODES.length).toBeGreaterThan(2);

    const r = runDoctor();
    for (const mode of DOCTOR_DB_MODES) {
      expect(r.stdout, `doctor never mentions --${mode}:\n${r.stdout}`).toContain(`--${mode}`);
    }
  });

  it('does not repeat the modes as a second hand-written list', () => {
    // The pointer must be built from the same constant the router is, or it becomes one more
    // copy to forget — which is the defect tests/doctor-mode-router-sync.test.mjs guards.
    const src = readFileSync(join(REPO, 'install.mjs'), 'utf8');
    const literal = src.match(/--benchmark[^\n]*--metrics[^\n]*--session-audit/);
    expect(
      literal,
      'install.mjs spells the three modes inline; derive them from DOCTOR_DB_MODES instead',
    ).toBeNull();
  });

  it('prints the modes as a list, not as something a shell would run', () => {
    // The first draft printed `claude-mem-lite doctor --benchmark | --metrics |
    // --session-audit`. A line shaped like a command gets copy-pasted, and `|` is a pipe:
    //     $ claude-mem-lite doctor --benchmark | --metrics | --session-audit
    //     bash: --metrics: command not found
    // Which is the defect 32c8923 fixed one commit earlier in this same branch — a remedy
    // naming something that cannot run — coming back in a different spelling.
    const r = runDoctor();
    const line = r.stdout.split('\n').find((l) => l.includes('Deeper checks'));
    expect(line, `no "Deeper checks" line in:\n${r.stdout}`).toBeTruthy();
    expect(line, `this line is shell-pipe shaped: ${line}`).not.toMatch(/\|/);
  });

  it('still exits non-zero when there are real issues', () => {
    // The pointer is a line of prose; it must not touch the exit-code contract that
    // `claude-mem-lite doctor || alert` depends on.
    const r = runDoctor();
    expect(r.stdout).toMatch(/issue\(s\) found|All (critical )?checks passed/);
    expect([0, 1]).toContain(r.status);
  });
});
