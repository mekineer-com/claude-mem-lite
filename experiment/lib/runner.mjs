// Trial assembler: one task × one arm × one trial → a RunResult.
//
// All side-effecting steps are injected via `deps` so the orchestrator wires the
// real implementations (git worktree checkout, DB seeding, `claude -p` spawn,
// regression-check spawn) while tests inject deterministic mocks. The assembler
// itself only sequences the steps, computes the three outcome metrics, and
// guarantees sandbox cleanup.
//
// deps = {
//   prepareSandbox(task, arm) -> { cwd, cleanup? }   // checkout repo @ startCommit
//   seedDb(task, arm, sandbox) -> dbPath|null         // build the per-arm mem DB
//   claudeRunner({task, arm, sandbox, dbPath}) -> { result, events }
//   runCheck(task, sandbox) -> { exitCode }           // task.regressionCheck
//   now() -> number                                   // wall-clock source
// }

import { extractTokens, countToolUses, recurredFromCheck } from './metrics.mjs';

export async function runTrial({ task, arm, trial }, deps) {
  const { prepareSandbox, seedDb, claudeRunner, runCheck, now } = deps;
  const startedAt = now();
  const sandbox = await prepareSandbox(task, arm);
  try {
    const dbPath = await seedDb(task, arm, sandbox);
    const { result, events } = await claudeRunner({ task, arm, sandbox, dbPath });
    const check = await runCheck(task, sandbox);
    return {
      taskId: task.id,
      arm: arm.name,
      trial,
      recurred: recurredFromCheck(check),
      tokens: extractTokens(result),
      toolCalls: countToolUses(events),
      wallClockMs: now() - startedAt,
    };
  } finally {
    if (sandbox?.cleanup) await sandbox.cleanup();
  }
}
