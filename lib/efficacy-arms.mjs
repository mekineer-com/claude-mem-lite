// lib/efficacy-arms.mjs — pure arm-semantics for the efficacy severe test.
// ONE tested source of truth for "what does arm X mean", because a wrong per-arm
// env silently invalidates the experiment (cf. #8711 isolated-v1: an omitted
// model env floored every arm and read like a real 0/8 result).
//
//   inject            — seed the lesson sandbox (vs an empty control sandbox)
//   salience          — value for CLAUDE_MEM_SALIENCE ('' = unset = current default)
//   appendRequirement — arm T spells the fix into the task itself (gauge sanity)

export const INJECTED_ARMS = new Set(['A', 'AL', 'F']);

export function armConfig(arm) {
  return {
    inject: INJECTED_ARMS.has(arm),
    salience: arm === 'AL' ? 'legacy' : arm === 'F' ? 'bind' : '',
    appendRequirement: arm === 'T',
  };
}
