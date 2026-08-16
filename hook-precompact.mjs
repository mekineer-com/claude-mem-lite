// claude-mem-lite: PreCompact hook handler.
// Fires immediately before Claude Code auto-compaction begins. Emits a
// fresh <claude-mem-context> block on stdout so the summarizer that
// produces the compacted context has the most relevant memory in scope.
// Differs from SessionStart-on-compact (which fires AFTER compaction):
// PreCompact ensures memory survives the compaction step itself.

import { buildSessionContextLines } from './hook-context.mjs';
import { inferProject, debugCatch, debugLog } from './utils.mjs';
import { RUNTIME_DIR } from './hook-shared.mjs';
import { recordKeyContextInjection } from './lib/keyctx-marker.mjs';

/**
 * Build + emit the memory context block on stdout. Writes the Key Context ids
 * the re-emitted block renders (refreshing handleUserPrompt's exclude-set — see
 * D#123 in hook.mjs) and bumps injection_count on those rows (D#124).
 *
 * @param {object} ctx
 * @param {import('better-sqlite3').Database} ctx.db
 * @param {string} ctx.project
 * @param {string} [ctx.sessionId]
 * @returns {void}
 */
export function handlePreCompact({ db, project, sessionId }) {
  try {
    const collector = {};
    const body = buildSessionContextLines(db, project, new Date(), sessionId || null, collector);
    if (!body || String(body).trim() === '') return;
    process.stdout.write(`<claude-mem-context>\n${body}\n</claude-mem-context>\n`);
    // Same recorder as handleSessionStart: marker + injection_count bump (D#124).
    // A re-render into a compacted context is a fresh injection of those rows.
    recordKeyContextInjection(db, {
      runtimeDir: RUNTIME_DIR,
      project,
      sessionId: sessionId || null,
      ids: collector.keyContextIds || [],
    });
  } catch (e) {
    debugCatch(e, 'handlePreCompact');
  }
}

/**
 * Default-export entry for hook.mjs dispatcher. Caller passes an opened DB
 * and the parsed stdin payload — no I/O performed inside this function
 * beyond what handlePreCompact does.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} hookData Parsed JSON from hook stdin
 * @returns {Promise<void>}
 */
export async function entry(db, hookData) {
  const project = inferProject();
  const sessionId = hookData?.session_id;
  debugLog('DEBUG', 'pre-compact', `project=${project} sessionId=${sessionId || 'none'}`);
  handlePreCompact({ db, project, sessionId });
}
