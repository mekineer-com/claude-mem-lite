// lib/stats-core.mjs — shared primary stats feed for CLI `stats` and MCP `mem_stats`.
//
// Audit 2026-07-17 MED-4: these ~15 COUNT/GROUP-BY queries were hand-copied
// byte-equivalent between server.mjs (mem_stats) and mem-cli.mjs (cmdStats) — the
// same twin-drift class the `--quality` sub-report already closed via
// lib/stats-quality.mjs, and delete orchestration via lib/delete-core.mjs. One
// computation, two renderers: callers keep their own formatting (MCP text block /
// CLI console+JSON) plus any surface-only extras (CLI hookErrors24h).
import { inferProject } from '../utils.mjs';
import { buildNotLowSignalSql } from './low-signal-patterns.mjs';
import { TIER_CASE_SQL, tierSqlParams } from '../tier.mjs';
import { computeNoiseGauge } from './stats-quality.mjs';

/**
 * Compute the primary stats feed. Row shapes are returned exactly as the twin
 * blocks produced them ({c}/{t}/{v} single-row objects, arrays for distributions)
 * so both call sites render with minimal diff.
 */
export function computeStatsFeed(db, { project = null, days = 30, now = Date.now() } = {}) {
  const cutoff = now - days * 86400000;
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  // Total counts (session_summaries, not sdk_sessions — CLI↔MCP aligned)
  const obsTotal = db.prepare(`SELECT COUNT(*) as c FROM observations WHERE 1=1 ${projectFilter}`).get(...baseParams);
  const sessTotal = db.prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE 1=1 ${projectFilter}`).get(...baseParams);
  const promptTotal = project
    ? db.prepare('SELECT COUNT(*) as c FROM user_prompts p JOIN sdk_sessions s ON p.content_session_id = s.content_session_id WHERE s.project = ?').get(project)
    : db.prepare('SELECT COUNT(*) as c FROM user_prompts').get();

  // Recent counts
  const obsRecent = db.prepare(`SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`).get(cutoff, ...baseParams);
  const sessRecent = db.prepare(`SELECT COUNT(*) as c FROM session_summaries WHERE created_at_epoch >= ? ${projectFilter}`).get(cutoff, ...baseParams);

  // Type distribution (recent)
  const types = db.prepare(`
    SELECT type, COUNT(*) as c FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
    GROUP BY type ORDER BY c DESC
  `).all(cutoff, ...baseParams);

  // Top projects (global view — skipped when filtering by single project)
  const projects = project ? [] : db.prepare(`
    SELECT project, COUNT(*) as c FROM observations
    GROUP BY project ORDER BY c DESC LIMIT 20
  `).all();

  // Daily activity (last 7 days)
  const daily = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as c FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
    GROUP BY day ORDER BY day DESC LIMIT 7
  `).all(now - 7 * 86400000, ...baseParams);

  // Data health
  const tokenEst = db.prepare(`
    SELECT SUM(LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(narrative,'')) + LENGTH(COALESCE(text,''))) / 4 as t
    FROM observations WHERE 1=1 ${projectFilter}
  `).get(...baseParams);
  const avgImp = db.prepare(`SELECT AVG(COALESCE(importance,1)) as v FROM observations WHERE 1=1 ${projectFilter}`).get(...baseParams);

  const thirtyDaysAgo = now - 30 * 86400000;
  // v3.23 noise-gauge de-blinding: `<= 1` makes the imp=0 dormant population visible
  // (decay floor + LLM low-signal filter push ~half the live corpus to 0);
  // injection_count=0 mirrors decay's NEVER-INJECTED guard so injected-but-decayed
  // pinned noise isn't miscounted as "never used".
  const lowVal = db.prepare(`
    SELECT COUNT(*) as c FROM observations
    WHERE COALESCE(importance,1) <= 1 AND COALESCE(access_count,0) = 0
      AND COALESCE(injection_count,0) = 0
      AND COALESCE(compressed_into, 0) = 0
      AND created_at_epoch < ? ${projectFilter}
  `).get(thirtyDaysAgo, ...baseParams);
  // Low-signal-title population (template / tool-log titles the read-side filter
  // already excludes). The imp≤1 "Low-value" metric can't see these, so the gauge
  // under-reports real noise without it. Same source as lib/low-signal-patterns.mjs.
  const lowSignalTitle = db.prepare(`
    SELECT COUNT(*) as c FROM observations
    WHERE NOT ${buildNotLowSignalSql()}
      AND COALESCE(compressed_into, 0) = 0 ${projectFilter}
  `).get(...baseParams);
  // F7: both noise numerators exclude compressed rows → divide by the LIVE count, not
  // obsTotal (all rows), so a compress-heavy store isn't reported cleaner than it is.
  const liveTotal = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}`
  ).get(...baseParams);
  const { noiseRatio, lowSignalRatio } = computeNoiseGauge({ liveTotal: liveTotal.c, lowValCount: lowVal.c, lowSignalCount: lowSignalTitle.c });
  const compressedCount = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE compressed_into IS NOT NULL ${projectFilter}`
  ).get(...baseParams);
  const supersededOnlyCount = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE superseded_at IS NOT NULL AND compressed_into IS NULL ${projectFilter}`
  ).get(...baseParams);

  // Tier distribution
  const tierCtx = { now, currentProject: project || inferProject(), currentSessionId: '' };
  const tdParams = tierSqlParams(tierCtx);
  const tierDist = db.prepare(`
    SELECT tier, COUNT(*) as c FROM (
      SELECT ${TIER_CASE_SQL} as tier FROM observations
      WHERE COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
    ) GROUP BY tier ORDER BY tier
  `).all(...tdParams, ...baseParams);
  const tierMap = Object.fromEntries(tierDist.map((r) => [r.tier, r.c]));

  return {
    obsTotal, sessTotal, promptTotal, obsRecent, sessRecent,
    types, projects, daily,
    tokenEst, avgImp, lowVal, lowSignalTitle, liveTotal,
    noiseRatio, lowSignalRatio, compressedCount, supersededOnlyCount,
    tierMap,
  };
}
