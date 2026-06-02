// Real (side-effecting) implementations of the runTrial dependency interface.
// These spawn git, `claude -p`, and the task's regression check, so they CANNOT
// run in CI — they are validated by `node experiment/run-experiment.mjs --live`
// against a real `claude` binary (the run step the harness intentionally defers).
// In dry-run the orchestrator injects deterministic mocks instead; the pure
// assembler in runner.mjs is what the unit tests cover.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedArmDb } from './seed-db.mjs';
import { buildEnv } from './arms.mjs';

/** Parse a stream-json stdout blob into events; tolerate non-JSON lines. */
function parseStreamJson(stdout) {
  const events = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      // Non-JSON noise (banners, warnings) — skip; claude -p JSON framing is
      // known to occasionally interleave plain text (see mem #8605).
    }
  }
  return events;
}

function runClaude({ task, arm, sandbox, dbPath, claudeBin, model }) {
  const env = {
    ...process.env,
    ...buildEnv(arm, { dbPath, runtimeDir: join(sandbox.dir, 'runtime') }),
  };
  const proc = spawnSync(
    claudeBin,
    ['-p', task.prompt, '--output-format', 'stream-json', '--verbose', '--model', model],
    { cwd: sandbox.cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const events = parseStreamJson(proc.stdout || '');
  const result = events.find((e) => e?.type === 'result') || {};
  return { result, events };
}

function runRegressionCheck(task, sandbox) {
  // task.regressionCheck is a shell command that exits 0 when the captured bug
  // is ABSENT. A non-zero exit = the bug recurred. Run it in the sandbox repo.
  const proc = spawnSync('bash', ['-lc', task.regressionCheck], {
    cwd: sandbox.cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { exitCode: proc.status === null || proc.status === undefined ? 1 : proc.status };
}

/**
 * Build the real dependency bundle for runTrial.
 * @param {object} opts
 * @param {string} opts.repoRoot   Default repo to clone when a task omits `repo`.
 * @param {object[]} [opts.shuffledPool]  Irrelevant memories for the shuffled arm.
 * @param {string} [opts.claudeBin='claude']
 * @param {string} [opts.model='sonnet']
 */
export function realDeps({ repoRoot, shuffledPool = [], claudeBin = 'claude', model = 'sonnet' }) {
  return {
    now: () => Date.now(),

    prepareSandbox: (task) => {
      const dir = mkdtempSync(join(tmpdir(), `exp-${task.id}-`));
      const work = join(dir, 'repo');
      mkdirSync(work, { recursive: true });
      const src = task.repo || repoRoot;
      execFileSync('git', ['clone', '--quiet', src, work]);
      execFileSync('git', ['-C', work, 'checkout', '--quiet', task.startCommit]);
      // For hooked arms the sandbox needs the mem hooks registered. We point the
      // hooks at the seeded DB via env (CLAUDE_MEM_DB_PATH from buildEnv); the
      // settings.json registration is written by writeHookSettings when present.
      return {
        cwd: work,
        dir,
        cleanup: () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        },
      };
    },

    seedDb: (task, arm, sandbox) => {
      if (arm.seed === 'none') return null;
      const dbPath = join(sandbox.dir, 'mem.db');
      seedArmDb(dbPath, arm, task, { shuffledPool });
      if (arm.hooks) writeHookSettings(sandbox, dbPath);
      return dbPath;
    },

    claudeRunner: (ctx) => runClaude({ ...ctx, claudeBin, model }),
    runCheck: (task, sandbox) => runRegressionCheck(task, sandbox),
  };
}

/**
 * Register the mem hooks in the sandbox's .claude/settings.json so `claude -p`
 * invokes them for this run. This is the integration seam that requires a live
 * `claude` to validate; the exact hook command resolves from the installed
 * plugin. Kept minimal and overridable via CLAUDE_MEM_EXPERIMENT_SETTINGS.
 */
function writeHookSettings(sandbox, dbPath) {
  const override = process.env.CLAUDE_MEM_EXPERIMENT_SETTINGS;
  const claudeDir = join(sandbox.cwd, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  if (override) {
    writeFileSync(join(claudeDir, 'settings.json'), override);
    return;
  }
  // Minimal marker: the real registration is environment-specific (plugin path),
  // so a live run sets CLAUDE_MEM_EXPERIMENT_SETTINGS to a settings.json whose
  // hooks point at the installed mem hook scripts with CLAUDE_MEM_DB_PATH=dbPath.
  writeFileSync(
    join(claudeDir, 'experiment-db-path'),
    dbPath + '\n'
  );
}
