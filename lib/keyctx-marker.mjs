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

  // NO injection_count bump. v3.66.0 added one here and it had to be reverted in
  // v3.66.1: injection_count is not a neutral counter. scoring-sql.mjs states the
  // invariant — "bumped ONLY on UserPromptSubmit / hook-memory auto-inject" —
  // because noisePenaltyClause reads it as a NOISE signal: a row scores x0.5 once
  // injection_count >= 4 (and > access_count * 3), x0.2 at >= 8. Nothing bumps
  // access_count for a rendered row (bumpCitationAccess fires on CITED ids only),
  // so the counter crosses those thresholds purely as a function of elapsed
  // sessions, deprioritising the highest-importance rows — the exact rows Key
  // Context renders — in mem_search, UPS ranking and injectionRelevanceSql.
  //
  // The UPS bump the reverted code claimed to "mirror verbatim" is
  // query-conditioned: a row is counted only when it MATCHED a query, so the
  // counter means "auto-injected and never useful". A Key Context render is
  // unconditional and hits the same fixed row set every session, so it would have
  // measured nothing but time. D#124's requirement is decay reachability, which
  // the extractor face delivers on its own — decay reads decay_seen_count /
  // uncited_streak / cited_count, never injection_count.
  const bumped = 0;

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
