# Value A/B — does memory injection improve coding outcomes?

claude-mem-lite's retrieval benchmarks (R@10, P@1, MRR, nDCG) measure **retrieval
mechanics** — whether the right rows come back. They do **not** measure whether
injecting those rows changed what Claude did, or whether the change helped. This
harness closes that gap with a controlled, falsifiable A/B.

**Status:** runnable harness + analysis. The full N=30–50 run is a separate,
compute-heavy step (it spawns real `claude` sessions). Dry-run validates the
whole pipeline today; `--live` runs it for real.

## The question

> Does relevant memory injection reduce **repeat-bug recurrence** at **non-positive
> net token cost**, and is the effect **specific to relevant retrieval** (not just
> "any extra context")?

If yes → claim "improves coding outcomes". If recurrence drops but tokens rise →
mixed. If recurrence doesn't drop → the honest state is "improves retrieval
relevance, no measured downstream lift".

## Design (within-task crossover)

Each task runs under three arms on a fresh DB snapshot, N trials each:

| Arm | Injection | Seeded memory |
|---|---|---|
| `control` | none (hooks off) | — |
| `treatment` | full | the task's own captured memory |
| `shuffled` | full | count-matched **irrelevant** memories (negative control) |

The **shuffled** arm is the key guard: if it reduces recurrence as much as
`treatment`, the gain came from extra context priming the model, not from
retrieval — and the claim is confounded.

### Metrics (per run)

- **Repeat-bug recurrence** (primary) — the task's `regressionCheck` exits non-zero
  ⇒ the previously-captured bug came back.
- **Net tokens-to-green** — total tokens, so the injection tax (SessionStart block +
  per-Read/Edit recall) is already inside treatment's number.
- **Tool-calls** — steps to finish.

### Decision rule (falsifiable)

Claim "improves outcomes" **only if** the recurrence-delta 95% CI is entirely below
0 **and** the net-token-delta CI upper bound ≤ 0 **and** the shuffled arm did not
reproduce the effect. Otherwise report mixed / unproven. Implemented in
`lib/stats.mjs::decideOutcome` and unit-tested.

## Layout

```
experiment/
  README.md                 ← this file
  task-schema.json          ← JSON Schema for a task spec
  run-experiment.mjs        ← orchestrator (dry-run default, --live for real)
  analyze-results.mjs       ← results.jsonl → markdown verdict
  lib/
    arms.mjs                ← arm definitions + per-arm env
    seed-db.mjs             ← fresh per-arm DB via the real saveObservation pipeline
    metrics.mjs             ← tokens / tool-calls / recurrence extraction (tested)
    stats.mjs               ← paired deltas, bootstrap CIs, decision rule (tested)
    runner.mjs              ← trial assembler, dependency-injected (tested)
    real-deps.mjs           ← real git/claude/check spawns (validated only via --live)
  corpus/
    *.task.json             ← one file per task
    shuffled-pool.json      ← irrelevant memories for the negative control
```

## Run it

```bash
# Dry run — synthetic data, validates corpus→seed→run→check→analyze end-to-end.
node experiment/run-experiment.mjs
node experiment/analyze-results.mjs            # prints a report marked NOT A RESULT

# Real run — needs `claude` on PATH. Start small.
node experiment/run-experiment.mjs --live --trials 3
node experiment/analyze-results.mjs
```

### Live prerequisites (the deferred run step)

1. **Corpus ≥ ~20 complete pairs** — bootstrap CIs are meaningless on one task.
   See `corpus/README.md` for selection criteria.
2. **Determinism** — set `temperature` low (audit rec P12) before trusting trial
   averages, or raise trial count to average out sampling.
3. **Hook registration** — a live treatment/shuffled run must register the mem
   hooks in the sandbox pointed at the seeded DB. Provide a ready settings.json via
   `CLAUDE_MEM_EXPERIMENT_SETTINGS` (see `lib/real-deps.mjs::writeHookSettings`).
   This is the one integration seam that only a live `claude` can validate.

## What this is not

Dry-run numbers are **synthetic plumbing checks**, never findings — `analyze` marks
them. A real verdict requires the live run on a real corpus. Pair the external
outcome with the internal `claude-mem-lite citation-stats` cite-recall: if
cite-recall is high but outcomes don't move, that empirically confirms the
citation-decay loop optimizes a proxy (audit thesis ALGO-2).
