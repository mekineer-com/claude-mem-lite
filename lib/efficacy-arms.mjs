// lib/efficacy-arms.mjs — pure arm-semantics for the efficacy severe test.
// ONE tested source of truth for "what does arm X mean", because a wrong per-arm
// env silently invalidates the experiment (cf. #8711 isolated-v1: an omitted
// model env floored every arm and read like a real 0/8 result).
//
//   inject                 — seed the lesson sandbox (vs an empty control sandbox)
//   salience               — value for CLAUDE_MEM_SALIENCE ('' = unset = current default)
//   appendRequirement      — arm T spells the genuine fix into the task (positive control)
//   appendImperativeLesson — arm U appends the lesson at the task-prompt position wrapped
//                            in the imperative template — channel-isolation vs T (same
//                            position; memory-attribution vs genuine spec). See spec
//                            docs/superpowers/specs/2026-06-29-task-imperative-memory-injection-design.md
import { formatTaskImperative } from './task-imperative.mjs';

export const INJECTED_ARMS = new Set(['A', 'AL', 'F', 'B']);

export function armConfig(arm) {
  return {
    inject: INJECTED_ARMS.has(arm),
    salience: arm === 'AL' ? 'legacy' : arm === 'F' ? 'bind' : arm === 'B' ? 'bridge' : '',
    appendRequirement: arm === 'T',
    appendImperativeLesson: arm === 'U',
  };
}

// The task-prompt suffix an arm contributes. T and U are the two prompt-position
// arms: T spells in the genuine fix (spec.requirement), U the memory-imperative
// lesson (spec.lesson, content held constant with arm A). The injected/control
// arms (A/AL/B/F/C) contribute nothing — they deliver via the sandbox hook or not
// at all.
export function taskSuffixForArm(arm, spec) {
  const cfg = armConfig(arm);
  if (cfg.appendRequirement && spec.requirement) return ' ' + spec.requirement;
  if (cfg.appendImperativeLesson && spec.lesson) return ' ' + formatTaskImperative(spec.lesson);
  return '';
}
