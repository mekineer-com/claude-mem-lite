// Experiment arms for the value A/B.
//
//   control   — no memory injection at all (the host session runs without the
//               mem hooks). Baseline coding behavior.
//   treatment — full injection, the DB seeded with the task's own captured
//               memory (the obs that SHOULD have helped a future session).
//   shuffled  — full injection, the DB seeded with count-matched but IRRELEVANT
//               memories. Negative control: if shuffled ≈ treatment, any extra
//               context primed the model, so retrieval is not what helped.
//
// `hooks` drives whether the sandbox registers the mem hooks; `seed` selects
// what seedArmDb writes into the per-arm DB.

export const ARMS = {
  control: { name: 'control', hooks: false, seed: 'none' },
  treatment: { name: 'treatment', hooks: true, seed: 'captured' },
  shuffled: { name: 'shuffled', hooks: true, seed: 'shuffled' },
};

export const ARM_LIST = [ARMS.control, ARMS.treatment, ARMS.shuffled];

/**
 * Environment for a claude run under `arm`. All arms share experiment-isolation
 * flags so an experiment run never mutates importance (citation decay off),
 * auto-updates, or runs the optimize pipeline. Only hooked arms get a DB path.
 */
export function buildEnv(arm, { dbPath, runtimeDir }) {
  const base = {
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    MEM_DISABLE_CITATION_DECAY: '1',
    CLAUDE_MEM_HOOK_RUNNING: '',
  };
  if (!arm.hooks) return base;
  return { ...base, CLAUDE_MEM_DB_PATH: dbPath, CLAUDE_MEM_RUNTIME_DIR: runtimeDir };
}
