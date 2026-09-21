# Pre-ship review — CLAIMS lens — v6.9.0+3

**Range**: `d0169eeb..HEAD` (`d0058167fb61a2af6865bab91d0e7282031d432b`), exactly 3 commits
(`d005816`, `11d7f1e`, `b90d4c7`). `git status --short` clean at review start and at review end.

**Claim set**: the three commit bodies plus every comment/docblock the diff ADDS in `cli.mjs`,
`install.mjs`, `search-scoring.mjs`, `tests/cli-broken-pipe.test.mjs`,
`tests/install-ergonomics.test.mjs`, `tests/server.test.mjs`. 47 checkable assertions enumerated.

**Where measured**: all measuring in scratch copies, never in the repo.
`.../scratchpad/review-claims` is the `git archive HEAD` tree (read-only here);
`.../scratchpad/epipe-tree` is a copy of it where every mutation ran. Every mutation was applied
with an assertion that the target text existed, and reverted from a pristine FILE COPY, then
`diff`ed byte-identical against `review-claims/<f>`. The maintainer's DB was opened
`{ readonly: true }` only. Nothing was added to the extracted tree root or to the repo.

**Verdict summary**: 47 claims checked — **11 FALSE**, **4 UNVERIFIABLE**, 32 TRUE.
The two highest-value findings are both of the shape the brief named: a justification written in
passing to replace a withdrawn one, never measured (`demoted_at`, §S12) and a hand-widened scope
that the tool output does not support (`every stdout-bearing command`, §B5).

---

## FALSE

### B4 — "a small output piped to `head -20` never reaches the failing write"

Three copies: commit `b90d4c7` body, `cli.mjs:143-144`, `tests/cli-broken-pipe.test.mjs:8-9`.
Full quote (cli.mjs): *"Measured 20/20 on `| head -1` for every stdout-bearing command, and 20/20
on `| head -20` once output passes the 64 KB pipe buffer (`export`); a small output piped to
`head -20` never reaches the failing write"*.

FALSE. Counter-example measured pre-fix (`git show d0169eeb:cli.mjs`, 782-row corpus, sandboxed
HOME + `CLAUDE_MEM_DIR`, 20 trials):

```
20/20  [export | head -20]      unpiped=947109B
20/20  [stats  | head -20]      unpiped=952B      <- small output, still 20/20
 0/20  [search pipe | head -20] unpiped=1304B
```

`stats` is 952 B — three orders of magnitude below 64 KB — and crashes 20/20. The discriminator is
not the 64 KB pipe buffer: `head -N` closes the read end after N **lines**, and the producer
crashes iff it still has a write pending at that moment. `stats` is 32 lines emitted with DB work
between them; `search` is 21 lines emitted in one batch, so its writes land before `head` exits.
Correct scope: *"an output the producer emits in one batch never reaches the failing write"*.

### B5 — "Measured 20/20 on `| head -1` for every stdout-bearing command"

Two copies: `cli.mjs:140-141`; `tests/cli-broken-pipe.test.mjs:6-7` (*"Measured 20/20 before the
fix on every stdout-bearing command piped to `head -1`"*).

FALSE — overstated. The commit body itself states the true, narrower set ("search / export /
recent / stats / doctor"), which re-derives exactly. Pre-fix, 20 trials each, same sandbox:

```
20/20  search pipe | 20/20  export | 20/20  recent 50 --project seedproj | 20/20  stats | 20/20  doctor
20/20  timeline --project seedproj | 20/20  citation-stats
19/20  browse                                   <- not 20/20
 0/20  help (13942 B) | 0/20  status | 0/20  context | 0/20  memdir-audit | 0/20  get 1,2,3
```

`help` is the sharpest counter-example: 13.9 KB, hundreds of lines, 0/20. Correct scope: the seven
commands measured at 20/20 above; `browse` at 19/20; five stdout-bearing commands never crash.
The commit body's own wording is TRUE; only the two comments generalise past the evidence.

### I4 — "on PATH but exits 1 -> reports the actual failure, not PATH"

Commit `11d7f1e` body, state 5 of the five-state list.

FALSE — overstated. Reproduced with a sandboxed HOME whose `PATH` holds a `claude-mem-lite` stub
that prints `boom: native binding not found` to stderr and exits 1:

```
⚠ CLI: on PATH but "claude-mem-lite --help" failed — Command failed: claude-mem-lite --help
```

What is reported is `e.message`, i.e. THAT the command failed. `execFileSync` puts the child's
stderr on `e.stderr`, which the branch drops — so for the commit's own live example (a broken
native binding) the user gets no diagnostic at all. Correct scope: *"stops naming PATH, and names
the failing command"*. The half that matters ("not PATH") is TRUE.

### I7 — "the only sites are the three `push()` calls themselves"

Commit `11d7f1e`: *"Nothing downstream reads this check's `available` / `linked` detail fields —
grepped, the only sites are the three push() calls themselves."*

The first half is TRUE: `grep -rn "\.available\b"` and `"\.linked\b"` over the tree return no
reader. The enumeration is FALSE twice:

1. `install.mjs:1717-1721` **reads every extra field and republishes it**:
   `const { level, key, message, ...extra } = c; out[key] = { level, message, ...extra };` — that is
   `status --json`, whose stated purpose (install.mjs:1510) is *"so CI / setup scripts can probe
   install state without scraping text"*. `linked` is therefore a NEW key in a machine-readable
   surface, and it is not a `push()` call.
2. `available` appears at FOUR sites, not three: the ok branch `install.mjs:1682`
   (`{ available: true }`) plus the three warn branches (1686, 1699, 1703).

### I8 — "the `claude` and `npm` lookups it also makes"

`tests/install-ergonomics.test.mjs:440-441`: *"Nothing else in `status` needs PATH — the `claude`
and `npm` lookups it also makes are already inside try/catch and degrade to their own ⚠."*

FALSE. `status()` (install.mjs:1509-1733) shells out to exactly two commands:

```
install.mjs:1557  execFileSync('claude', ['mcp', 'list'], …)       <- in try/catch, TRUE
install.mjs:1681  execFileSync('claude-mem-lite', ['--help'], …)   <- the check under test
```

`grep -n "npm"` over the whole function returns nothing. There is no `npm` lookup in `status`. The
conclusion (pinning PATH to an empty dir breaks nothing else) still holds — on one lookup, not two.

### S2 — "the automatic path 'promoted and never demoted' until the two were ordered demote-last"

Commit `d005816` body.

FALSE as a causal restatement. `lib/maintain-core.mjs:44-58` gives two distinct defects:
the automatic path failed because *"`demote_pinned` was in NOBODY's default set, and hook.mjs did
not even import demotePinned"*; the ORDER defect was on *"the two faces that DID wire the op"*
(mem-cli demote-then-boost vs server.mjs boost-then-demote). The fix for the automatic path was
wiring the op in, not ordering it. Correct scope: *"until the op was wired into the default set
and ordered demote-last"*.

### S3 — "measured there at 148/148 rows sitting back at importance>=3"

`search-scoring.mjs:316-317`.

FALSE twice.

1. **The ratio is transposed.** The source (`lib/maintain-core.mjs:52-54`) reads: *"148 rows sat
   demoted-by-citation-decay, never cited, and back at importance>=3 — **148/148 of them
   boostAccessed-eligible (access_count>3)**"*. 148/148 measures boost-eligibility. "148/148 rows
   sitting back at importance>=3" restates the population as if it were the measurement.
2. **The figure was narrowed by this project and the narrowing was not carried.** `CHANGELOG.md:6826`
   — section heading *"a claim in the v3.76.0 notes, narrowed"* — says the 148 figure *"in the
   headline slot … invites 'this fix repairs 148 rows'. It does not."* Re-measured on the same DB:
   178 match the shape, 152 boost-eligible, **only 7 reachable by `demotePinned`**; 94 sit at
   `injection_count = 0`. The new docblock quotes the unnarrowed figure precisely as support for
   the demote/boost interaction — the reading the narrowing rejects. (The unnarrowed copy in
   `maintain-core.mjs` is pre-existing, not this commit's; this commit propagated it to a second file.)

### S12 — "writing it here would evict rows from the pool keyed on its emptiness"

`search-scoring.mjs:336-339` and the commit body, as the stated reason for NOT reusing `demoted_at`.

FALSE — the direction is inverted, and no such pool exists. Every production reference to
`demoted_at` (`grep -rn --include=*.mjs "demoted_at" .`, tests excluded):

```
schema.mjs:371                 ALTER TABLE … ADD COLUMN demoted_at
lib/citation-tracker.mjs:1593  demoted_at = NULL        (updatePromote — cleared on citation)
lib/citation-tracker.mjs:1621  demoted_at = ?           (updateDemote — stamped on rollover)
mem-cli.mjs:2907-2918          SELECT … WHERE demoted_at IS NOT NULL AND demoted_at >= ?   <- only reader
lib/export-columns.mjs:16      comment
```

There is **no** site keyed on `demoted_at IS NULL`. The single consumer is `citation-stats`'
"recently rolled over" report, keyed on the column being NON-empty — so writing `demoted_at` from
`autoBoostIfNeeded` would ADD rows to that report, not evict them from anything. The conclusion
(do not reuse the column) survives; the reason given is the `optimized_at` invariant
(CLAUDE.md: *"filling a column EVICTS the row from whatever pool keyed on its emptiness …
`optimized_at` is the re-enrich pools' flag and nothing else's"*) transposed onto a column that
does not work that way. Correct reason: it would corrupt `citation-stats`' rollover telemetry.

### S13 — "maintain-core pulls only `utils.mjs`, `lib/dedup-constants.mjs` and `lib/inject-search-core.mjs`"

`search-scoring.mjs:15-19` and the commit body.

FALSE — the enumeration misses two of five direct imports:

```
lib/maintain-core.mjs:15  ../utils.mjs
lib/maintain-core.mjs:22  ./dedup-constants.mjs
lib/maintain-core.mjs:29  ./inject-search-core.mjs
lib/maintain-core.mjs:31  ./time-constants.mjs     <- not named
lib/maintain-core.mjs:32  ./db-backup.mjs          <- not named
```

The CONCLUSION survives: the full transitive closure is 16 files, its only bare specifiers are
`fs`, `path`, `node:path`, `node:os`, `child_process`, no file imports `better-sqlite3` (the two
textual hits are a comment and a JSDoc type), and `search-scoring.mjs` is not in the closure — so
"none reaches a native dependency or back to this file" is TRUE and there is no cycle. The
sub-claim "two of which this module already imports" is TRUE of the three named; of the five
actual, three are already imported (add `time-constants.mjs`). The claim "the three
'search-scoring' strings in that graph are all comments" is TRUE and exact —
`lib/inject-search-core.mjs:5` (`//`), `lib/maintain-core.mjs:444` (SQL `--`), `:688` (`//`).

### S17 — "two hand-typed copies of this number is how the v3.76.0 scan-vs-execute drift happened"

`search-scoring.mjs:15-17`, where "this number" is `PINNED_INJ_THRESHOLD`.

FALSE — wrong quantity. The v3.76.0 scan-vs-execute drift was two copies of the **floor**, not the
threshold. `lib/maintain-core.mjs:512-515`: *"v3.76.0 shipped with the floor here and the forecast
in maintenanceStats still hard-coded `importance > 1`"*; `CHANGELOG.md:6843-6848` says the same.
`PINNED_INJ_THRESHOLD` was already a single exported constant then, interpolated at
`maintain-core.mjs:521`. There IS a two-copies-of-this-number incident —
`maintain-core.mjs:819-822`: *"server.mjs rendered the demote_pinned line with a hardcoded `inj>=8`
while mem-cli.mjs interpolated PINNED_INJ_THRESHOLD"* — but that is a report-string divergence from
the 2026-09-02 audit, not the scan-vs-execute drift. Also note `maintenanceStats`
(`maintain-core.mjs:757`) and `demotePinned` (`:548`) are in the SAME file, so "one file over" only
parses as "one file over from `search-scoring.mjs`".

### S20 — "the op that CLAUDE.md lists in the default maintain set"

`search-scoring.mjs:324-325` and the commit body (*"an op CLAUDE.md lists in the default maintain set"*).

FALSE. `grep -in "demote\|boost\|default maintain" CLAUDE.md` returns nothing. CLAUDE.md's only
mention of maintenance is the bare command name `maintain` inside the `CLI_COMMANDS` list
(CLAUDE.md:32). The default set is declared in code: `lib/maintain-core.mjs:59`
`DEFAULT_MAINTAIN_OPS = Object.freeze(['cleanup', 'decay', 'boost', 'demote_pinned'])`. The point
being made (a documented default op was reverted by any read) is stronger against the code
declaration than against CLAUDE.md; it just is not what CLAUDE.md says.

---

## UNVERIFIABLE

### B13m — "in a vitest worker the same write fails SYNCHRONOUSLY"

`tests/cli-broken-pipe.test.mjs:22-25`.

The READING is TRUE and reproduces to the digit. Listener-removed mutant, `stdout.destroy()`
immediately after spawn:

```
IN-SUITE (vitest worker)  doctor {"epipe":false,"outLen":0,"errLen":0,"code":1}   0/5
IN-SUITE (vitest worker)  help   {"epipe":true,"outLen":0,"errLen":1246}          5/5
STANDALONE                doctor {"epipe":true,"outLen":0,"errLen":1071}          5/5
STANDALONE                help   {"epipe":true,…}                                 5/5
```

So the conclusion — a `doctor` arm in this suite would be GREEN on a listener-less build — is
MEASURED and correct, and the console.log-vs-`process.stdout.write` route split is real.
`console.log is constructed with ignoreErrors: true` is TRUE (`node -e "console._ignoreErrors"` →
`true`, Node v26.8.1).

The MECHANISM is not supported by the one probe that asks it directly. A child spawned with the
same shape, writing 50×2 KB and recording whether the failure arrived sync or async, reports:

```
STANDALONE console.log survived writes=50 threwSync=none   /   sync=false async=EPIPE
IN-VITEST  console.log survived writes=50 threwSync=none   /   sync=false async=EPIPE
```

i.e. no synchronous failure was observed inside a vitest worker. Vitest env vars are not the
cause either (`VITEST`, `NODE_ENV=test`, `VITEST_WORKER_ID` injected standalone → still 3/3 EPIPE).
Something about spawning from a worker thread IS load-bearing — the reading proves that — but
"the write fails synchronously there" is an explanation, not a measurement. Recommend: keep the
numbers, drop or re-measure the because-clause.

### S4 — "THE THIRD PROMOTER" / "a THIRD promoter"

`search-scoring.mjs:313`, commit body. No named set in the tree anchors the ordinal. Nine SQL sites
write `importance`; the ones that can RAISE it are `boostAccessed` (maintain-core:493),
`recoverBuriedLessons` (:334, 0→1), `autoBoostIfNeeded` (search-scoring:350) and the LLM writers
(hook-llm:1244, hook-optimize:558/1272). Within the two-op story the docblock tells, `demotePinned`
is a demoter, so `autoBoostIfNeeded` is the SECOND promoter there, not the third.

### B8 — "re-measured at 0/20 on a 782-row corpus"

No artifact retained, and the maintainer's DB holds 68 observations, so the 782-row corpus was
necessarily a sandbox one — consistent with the rest of the commit, not checkable as written.
Independently substantiated: on a freshly seeded 782-row corpus, post-fix `| head -1` is 0/20 on
13 commands (`search export stats doctor help status recent timeline browse context
citation-stats memdir-audit get`), which covers the claimed "all 12 stdout-bearing commands".

### "27/36 under mutation"

Not found. `grep -rn "27/36"` over the extracted tree, `docs/`, `CHANGELOG.md` and
`git log d0169eeb..HEAD -p` returns nothing. The string is not in the commits, the diff, or the
tree, so there is nothing to verify.

---

## TRUE (re-derived, not trusted)

| Claim | Evidence |
|---|---|
| `~20-line stack ending in outVerbatim` | pre-fix `stats \| head -20`: 25-line stderr, top frame `outVerbatim (cli/common.mjs:247)` |
| 20/20 pre-fix on search / export / recent / stats / doctor | see §B5 table |
| 20/20 on `export \| head -20` (947 KB) | measured |
| 0/20 after the fix on all 12 stdout-bearing commands | 13 commands measured 0/20 |
| doctor writes via `console.log` in install.mjs, never through `cli/common.mjs` | mutant stack frame `console.log → ok (install.mjs:1752)` |
| `doctor \| head -1` 10/10 on the mutant, stack ending `console.log → ok (install.mjs:1752)` | 10/10; and **1752 is correct in THIS tree** — it is the `console.log` inside doctor's shadowed `ok` (install.mjs:1750-1753) |
| `status` never reaches a failing write (0/10 on the mutant) | 0/10 mutant, 0/20 pre-fix |
| `search` on an EMPTY data dir emits one line | exactly 1 line |
| in-suite shell-pipe blind, 0/5 on the mutant for BOTH commands | doctor 0/5, help 0/5 |
| in-suite closed-stdout arm 10/10 red on the mutant, 10/10 green with the listener | 10 full runs each way |
| `scripts/post-tool-recall.js` uses a bare `() => {}` swallow | `scripts/post-tool-recall.js:116` |
| `explainBrokenInstall` is the same charter, above the listener | cli.mjs:58 vs cli.mjs:160 ("one screen" is ~102 lines) |
| D#207 is the join()-not-URL rule, pinned by `tests/no-url-module-paths.test.mjs` | `tests/no-url-module-paths.test.mjs:4-5` |
| uninstall swept EXACTLY this pair as an inline literal | the diff replaces `[join(homedir(), '.local', 'bin'), '/usr/local/bin']` at install.mjs:1283 — same two, same order |
| `createCliSymlink`: ~/.local/bin primary, /usr/local/bin fallback, different remedies per branch | install.mjs:637-664 |
| `existsSync` FOLLOWS the link, a deleted target reads as absent | probe: `existsSync(dangling)` false, `lstatSync` truthy |
| No counting change: all three branches `push('warn', …)` | diff; exit code and warning count untouched |
| States 1, 4, 5 verified end to end | reproduced against sandboxed HOMEs (off-PATH link / working / exits 1) |
| `autoBoostIfNeeded` fires from `fetchObsDetail` | `lib/get-core.mjs:180` → `:186`; sole caller |
| "hands the row straight back" is the docblock's own sentence | `lib/maintain-core.mjs:56-57` |
| Reproduced: demote floors 2→1, ONE `get` returns it to 2 | pre-fix `search-scoring.mjs` from `d0169eeb`: `A=2 → demote → A=1 → get → A=2` |
| After: floor holds across two reads; ordinary `importance=1, access_count>=2` still boosts | post-fix: `A=1, A=1` across two gets; `B: 1 → 2` |
| 67 live rows / 3 pinned-but-uncited / 0 at access_count>=2, sampled 2026-09-14T20:14:16Z | readonly handle on `~/.claude-mem-lite/claude-mem-lite.db`: live rows with `created_at_epoch <= 1789762456000` = **67** (68 now, 1 row added since — doctrine rule 2 in action); pinned-but-uncited = **3**; of those `access_count>=2` = **0** |
| `injection_count` does not bump `access_count` | the sole production writer, `hook-memory.mjs:549`, sets `injection_count` and `last_injected_at` only |
| `demoted_at` stamped on rollover, cleared on citation, at citation-tracker.mjs:1593,1621 | 1593 = `demoted_at = NULL` (updatePromote, cleared on citation); 1621 = `demoted_at = ?` (updateDemote, the streak rollover). Both line numbers correct. Note the prose lists the two directions in the reverse order of the two line numbers |
| Both new arms mutation-verified in the two directions | M1 (exclusion dropped): `1 failed \| 103 passed`, the failure is `does not re-promote a row demotePinned floored`. M2 (narrowed to injection_count alone): `1 failed \| 103 passed`, the failure is `still boosts a heavily-injected row that HAS been cited`. Population: `tests/server.test.mjs`, the only test file exercising `autoBoostIfNeeded` |
| `maintain-core.mjs` "states the precedence" | verbatim at `lib/maintain-core.mjs:58`: *"Hence: order matters, and `demote_pinned` MUST come after `boost`."* Not overstated |
| Three touched test files pass at HEAD | `npx vitest run tests/{install-ergonomics,server,cli-broken-pipe}.test.mjs` → 3 files, 121 passed |

---

## Method notes

- One of my own rulers was blind first: the pre-fix arm read 0/20 on every command because the
  pre-fix entry was copied to `cli.mjs.prefix` and Node refused the `.prefix` extension. The
  harness now asserts the command produces >100 B unpiped before counting crashes, and the
  premise fires (`recent` without `--project` emits 52 B and is refused, not silently counted).
- Every mutation asserted its target text existed before writing and was reverted from a pristine
  file copy; `cli.mjs` and `search-scoring.mjs` were `diff`ed byte-identical to the extracted tree
  afterwards.
