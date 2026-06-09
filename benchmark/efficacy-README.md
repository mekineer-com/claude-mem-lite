# Memory-efficacy validation

A three-step rig that answers one question: **does claude-mem-lite's lesson
injection actually make Claude write better code?** — not "does it retrieve the
right memory" (that's `cite-recall.mjs`), but "does seeing the memory change the
code the model ships."

> The full design spec (`docs/superpowers/specs/2026-06-05-memory-efficacy-validation-design.md`)
> and the run artifacts (`tasks/efficacy-*.md/json`) are intentionally local-only
> (git-ignored, per the repo's specs/tasks convention). This README inlines the
> design and the conclusions so the committed tooling is self-explanatory.

## The conclusion (read this first — the experiment already ran)

The instrument is the point; the headline result is settled and lives in memory
(`claude-mem-lite get 8646,8650,8651`). Re-run the rig to **re-measure after a
product change**, not to rediscover these:

1. **Observation cannot identify the effect** (`#8646`). In a fully-dogfooded
   system, injection hits ~every hot file, so treatment is collinear with the
   risk factor by construction — there is no comparable *unexposed hot-file*
   control. The observational DiD is a weak/positive *hint* at best; a severe
   test (revert-a-fix + hidden oracle) is the only valid instrument.

2. **One repo can't supply a multi-commit RCT** (`#8650`). The "Goldilocks"
   funnel — fix touches its own regression test, `git revert -n` applies clean
   at HEAD, single isolable non-schema bug — collapses to ≈1 usable commit here
   (`bac2e85`). Plan within-commit high-k, or widen to many repos, not N=12.

3. **On-topic injection is only ~50% effective at the upper bound** (`#8651`).
   Severe test on `bac2e85` (orphan-recovery-before-delete bug), injection
   verified 8/8 via direct hook probe, k=8/arm: **arm A (lesson injected) 4/8
   pass vs arm C (no injection) 0/8**, Fisher one-sided p=0.0385. The agent that
   *got* a near-verbatim fix still shipped the bug half the time. Since lesson≈fix
   and task≈the same region, this is the maximal-alignment **upper bound** —
   realistic efficacy is ≤ 50%. **The bottleneck is ACTING, not retrieval:** the
   product lever is salience / a forcing-function at the injection point, not
   better search. (`cite-recall.mjs` already shows ~94% file-keyed *seeing*.)

**When to re-run:** after adding a salience/forcing-function at the injection
point, run STEP 3 on `bac2e85` again and check whether arm A moves above 4/8.

## The three steps

| File | Step | What it does | Cost |
|------|------|--------------|------|
| `efficacy-observational.mjs` | 1 — go/no-go gate | Read-only. Mines transcripts + git history: do lesson-injected edits get *fewer* later `fix:` commits than uninjected ones? Reports a hotness-controlled within-file DiD vs a maturation placebo. **Sign-only verdict** — never trusts magnitude; confounded by construction (see #8646). | ~free |
| `efficacy-power.mjs` | 2 — power analysis | Monte-Carlo over the A/C pilot: minimum detectable effect at each (#commits, k) + the Claude-session cost, so step 3 never returns a number it has no power to interpret. Unit of replication = **commit**, not run (no pseudo-replication). | ~free |
| `efficacy-harness.mjs` | 3b — severe test | The real instrument. For each commit in `efficacy-commits.json`: surgical `git revert -n C` reintroduces the bug at HEAD (oracle test kept OUT of the worktree, applied only at scoring), arm A runs with the commit's real lesson seeded in a `CLAUDE_MEM_DIR` sandbox, arm C runs empty, score = bug-set tests green after the edit. Injection is verified per run via a direct hook probe (not CLI recall, which filters differently). | **real Claude sessions** |

`efficacy-commits.json` — the curated Goldilocks commit set (`bac2e85` is the
airtight construction; `3f26b7a`/`aacab0c` are exploratory and may hit revert
conflicts — see #8650). Each entry: `{hash, srcFiles, oracleTest, task, lesson}`.

## Usage

```sh
node benchmark/efficacy-observational.mjs            # human report (--json, --dir=PATH)
node benchmark/efficacy-power.mjs                    # power surface + recommended pilot point (--json)
node benchmark/efficacy-harness.mjs                  # STEP 3 driver — spawns real Claude sessions
```

## Caveats baked into the design

- **Upper bound, not realism.** STEP 3's lesson is derived from the same commit
  whose bug it tests, and the task touches that exact region — lesson↔task are
  near-isomorphic. A positive result means "on-topic injection changes the code,"
  NOT "realistic memory improves coding." A **null** result is the strong outcome.
- **Not a powered hypothesis test.** Pilot scale (one repo, ~1 clean commit)
  cannot reach significance (STEP 2). Treat STEP 3 as a severe test + effect-size
  estimator.
- **`CLAUDE_PROJECT_DIR` must be the repo** in both arms, or `inferProject` keys
  off the `/tmp` cwd and injection is silently empty (bug #8648, baked into the
  harness).

Not wired into CI — this is a research instrument, run on demand.
