# Issue #39 — does the slash-command half of 8e5efa3 drop useful recall? (blind judgment, 2026-09-29)

8e5efa3 stops path B (`hook.mjs user-prompt`) from searching on prompts with no topic by
construction. The one rule in that set whose by-construction argument is weakest is the
slash-command rule. A skill name can itself be a memory topic (`/converge`), and a command can
carry arguments (`/code-review high main`). On this machine it is also the only rule that
removes observation rows: all 24 prompts the gate empties are slash commands. The transcripts
cannot settle the question (9 pairs, 0 cited, `citation-live-replay --by-admission`,
2026-09-29T16:50Z), so relevance was judged directly.

## Pre-registration (written 2026-09-29T16:43:10Z, before either judge ran)

- **Population:** read-only snapshot 2026-09-29T16:41:22Z, 910 `user_prompts`. Path B's two
  searches were run counterfactually per prompt, and the unit is unique (prompt, row) pairs.
  - REMOVED = pairs 8e5efa3 drops; KEPT = pairs it leaves alone.
  - Obs #398 is excluded: it was saved by the session running the study. (It shows the
    mechanism anyway: its lesson contains "继续", so 13 stored `继续` prompts would have
    injected it.)
  - Path B's exclude sets cannot be reconstructed, so both arms are upper bounds.
- **Judges:** two blind subagents on different models. They were given the request (plus a
  neutral one-line description of each slash command where one exists), the project, and the
  memory. Arms and hypothesis were withheld. Labels: relevant / partial / irrelevant.
- **Primary metric:** share labelled relevant, averaged over the two judges.
  - r_s = REMOVED slash-command pairs; r_k = KEPT pairs.
- **Decision rules:**
  - **D1:** kappa (relevant vs not) < 0.4 → exempt slash commands.
  - **D2:** r_s ≥ 0.5·r_k AND at least 3 removed slash pairs relevant to both judges →
    exempt slash commands.
  - **D3:** otherwise, keep 8e5efa3.

## Result

| arm | pairs | relevant (A / B / both) | relevant, mean | Wilson 95% | relevant or partial | occurrence-weighted relevant |
|---|---:|---|---:|---|---:|---:|
| KEPT, all | 110 | 42 / 37 / 32 | 0.359 | [0.280, 0.457] | 0.691 | 0.376 |
| KEPT, observations | 56 | 18 / 14 / 9 | 0.286 | [0.184, 0.415] | 0.589 | 0.299 |
| KEPT, events | 54 | 24 / 23 / 23 | 0.435 | [0.320, 0.576] | 0.796 | 0.466 |
| REMOVED, slash commands | 28 | 3 / 2 / 2 | 0.089 | [0.020, 0.226] | 0.286 | 0.049 |
| REMOVED, slash without `/loop-testing` | 17 | 3 / 2 / 2 | 0.147 | [0.033, 0.343] | 0.294 | 0.089 |
| REMOVED, events-floor (`1`, `发`) | 7 | 0 / 0 / 0 | 0.000 | [0.000, 0.354] | 0.143 | 0.000 |

`/loop-testing` has no definition left on this machine, so the judges saw only its name. The
second REMOVED row drops it.

**Agreement.** Relevant vs not: 0.890, kappa 0.732. Relevant-or-partial vs irrelevant: 0.945,
kappa 0.886.

**Decision: D3, keep 8e5efa3.**

- kappa is 0.732, above D1's 0.4.
- r_s is 0.089. That is below 0.5·r_k = 0.180.
- Only 2 removed slash pairs are relevant to both judges, short of D2's 3.

The decision holds for either judge alone: A reads 3/28 against 42/110, B reads 2/28 against
37/110.

## What the gate does lose

Both pairs that both judges rated relevant are `/converge` prompts. They surfaced this project's
converge-ledger decision and its prior converge-round fixes: a skill name that is also a memory
topic, which is the case the by-construction argument misses. Across the 28 removed slash pairs
that is 2, over 5 occurrences. If this ever needs recovering, a finer rule is a later decision
with its own measurement, for example searching on the name of a skill invocation. Path A has
never searched slash commands either.

## Caveats

- **Sample size.** n = 28 removed slash pairs. The Wilson upper bound of r_s (0.226) is above
  0.180, so the point estimate decided this, not the interval.
- **Judge B's reasons** mostly restate the rubric ("bears on the request's task or procedure").
  Judge A's are item-specific. Asked afterwards, B said it read and labelled all 145 items itself.
  Its script only wrote the labels out, marking every item not on its relevant or partial lists
  as irrelevant and attaching one fixed reason per label; no keyword or similarity rule assigned
  a label. That is the judge's own account. B's labels agree with A's at kappa 0.73, and the
  decision holds on A alone.
- **Relevance is not use.** It is a judged proxy, on a corpus from one maintainer's machine.
