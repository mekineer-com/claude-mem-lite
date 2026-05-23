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

  const lines = ['[mem] 💡 Cite-back: you edited file(s) that received PreToolUse lessons this session.'];
  for (const m of matches) {
    const fname = basename(m.file);
    const idList = m.ids.map(id => `#${id}`).join(', ');
    lines.push(`  • ${fname} ← ${idList} — if you fixed it: /lesson --file ${fname} "<root cause + fix>"`);
  }
  return lines.join('\n');
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
