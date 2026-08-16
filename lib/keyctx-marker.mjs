// lib/keyctx-marker.mjs — the one place the SessionStart Key Context render is
// recorded. Two things happen together because they must describe the SAME set:
//
//   ① the per-session marker file (D#123 review C-1): the obs ids ACTUALLY
//      rendered into <claude-mem-context>, which handleUserPrompt reads as its
//      exclude-set. Written even when empty, so a resumed session can never act
//      on a previous session's stale semantics.
//   ② injection_count / last_injected_at on those same rows (D#124): before
//      this, Key Context was a shown-but-uncounted surface — up to 10 rows per
//      session that could accrue no denominator and therefore never promote or
//      demote through applyCitationDecay.
//
// handleSessionStart (hook.mjs) and handlePreCompact (hook-precompact.mjs) both
// render the block, so both call this. Keeping the pair in one function is the
// point: the CLI/MCP and SessionStart/PreCompact twin pairs in this repo have
// drifted often enough that "two callers, one body" is the standing rule.
//
// Never throws: a marker-write failure must not break context delivery, and it
// must not cost the metering either — the bump runs first.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { debugCatch } from '../utils.mjs';
import { keyContextIdsFileName } from './injected-ids.mjs';

/**
 * Record one Key Context render: bump the rendered rows, then persist the id
 * list for the prompt-time exclude-set and the citation extractor.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx
 * @param {string} ctx.runtimeDir  RUNTIME_DIR of the caller
 * @param {string} ctx.project     inferProject() value (filename-safe)
 * @param {string|null} [ctx.sessionId] CC session id
 * @param {number[]} [ctx.ids]     obs ids ACTUALLY rendered (empty on quiet projects)
 * @returns {{bumped: number, written: boolean}}
 */
export function recordKeyContextInjection(db, { runtimeDir, project, sessionId = null, ids = [] } = {}) {
  const clean = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && id < 1e7) clean.push(id);
  }

  let bumped = 0;
  if (db && clean.length > 0) {
    try {
      const now = Date.now();
      // Mirrors hook-memory.mjs's UPS bump verbatim so the two surfaces feed the
      // same counter with the same semantics. Per-row try/catch for FTS trigger
      // safety (project_non_obvious.md).
      const stmt = db.prepare(
        'UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1, last_injected_at = ? WHERE id = ?'
      );
      for (const id of clean) {
        try { stmt.run(now, id); bumped++; } catch { /* single-row failure must not drop the rest */ }
      }
    } catch (e) { debugCatch(e, 'keyctx-bump'); }
  }

  let written = false;
  try {
    writeFileSync(
      join(runtimeDir, keyContextIdsFileName(project, sessionId)),
      JSON.stringify({ ids: clean, ts: Date.now(), session: sessionId || null }),
    );
    written = true;
  } catch (e) { debugCatch(e, 'keyctx-marker-write'); }

  return { bumped, written };
}
