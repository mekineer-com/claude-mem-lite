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
    const result = runBenchmark(db, { project });
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
