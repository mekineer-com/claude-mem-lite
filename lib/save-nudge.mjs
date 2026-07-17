// Save-time lesson nudge (audit 2026-07-17 P4): bugfix/decision are the types whose
// value lives in the lesson (root cause + fix / constraint + tradeoff), yet they are
// exactly where lessonless writes concentrate (14d live data: bugfix 18.8% / decision
// 28.7% lessonless, worsening). The nudge fires in the SAVE RESPONSE — the one moment
// the model still has the context to write the lesson — and names the exact follow-up
// call, so acting on it costs one tool call. Zero LLM cost; the async backfill arm
// (optimizeRun wide/aliases re-enrich) stays the safety net for saves that ignore it.
//
// Shared by server.mjs (mem_save) and mem-cli.mjs (cmdSave) — one gate, two phrasings,
// no twin drift.
const NUDGE_TYPES = new Set(['bugfix', 'decision']);

/**
 * @param {{ type: string, id: number, lessonCaptured: boolean, surface: 'mcp'|'cli' }} p
 * @returns {string} nudge text to append ('' when no nudge applies)
 */
export function buildLessonNudge({ type, id, lessonCaptured, surface }) {
  if (lessonCaptured || !NUDGE_TYPES.has(type)) return '';
  return surface === 'cli'
    ? `\n[mem] ⚠ ${type} #${id} saved without a lesson — capture the root cause + fix while it's fresh: claude-mem-lite update ${id} --lesson "<root cause + fix>"`
    : ` ⚠ Saved without lesson_learned — a ${type} is worth keeping only with its lesson. Capture it now: mem_update(id=${id}, lesson_learned="<root cause + fix>").`;
}
