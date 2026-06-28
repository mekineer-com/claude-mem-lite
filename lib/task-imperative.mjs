// lib/task-imperative.mjs — pure formatter for the task-imperative memory line.
// Shared by the live UserPromptSubmit emitter (Phase 2) AND efficacy arm U (the
// measurement that gates Phase 2): ONE tested source of truth so the measured
// framing and the shipped framing cannot drift. Hot-path-shared → regex/string
// only, NO heavy imports (lesson #8447), mirroring lib/lesson-idents.mjs.
//
// Delivers a high-value lesson at the task-prompt position as an imperative,
// task-bound constraint: attribution kept (honest + #NN cite-traceable), the
// path-A/B softeners ("FYI", "continue your task", "NOT a new user message")
// dropped.
// Spec: docs/superpowers/specs/2026-06-29-task-imperative-memory-injection-design.md

export function formatTaskImperative(lesson, id) {
  const body = String(lesson || '').trim().replace(/\.$/, '');
  if (!body) return '';
  const tag = (id === undefined || id === null || id === '') ? '' : ` (#${id})`;
  return `Memory — a past lesson applies to THIS task. You must: ${body}.${tag}`;
}
