// cli/doctor.mjs — `claude-mem-lite doctor --benchmark|--metrics`.
// Extracted from mem-cli.mjs (v2.41, god-module split).
//
// `doctor` without flags is handled upstream by cli.mjs (routed to install.mjs
// for install health checks). With --benchmark or --metrics it is routed to
// mem-cli which delegates to this handler.

import { inferProject } from '../utils.mjs';
import { out } from './common.mjs';

export async function cmdDoctor(db, args) {
  if (args.includes('--benchmark')) {
    const { runBenchmark } = await import('../lib/doctor-benchmark.mjs');
    const project = inferProject();
    // Sample recent user prompts so the CLI report has non-null injection_rate
    // and hook latency. Without this, runBenchmark's prompts default of [] makes
    // every metric 0/null — a dead command from the user's perspective. Tests
    // bypass this CLI layer and call runBenchmark() directly, so the lib API
    // contract (default prompts=[]) is unchanged.
    let prompts = [];
    try {
      const limitIdx = args.indexOf('--prompts-limit');
      let limit = 50;
      if (limitIdx >= 0 && args[limitIdx + 1]) {
        const parsed = parseInt(args[limitIdx + 1], 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000) limit = parsed;
      }
      const rows = db.prepare(`
        SELECT p.prompt_text
        FROM user_prompts p
        JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
        WHERE s.project = ?
          AND p.prompt_text IS NOT NULL
          AND length(p.prompt_text) >= 15
        ORDER BY p.created_at_epoch DESC
        LIMIT ?
      `).all(project, limit);
      prompts = rows.map(r => r.prompt_text).filter(Boolean);
    } catch { /* missing/empty tables on a fresh DB → leave prompts=[] */ }
    const result = runBenchmark(db, { project, prompts });
    out(JSON.stringify(result, null, 2));
    return;
  }
  if (args.includes('--metrics')) {
    // v2.41: aggregate CLAUDE_MEM_METRICS=1 JSONL rows from last N days.
    // Read-side has no env gate — you can inspect whatever was recorded even
    // when metrics are currently off. Default window 7 days; --days N override.
    const { aggregateMetrics, formatSummary, DEFAULT_WINDOW_DAYS } = await import('../lib/metrics.mjs');
    const { DB_DIR } = await import('../schema.mjs');
    const daysIdx = args.indexOf('--days');
    let days = DEFAULT_WINDOW_DAYS;
    if (daysIdx >= 0 && args[daysIdx + 1]) {
      const parsed = parseInt(args[daysIdx + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 90) days = parsed;
    }
    const agg = aggregateMetrics(DB_DIR, days);
    if (args.includes('--json')) {
      out(JSON.stringify(agg, null, 2));
    } else {
      out(formatSummary(agg, days));
    }
    return;
  }
  out('[mem] doctor: supported flags: --benchmark, --metrics [--days N] [--json]');
  process.exitCode = 1;
}
