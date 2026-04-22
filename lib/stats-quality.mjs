// Shared quality-dashboard computation — used by both mem-cli.mjs (CLI
// `stats --quality`) and server.mjs (MCP `mem_stats({quality: true})`).
// Splits pure data aggregation from text rendering so MCP handlers don't
// collide with CLI's `out()` stdout-write pattern.

import { notLowSignalTitleClause } from '../scoring-sql.mjs';
import { truncate } from '../format-utils.mjs';

export function computeQualityStats(db, { project, days }) {
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];
  const cutoff = Date.now() - days * 86400000;

  // LOW_SIGNAL match = NOT notLowSignal. Shared helper keeps SQL in sync
  // with scoring-sql.mjs and pre-tool-recall.js Edit-fallback filter.
  const lowSignalIsMatchExpr = `NOT ${notLowSignalTitleClause('')}`;

  // Narrative-text proxy for bugfix investigations that never landed a fix.
  const unresolvedNarrativeExpr = `(
    LOWER(COALESCE(narrative,'')) LIKE '%not yet identified%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%not yet resolved%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%not yet fixed%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%root cause not%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%still fail%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%errors persisted%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%persisted on retry%'
  )`;

  const windowRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END) as with_lesson,
      SUM(CASE WHEN ${lowSignalIsMatchExpr} THEN 1 ELSE 0 END) as low_signal,
      SUM(CASE WHEN type = 'bugfix' THEN 1 ELSE 0 END) as bugfix_total,
      SUM(CASE WHEN type = 'bugfix' AND ${unresolvedNarrativeExpr} THEN 1 ELSE 0 END) as bugfix_unresolved
    FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
  `).get(cutoff, ...baseParams);

  const allTimeRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END) as with_lesson,
      SUM(CASE WHEN ${lowSignalIsMatchExpr} THEN 1 ELSE 0 END) as low_signal
    FROM observations
    WHERE 1=1 ${projectFilter}
  `).get(...baseParams);

  const typeRows = db.prepare(`
    SELECT
      type,
      COUNT(*) as total,
      SUM(CASE WHEN COALESCE(access_count, 0) > 0 THEN 1 ELSE 0 END) as accessed,
      SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END) as with_lesson
    FROM observations
    WHERE created_at_epoch >= ? ${projectFilter}
    GROUP BY type
    ORDER BY total DESC
  `).all(cutoff, ...baseParams);

  const topLessons = db.prepare(`
    SELECT id, type, title, lesson_learned, COALESCE(access_count, 0) as ac
    FROM observations
    WHERE lesson_learned IS NOT NULL AND lesson_learned != ''
      AND COALESCE(access_count, 0) > 0
      AND COALESCE(compressed_into, 0) = 0
      ${projectFilter}
    ORDER BY ac DESC
    LIMIT 5
  `).all(...baseParams);

  return { windowRow, allTimeRow, typeRows, topLessons, project, days };
}

export function formatQualityReport(data) {
  const { windowRow, allTimeRow, typeRows, topLessons, project, days } = data;
  const pct = (n, d) => d > 0 ? (100 * n / d).toFixed(1) : '0.0';
  const scope = project ? ` — ${project}` : '';
  const lines = [];
  lines.push(`[mem] Quality snapshot${scope} — window: ${days}d`);
  lines.push('────────────────────────────────────────────────────');
  lines.push(`  Writes (${days}d):     ${windowRow.total} observations`);

  const lessonPct = pct(windowRow.with_lesson, windowRow.total);
  const allLessonPct = pct(allTimeRow.with_lesson, allTimeRow.total);
  lines.push(`  Lesson rate:      ${windowRow.with_lesson} / ${windowRow.total} (${lessonPct}%)    [all-time: ${allTimeRow.with_lesson} / ${allTimeRow.total} = ${allLessonPct}%]`);

  const noisePct = pct(windowRow.low_signal, windowRow.total);
  const allNoisePct = pct(allTimeRow.low_signal, allTimeRow.total);
  lines.push(`  LOW_SIGNAL:       ${windowRow.low_signal} / ${windowRow.total} (${noisePct}%)    [all-time: ${allTimeRow.low_signal} / ${allTimeRow.total} = ${allNoisePct}%]`);

  if (windowRow.bugfix_total > 0) {
    const unresolvedPct = pct(windowRow.bugfix_unresolved, windowRow.bugfix_total);
    lines.push(`  Unresolved bugfix: ${windowRow.bugfix_unresolved} / ${windowRow.bugfix_total} (${unresolvedPct}%)    [investigation-only narratives — should trend ↓ with R-6 manual-save contract]`);
  }
  lines.push('');

  if (typeRows.length > 0) {
    lines.push(`  Type breakdown (${days}d):`);
    for (const r of typeRows) {
      const hit = pct(r.accessed, r.total);
      const lp = pct(r.with_lesson, r.total);
      const typeLabel = r.type.padEnd(10);
      lines.push(`    ${typeLabel}${String(r.total).padStart(5)}   hit ${hit.padStart(5)}%   lesson ${lp.padStart(5)}%`);
    }
    lines.push('');
  }

  if (topLessons.length > 0) {
    lines.push('  Top accessed lessons (all-time):');
    for (const l of topLessons) {
      const t = truncate(l.lesson_learned, 80);
      lines.push(`    #${l.id} [${l.type}] (${l.ac}x) ${t}`);
    }
    lines.push('');
  }

  // R-2 watchdog — format matches historical cmdStats for test stability
  const lessonNum = parseFloat(lessonPct);
  const noiseNum = parseFloat(noisePct);
  const lessonGap = (lessonNum - 15).toFixed(1);
  const noiseGap = (noiseNum - 30).toFixed(1);
  const lessonStatus = lessonNum >= 15 ? '✅' : '🔴';
  const noiseStatus = noiseNum <= 30 ? '✅' : '🔴';
  lines.push('  Targets (R-2 watchdog):');
  lines.push(`    ${lessonStatus} Lesson rate ≥ 15%    → currently ${lessonPct}%  (gap ${lessonGap >= 0 ? '+' : ''}${lessonGap}pp)`);
  lines.push(`    ${noiseStatus} LOW_SIGNAL  ≤ 30%    → currently ${noisePct}%  (gap ${noiseGap >= 0 ? '+' : ''}${noiseGap}pp)`);

  return lines.join('\n');
}
