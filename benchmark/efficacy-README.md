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

4. **The June-4 4/8 does not survive isolation (D#35 re-measure, 2026-06-13).**
   Under `--isolated` with the model pinned to the same Fable used by the
   baseline (`env: isolated-v2`, k=8/arm, injection verified 16/16):
   **A=0/8, AL(legacy format)=0/8, C=0/8** — Δ(A−C)=0pp, salience-vs-legacy
   indistinguishable at the floor. Mechanism evidence from a kept-worktree
   replica: the session dispatches the **built-in Agent tool** (a `worker`
   subagent with full Bash — `--allowedTools 'Read,Edit'` does not confine it
   under `bypassPermissions`), the worker performs the batching task correctly,
   runs the worktree's (regression-excised) tests for false confidence, and
   ships without restoring the `recoverChildrenOf` calls the injected lesson
   explicitly warns about. With the construction committed (git-diff leak
   closed), the lesson alone moved nothing. Best current estimate: the June-4
   A=4/8 was substantially an artifact of the uncommitted-construction oracle
   leak, and the true clean-environment upper bound on this commit is ~0 —
   strengthening #8651's conclusion (ACTING is the bottleneck) past "50%
   effective" toward "not measurably effective on this instrument". The
   instrument itself now has a floor problem: to discriminate salience formats
   it needs an easier commit set or a tool-confined runner.

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
- **Environment isolation is NOT guaranteed (2026-06-13 contamination diagnosis).**
  `claude -p --allowedTools 'Read,Edit'` does not confine a session whose global
  `~/.claude` config auto-dispatches subagents: an orchestrator-mode setup spawned
  a worker with full Bash, which ran `claude-mem-lite recall/get`, `git diff`
  (reading the construction diff — oracle leak, now closed by committing the
  construction inside the worktree), and `vitest` on the worktree oracle. Two
  consequences: (1) **runs are only comparable under the same global config** —
  the June-4 A=4/8, C=0/8 baseline and any post-config-change run measure
  different systems; a re-measure after a product change must re-run BOTH arms
  in the same session environment; (2) for a clean cell, run with `--isolated`
  (implemented for D#35): the harness builds a throwaway `CLAUDE_CONFIG_DIR`
  containing only the credentials and the two injection-relevant mem hooks
  (PreToolUse `pre-tool-recall.js`, UserPromptSubmit `user-prompt-search.js`)
  wired to this checkout — no global plugins, no orchestrator, no
  subagent-dispatch escape. `setup.sh`/`post-tool-use.sh` are deliberately
  excluded (they hardcode `$HOME/.claude-mem-lite` and would touch live data).
  `--arms=A,AL,C` adds the salience-format comparison in the same env:
  `AL` = arm A under `CLAUDE_MEM_SALIENCE=legacy`. Isolated cells carry
  `env: "isolated-v1"` in `tasks/efficacy-results.json` and must not be pooled
  with non-isolated cells.
- **Ack ≠ comprehension (single-case but vivid, from the same diagnosis).** With
  v2.98 salience the diagnosed agent recalled the full lesson via CLI, declared
  "Lesson #1 applied", and still shipped the bug — it misread recover-before-delete
  as a batching-cascade concern and never called `recoverChildrenOf`. Salience
  moves seeing→engaging; it cannot fix misapplication. Expect the realistic
  ceiling to stay below 100% regardless of injection format.

Not wired into CI — this is a research instrument, run on demand.

## bind forcing-function re-measure (2026-06-22)

Run on the **confined runner** (`benchmark/confine-tools.js` denies Bash|Agent|Task in
the pinned config, so every edit flows through `Edit` and `pre-tool-recall.js` actually
fires — closing the plumbing artifact that floored the 2026-06-13 isolated run).

Arms (same isolated env, `--k=8`):
- `C` empty control · `A` v2.98 ack directive · `F` bind directive + PostToolUse diff
  re-inject (`CLAUDE_MEM_SALIENCE=bind`) · `T` empty sandbox + the fix spelled into the
  task (`requirement`) = gauge sanity.

Run: `node benchmark/efficacy-harness.mjs --isolated --arms=C,A,F,T --k=8 --commit=bac2e85 --model='claude-sonnet-4-6'`

> **Warning:** the harness reads no model from settings.json by default — omitting
> `--model` floors every arm on the `claude -p` CLI default (#8711 isolated-v1 trap),
> so `--model` MUST be passed. Note: `claude-fable-5[1m]` (the #8711 isolated-v2
> baseline model) is unavailable as of 2026-06-22; this measurement uses
> `claude-sonnet-4-6`, which establishes a fresh baseline not directly comparable to
> the historical fable-5 A=0/8 record (caveat #4 above).

Success criteria:
1. Gauge valid iff `T >= 6/8`. If T is low, no arm's 0 is interpretable — fix the cell/runner first.
2. FF signal iff (gauge valid AND) `Δ(F−A) >= +2/8` (`>= +3/8` strong). k=8 → effect-size, no p-value.
3. Honest null: T high but F≈A≈C≈0 → binding doesn't move this failure; report, don't ship the default flip.

Component-2 limit: the diff re-inject only fires for "removed a required reference" lessons.
bac2e85's lesson ("recover referencing rows first") names no identifier that is present-then-removed,
so for this cell the **binding directive (component 1) carries the effect** — the PostToolUse layer
is general insurance for other lesson shapes.

### Contamination found + fixed — the result only became valid after this (2026-06-22)

The FIRST run of the above floored every injected arm (A=0, F=0) for a **third, worse
reason** than the 2026-06-13 plumbing issue: **`probeInjection` poisons the session's
cross-hook dedup.** The probe runs `pre-tool-recall`, which writes the project-scoped
`.claude-mem-injected-<project>` file into the sandbox; the actual `claude -p` session
then reads it and **dedups the lesson away** → the model receives ZERO injection in every
injected arm. The `injected=true` cell flag is misleading — it reflects the *probe*, not
the session. Fixed in `efficacy-harness.mjs` (`rmSync` the sandbox `runtime/` after
`probeInjection`, commit `aaba502`) so the session's first recall injects fresh. Verified
directly: probe → clear → bind recall now emits the lesson + BIND_DIRECTIVE (was empty).
**This very likely also contaminated the caveat-#4 fable-5 A=0/8 run** — re-read that as
"the model never saw the lesson," not "saw and ignored it."

### Result (post-fix, valid — sonnet-4-6, k=8, bac2e85)

**C=0/8 · A=0/8 (v2.98 ack) · F=0/8 (bind FF) · T=8/8 (gauge).** Δ(A−C)=Δ(F−C)=0pp, Δ(T−C)=+100pp.

Honest null (success criterion 3) on a **valid** instrument: injection verified reaching the
model, gauge passes 8/8 (the model+runner+cell *can* produce the fix when the task spells it
out), yet neither the v2.98 ack directive NOR the comprehension-binding bind forcing-function
moves shipped-code correctness at all. Corrected reading of #8711's "ACTING is the bottleneck":
with the lesson now demonstrably seen, the model still doesn't apply it — the gap is
**comprehension/application, not salience/seeing**, so forcing *engagement* (bind) doesn't help.
**Do NOT flip the `CLAUDE_MEM_SALIENCE` default; bind stays opt-in.** Caveat: one cell, one model,
upper-bound — a null here ≠ "bind is useless everywhere" (component 2 never fires on bac2e85;
other lesson shapes untested).
