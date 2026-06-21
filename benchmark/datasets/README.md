# Benchmark datasets

Standard long-term-memory retrieval benchmarks, used by the runners in
`benchmark/` to measure claude-mem-lite against the field. The dataset files
themselves are **large and not committed** (`.gitignore` excludes
`benchmark/datasets/*.json` / `*.jsonl`); only the download scripts live here.

## LongMemEval

```bash
bash benchmark/datasets/download-longmemeval.sh        # ~300 MB, one-time
node benchmark/longmemeval.mjs benchmark/datasets/longmemeval_s_cleaned.json
```

Useful flags (`node benchmark/longmemeval.mjs --help`-style):

| Flag | Default | Meaning |
|---|---|---|
| `--turns user\|all` | `user` | Corpus = user turns only (MemPalace raw baseline) or both. `all` is **not** comparable to their raw number. |
| `--ks 1,5,10` | `1,5,10` | recall_any@k cutoffs to report. |
| `--limit N` | `10` | Top-N retrieved per question. |
| `--max N` | all | Cap questions (smoke runs). |
| `--out path.jsonl` | — | Write per-question records + a `.summary.json`. |

### How to read the number — honest caveats

- We are a **lexical** system (FTS5/BM25 + TF-IDF + RRF, zero embeddings).
  MemPalace's headline **96.6% R@5** is *embedding* retrieval over verbatim text.
  We are testing how far a no-embedding baseline gets, **not** trying to match it.
- Expect to **trail on paraphrase-heavy categories** (e.g.
  `single-session-preference`, vocabulary-gap questions) where the query and the
  gold session share meaning but not words. Report **per-type** recall and never
  quote the embedding number as ours.
- Metric is **recall_any@k** (binary: any gold session in top-k, averaged) — the
  LongMemEval headline definition, computed in `longmemeval.mjs`, distinct from
  `benchmark.mjs`'s fractional `computeRecallAtK`.
- The adapter drives the **real** production hybrid path (`searchProductionHybrid`),
  with time-decay / project-boost / importance held constant so the number
  reflects retrieval, not scoring multipliers (which add ~0 lift, per benchmark
  lesson #8258).

A tiny shape-compatible fixture for tests lives at
`benchmark/fixtures/longmemeval-sample.json` (3 questions); see
`tests/benchmark-longmemeval.test.mjs`.

## Adding another benchmark (LoCoMo / ConvoMem / MemBench)

The scoring functions of all four are embedding-independent (ID-set or
substring-text match against the dataset's own gold labels), so the same pattern
applies: write `benchmark/<name>.mjs` that maps the dataset's per-question
corpus into `seedDatabase` rows, runs `searchProductionHybrid`, and scores with
`recallAnyAtK`. Replicate each dataset's corpus-construction rule exactly
(LongMemEval = user-turns-only) or the number is not comparable.
