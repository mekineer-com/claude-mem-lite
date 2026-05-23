// claude-mem-lite: PostToolUse cite-back hint builder.
//
// Fires when a flushed episode edits a file that PreToolUse:Read/Edit had
// nudged earlier in the same session — the canonical "you fixed something we
// warned about, save the lesson?" moment.
//
// Pure function: takes an episode + the session-scoped pre-recall cooldown
// object and returns a hint string (or null). Cooldown I/O lives elsewhere so
// this stays unit-testable without disk fixtures.
//
// Cooldown schema (post-v2.81): { "<path>": { ts: <number>, lessonIds: [#NN, ...] } }
// Legacy schema   (pre-v2.81):  { "<path>": <number> } — tolerated, never emits.

import { basename, join } from 'path';
import { readFileSync } from 'fs';
import { EDIT_TOOLS } from '../utils.mjs';

const MAX_FILES = 2;

export function buildCiteBackHint(episode, cooldown) {
  if (!episode || !cooldown) return null;
  const entries = episode.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const seen = new Set();
  const matches = [];
  for (const e of entries) {
    if (!EDIT_TOOLS.has(e.tool)) continue;
    for (const file of e.files || []) {
      if (seen.has(file)) continue;
      const entry = cooldown[file];
      if (!entry || typeof entry !== 'object') continue;
      const ids = Array.isArray(entry.lessonIds) ? entry.lessonIds : null;
      if (!ids || ids.length === 0) continue;
      seen.add(file);
      matches.push({ file, ids });
      if (matches.length >= MAX_FILES) break;
    }
    if (matches.length >= MAX_FILES) break;
  }

  if (matches.length === 0) return null;

  // B1 (v2.83): leader line carries explicit counts (file count + total lesson
  // count) and a directive verb. Pre-v2.83 wording "if you fixed it" was
  // routinely treated as advisory and ignored — cite-recall data showed the
  // hint firing without follow-up `/lesson` calls. §10 Specificity binds:
  // numeric framing is measurably harder to dismiss than a hedged hint.
  const totalLessons = matches.reduce((sum, m) => sum + m.ids.length, 0);
  const lines = [
    `[mem] ⚠ Cite-back: edited ${matches.length} file(s) with ${totalLessons} prior lesson(s) this session. Save now if any was the root cause:`,
  ];
  for (const m of matches) {
    const fname = basename(m.file);
    const idList = m.ids.map(id => `#${id}`).join(', ');
    lines.push(`  • ${fname} ← ${idList} — /lesson --file ${fname} "<root cause + fix>"`);
  }
  return lines.join('\n');
}

// B1 (v2.83): structured per-episode "tricky fix just happened" detector. Lifts
// the inline error→fix nudge that used to live in hook.mjs flushEpisode into
// the lib so all save-prompt hints share one home + the same wording rules.
//
// Detection (mirrors pre-v2.83 hook.mjs:194 heuristic):
//   • has at least one entry with isError=true
//   • has at least one entry using an edit tool
//   • entries.length >= 3 (rules out single-typo fixes that don't need a lesson)
// Returns null when any condition fails or when no edited files are recoverable
// from the entry list (defensive — episodes flushed mid-tool can have empties).
const MIN_BUGFIX_ENTRIES = 3;
const MAX_DISPLAY_FILES = 3;

export function buildUnsavedBugfixHint(episode) {
  if (!episode) return null;
  const entries = episode.entries;
  if (!Array.isArray(entries) || entries.length < MIN_BUGFIX_ENTRIES) return null;

  let hasError = false;
  let hasEdit = false;
  const editedFiles = new Set();
  for (const e of entries) {
    if (!e) continue;
    if (e.isError) hasError = true;
    if (EDIT_TOOLS.has(e.tool)) {
      hasEdit = true;
      for (const f of e.files || []) editedFiles.add(f);
    }
  }
  if (!hasError || !hasEdit || editedFiles.size === 0) return null;

  const files = [...editedFiles];
  const displayed = files.slice(0, MAX_DISPLAY_FILES).map(f => basename(f));
  const firstFname = basename(files[0]);
  return `[mem] ⚠ Unsaved bugfix-shape: error+edit across ${files.length} file(s) in ${entries.length} entries (${displayed.join(', ')}). Save now if it was a real fix: /lesson --file ${firstFname} "<root cause + fix>"`;
}

// Path scheme MUST mirror scripts/pre-tool-recall.js cooldownPathFor() — drift
// silently zeros cite-back across the release. Pinned by tests/cite-back-hint.test.mjs
// 'sanitizes the sessionId the same way pre-tool-recall.js does'.
function cooldownPathFor(sessionId, runtimeDir) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);
  return join(runtimeDir, `pre-recall-cooldown-${safe}.json`);
}

export function loadCiteBackForEpisode(episode, runtimeDir) {
  if (!episode || !episode.sessionId || !runtimeDir) return null;
  let cooldown;
  try {
    cooldown = JSON.parse(readFileSync(cooldownPathFor(episode.sessionId, runtimeDir), 'utf8'));
  } catch {
    return null;
  }
  return buildCiteBackHint(episode, cooldown);
}
