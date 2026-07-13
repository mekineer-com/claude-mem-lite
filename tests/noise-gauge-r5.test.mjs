// v3.42 F7: the stats noise/low-signal gauges divided by COUNT(*) (all rows incl. compressed)
// while both numerators exclude compressed rows — so on a compress-heavy store the gauge
// UNDER-reported noise (store looked cleaner than it is, right before a maintain/compress
// decision). Fix: divide by the LIVE (non-compressed) count, shared by CLI + MCP via
// computeNoiseGauge so the two surfaces can't drift.
import { describe, it, expect } from 'vitest';
import { computeNoiseGauge } from '../lib/stats-quality.mjs';

describe('computeNoiseGauge — live-corpus denominator (F7)', () => {
  it('divides by the live (non-compressed) count, not the all-rows total', () => {
    // 100 rows total, 60 compressed → 40 live. 20 dormant-noise, 8 low-signal-title.
    const g = computeNoiseGauge({ liveTotal: 40, lowValCount: 20, lowSignalCount: 8 });
    // Correct: 20/40 = 0.50 and 8/40 = 0.20 — NOT the diluted 20/100=0.2 / 8/100=0.08.
    expect(g.noiseRatio).toBeCloseTo(0.5, 5);
    expect(g.lowSignalRatio).toBeCloseTo(0.2, 5);
  });

  it('returns 0 (no divide-by-zero) when the live corpus is empty / all-compressed', () => {
    const g = computeNoiseGauge({ liveTotal: 0, lowValCount: 5, lowSignalCount: 3 });
    expect(g.noiseRatio).toBe(0);
    expect(g.lowSignalRatio).toBe(0);
  });
});
