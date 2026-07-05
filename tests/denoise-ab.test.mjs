// Tests for benchmark/denoise-ab.mjs — the denoising A/B tradeoff harness.
// Motivation: denoising levers shift PRECISION (hard-negative suite) and RECALL
// (vocab-mismatch paraphrase suite) in OPPOSITE directions. Evaluating one suite
// alone (as the standing tests did) hides the other side of the tradeoff — that
// is how an OR-BM25 floor "improved precision" while cratering paraphrase recall
// got shipped-then-reverted. This harness runs BOTH suites and reports the
// precision↔recall tradeoff in one snapshot, A/B-comparable across a change.
import { describe, it, expect } from 'vitest';
import { summarizeTradeoff, runSnapshot, SUITES } from '../benchmark/denoise-ab.mjs';
import { createTestDb } from './test-helpers.mjs';
import { seedDatabase, seedVectors } from '../benchmark/benchmark.mjs';
import { readFileSync } from 'fs';

describe('summarizeTradeoff (pure verdict logic)', () => {
  const before = {
    precision_hard_negatives: { recall_at_10: 0.90, precision_at_10: 0.86, ndcg_at_10: 0.97, mrr_at_10: 0.96 },
    vocab_mismatch_paraphrase: { recall_at_10: 0.33, precision_at_10: 0.20, ndcg_at_10: 0.30, mrr_at_10: 0.40 },
  };

  it('flags the OR-floor failure mode: recall regression with no compensating gain → REJECT', () => {
    // Treatment leaves the precision suite untouched but craters paraphrase recall
    // (exactly the reverted Item-2 OR-floor behaviour).
    const after = {
      precision_hard_negatives: { recall_at_10: 0.90, precision_at_10: 0.86, ndcg_at_10: 0.97, mrr_at_10: 0.96 },
      vocab_mismatch_paraphrase: { recall_at_10: 0.05, precision_at_10: 0.20, ndcg_at_10: 0.10, mrr_at_10: 0.15 },
    };
    const r = summarizeTradeoff(before, after);
    expect(r.regressions.length).toBeGreaterThan(0);
    expect(r.gains.length).toBe(0);
    expect(r.verdict).toMatch(/REJECT/);
    expect(r.verdict).toMatch(/vocab_mismatch_paraphrase\.recall_at_10/);
  });

  it('labels a precision gain with no regression as NET-POSITIVE', () => {
    const after = {
      precision_hard_negatives: { recall_at_10: 0.90, precision_at_10: 0.92, ndcg_at_10: 0.98, mrr_at_10: 0.96 },
      vocab_mismatch_paraphrase: { recall_at_10: 0.33, precision_at_10: 0.20, ndcg_at_10: 0.30, mrr_at_10: 0.40 },
    };
    const r = summarizeTradeoff(before, after);
    expect(r.gains.length).toBeGreaterThan(0);
    expect(r.regressions.length).toBe(0);
    expect(r.verdict).toMatch(/NET-POSITIVE/);
  });

  it('labels a precision-up / recall-down change as a TRADEOFF (judge worth)', () => {
    const after = {
      precision_hard_negatives: { recall_at_10: 0.90, precision_at_10: 0.92, ndcg_at_10: 0.98, mrr_at_10: 0.96 },
      vocab_mismatch_paraphrase: { recall_at_10: 0.20, precision_at_10: 0.20, ndcg_at_10: 0.22, mrr_at_10: 0.30 },
    };
    const r = summarizeTradeoff(before, after);
    expect(r.gains.length).toBeGreaterThan(0);
    expect(r.regressions.length).toBeGreaterThan(0);
    expect(r.verdict).toMatch(/TRADEOFF/);
  });

  it('labels sub-threshold noise as NEUTRAL', () => {
    const after = {
      precision_hard_negatives: { recall_at_10: 0.905, precision_at_10: 0.859, ndcg_at_10: 0.97, mrr_at_10: 0.96 },
      vocab_mismatch_paraphrase: { recall_at_10: 0.335, precision_at_10: 0.20, ndcg_at_10: 0.30, mrr_at_10: 0.40 },
    };
    const r = summarizeTradeoff(before, after, { threshold: 0.02 });
    expect(r.regressions.length).toBe(0);
    expect(r.gains.length).toBe(0);
    expect(r.verdict).toMatch(/NEUTRAL/);
  });

  // P0-c: statistical-resolution disclosure. A mean-of-per-query-scores metric can
  // only resolve moves ≥ 1/n (one query flipping). When the verdict threshold sits
  // BELOW that (vocab suite n=12 → 1/12=0.083 ≫ 0.02), a "NEUTRAL — all |Δ|<0.02"
  // is misleading: the harness cannot resolve a sub-0.083 move at all, so NEUTRAL is
  // "under-resolved", not "safe" — exactly the "A/B NEUTRAL ≠ safe" trap.
  it('discloses single-query resolution (1/n) per suite when snapshots carry n', () => {
    const withN = {
      precision_hard_negatives: { ...before.precision_hard_negatives, n: 30 },
      vocab_mismatch_paraphrase: { ...before.vocab_mismatch_paraphrase, n: 12 },
    };
    const r = summarizeTradeoff(withN, withN, { threshold: 0.02 });
    const vocab = r.suites.find((s) => s.name === 'vocab_mismatch_paraphrase');
    const prec = r.suites.find((s) => s.name === 'precision_hard_negatives');
    expect(vocab.resolution).toBeCloseTo(1 / 12, 4);
    expect(prec.resolution).toBeCloseTo(1 / 30, 4);
  });

  it('flags suites whose single-query resolution exceeds the threshold as under-resolved', () => {
    const withN = {
      precision_hard_negatives: { ...before.precision_hard_negatives, n: 30 }, // 1/30=0.033 > 0.02 → also under-resolved
      vocab_mismatch_paraphrase: { ...before.vocab_mismatch_paraphrase, n: 12 }, // 1/12=0.083 > 0.02
    };
    const r = summarizeTradeoff(withN, withN, { threshold: 0.02 });
    expect(r.underResolved).toContain('vocab_mismatch_paraphrase');
    expect(r.underResolved).toContain('precision_hard_negatives');
    expect(r.verdict).toMatch(/under-resolved|resolution/i);
  });

  it('omits resolution fields gracefully when snapshots lack n (back-compat)', () => {
    const r = summarizeTradeoff(before, before, { threshold: 0.02 });
    expect(r.underResolved).toEqual([]);
    expect(r.suites[0].resolution).toBeNull();
  });
});

describe('runSnapshot (integration over both suites)', () => {
  it('produces precision + recall metrics for both the precision and paraphrase suites', () => {
    const db = createTestDb();
    const corpus = JSON.parse(readFileSync(new URL('../benchmark/fixtures/seed-data.json', import.meta.url), 'utf8'));
    seedDatabase(db, corpus);
    seedVectors(db);

    const snap = runSnapshot(db);
    // Both suites present, each with the four ranking metrics as finite numbers.
    for (const s of SUITES) {
      expect(snap[s.name]).toBeDefined();
      for (const m of ['recall_at_10', 'precision_at_10', 'ndcg_at_10', 'mrr_at_10']) {
        expect(Number.isFinite(snap[s.name][m]), `${s.name}.${m}`).toBe(true);
      }
    }
    // The paraphrase suite is the recall-stressed one; precision suite scores high.
    expect(snap.precision_hard_negatives.precision_at_10).toBeGreaterThan(0.5);
    // Each suite records its query count so summarizeTradeoff can disclose the
    // single-query resolution (1/n) of the mean-of-per-query metrics.
    for (const s of SUITES) {
      expect(Number.isInteger(snap[s.name].n), `${s.name}.n`).toBe(true);
      expect(snap[s.name].n).toBeGreaterThan(0);
    }
    db.close();
  });
});
