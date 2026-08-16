// lib/injected-ids.mjs — file-name derivation for the cross-hook injected-ids
// dedup marker. Single source of truth for user-prompt-search.js (writer),
// pre-tool-recall.js (read/merge), and hook.mjs (path-A reader): all three must
// derive the same name or cross-hook dedup silently goes blind.
//
// D#120: M-6 session-keyed the marker's PAYLOAD but kept ONE file per project,
// so two concurrent CC windows full-replaced each other's marker — no dedup
// between them and `count` reset on every alternation (MAX_SESSION_INJECTIONS
// unreachable). One file per SESSION instead, mirroring
// pre-recall-cooldown-<session>.json in the same runtime dir. GC: session-start
// sweep in hook.mjs (24h mtime, same policy as the cooldown files).
//
// Lives under lib/ (not scripts/) so hook.mjs can statically import it without
// colliding with the scripts/ directory rename in installExtractedRelease —
// same constraint as lib/mem-override.mjs.

/**
 * Runtime-dir FILE NAME for the injected-ids marker (no directory component).
 * No sessionId → legacy project-keyed name (env-less harnesses, old callers).
 * @param {string} project - inferProject() value (already filename-safe)
 * @param {string} [sessionId] - CC session id
 * @returns {string}
 */
export function injectedIdsFileName(project, sessionId) {
  const base = `.claude-mem-injected-${project}`;
  if (!sessionId) return base;
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
  return `${base}-${safe}`;
}
