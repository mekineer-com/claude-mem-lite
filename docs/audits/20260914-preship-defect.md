# Pre-ship review — DEFECT lens — v6.9.0+3

**Range**: `d0169eeb..HEAD` (`d0058167fb61a2af6865bab91d0e7282031d432b`), exactly 3 commits
(`d005816`, `11d7f1e`, `b90d4c7`). `git status --short` clean at review start and at review end.

**Where measured**: the extracted tree
`/tmp/claude-1000/-home-ai-dev-claude-mem-lite/009f7c5f-141e-4b4e-a3fc-1744f3748b88/scratchpad/review-defect`
(`git archive HEAD` + symlinked `node_modules`). Every mutation was reverted from a file copy and
each of `cli.mjs`, `install.mjs`, `search-scoring.mjs` verified byte-identical to `git show HEAD:<f>`
afterwards. No file was left in the tree root; the real repo was never mutated.

**Baseline** (extracted tree, `npx vitest run`, 2026-09-14):
`2 failed | 405 passed (407)` files, `2 failed | 6354 passed | 1 skipped (6357)` tests.
Both failures are extraction artifacts, not diff-related — the archive has no `.git`, so
`tests/pre-commit-hook-sync.test.mjs:47` reads an empty `git ls-files -s`, and
`tests/suite-touches-no-repo-files.test.mjs:120` cannot satisfy its adopt premise. Every mutation
run below is compared against this same 2/6354 baseline, so "green" means "returned to baseline".

---

## P1 — `cli.mjs:161` — EPIPE `process.exit(0)` reports SUCCESS for a command that did not finish

`process.stdout.on('error')` maps EPIPE to `process.exit(0)`. A command whose consumer leaves is
killed mid-output and the process then asserts success, regardless of what it had concluded or was
about to conclude.

`doctor` is the live case, and its exit code is its whole product. `install.mjs:2760` sets
`if (issues > 0) process.exitCode = 1;` under a comment (`install.mjs:2756-2759`) that names the
contract by name:

```
// Diagnostic-tool exit-code contract: any ✗-level finding must propagate non-zero
// so CI / wrapper scripts (`claude-mem-lite doctor || alert`) actually trip.
```

and `install.mjs:2749` asserts of a neighbouring edit that "the exit-code contract
`claude-mem-lite doctor || alert` depends on is untouched". This commit touches it.

**Measured**, both arms back-to-back in the same tree, sandboxed `HOME`/`CLAUDE_MEM_DIR`,
`MEM_NO_AUTO_ADOPT=1`:

| arm | command | exit |
|---|---|---|
| shipped | `node cli.mjs doctor` (no pipe) | **1** (28 lines of output, real verdict) |
| shipped | `node cli.mjs doctor 2>/dev/null \| head -1` | **0**, 10/10 runs |
| shipped | `node cli.mjs doctor 2>/dev/null \| head -20` | **0** |
| shipped | `node cli.mjs doctor 2>&1 \| head -1` | **0** |
| listener-removed mutant | `node cli.mjs doctor 2>/dev/null \| head -1` | **1**, 5/5 runs (EPIPE stack on stderr) |

So this round changed `doctor | head -1` from a loud non-zero failure to a silent `0`. The mutant
was produced by deleting exactly the three listener lines (12066 → 11959 bytes, `node --check` OK)
and restored byte-identical.

Mechanism, proven separately — `process.exit(0)` discards an already-recorded verdict:

```
$ node -e 'process.exitCode = 1; process.exit(0)'; echo $?
0
```

**The obvious remedy does not work, and I measured that before proposing it.** Rewriting the line as
`process.exit(process.exitCode ?? 0)` still yields exit `0` for `doctor | head -1` (3/3), because
the EPIPE fires while `doctor` is still printing its checks — *before* `install.mjs:2760` assigns
the verdict at all. The accurate statement of the defect is therefore stronger than "an exit code is
overwritten": **the command is terminated before it can reach a conclusion, and then claims 0.** A
faithful exit is the conventional `128 + SIGPIPE` (141), or restoring default SIGPIPE disposition,
not 0. That candidate remedy did pass the suite (returned to the 2/6354 baseline), so nothing pins
the current shape — the constraint is behavioural, not a test.

**Not reproduced, stated as a negative result** (the brief asked): I found no pending-DB-write or
torn-transaction instance. `better-sqlite3` is synchronous, so a statement in flight completes and
`process.exit(0)` can only land between statements. I checked the two multi-step writers that print:
`adoptOne` writes then logs (`adopt-cli.mjs:152-154`), and `migrateAll`'s non-dry-run loop performs
every removal inside the loop and logs only afterwards (`adopt-cli.mjs:181-208`) — only its dry-run
branch logs per item, and that branch writes nothing. So the damage is confined to the exit code and
to output truncation, which is the intended behaviour.

Non-EPIPE errors are rethrown from inside the listener and become an uncaught exception — equivalent
to the pre-fix unhandled-'error' path. No finding there.

---

## P2 — `search-scoring.mjs:354-357` — the clause copies `demotePinned`'s TRIGGER but not its FLOOR

`demotePinned` has two floors and the asymmetry is deliberate and documented
(`lib/maintain-core.mjs:516`, `PINNED_FLOOR_SQL`):

```
no lesson -> 1
lesson    -> 2   (v3.76.1: keeps eligibility on every importance>=2 injection face)
```

The new exclusion reuses only the trigger half (`inj >= 8 AND cited = 0`) and applies a blanket
refusal to boost. For a **lesson-bearing** row the two rules now disagree: the demote rule says such
a row belongs at 2, and the new clause pins it at 1, where nothing can lift it again because
`demotePinned` only lowers.

**Measured** (probe run against the extracted tree; premises asserted first, counterfactual second):

```
PINNED_INJ_THRESHOLD = 8
PREMISE demotePinned floor for a lesson row:    3 -> 2   (expect 2)  ✓
PREMISE demotePinned floor for a no-lesson row: 3 -> 1   (expect 1)  ✓

lesson row, importance 1, access_count 5, injection_count 9, cited_count 0
  demotePinned changes on it: 0        <- the demote rule does not want it at 1
  after autoBoostIfNeeded:    1        <- SHIPPED: stranded below the declared floor
  after autoBoostIfNeeded:    2        <- clause removed: matches the declared floor
```

The counterfactual arm was the same probe with the four added lines deleted; `search-scoring.mjs`
was restored byte-identical after.

**Population, stated rather than implied.** This is the same rare population the author documents
honestly in the docblock (3 pinned-but-uncited rows, 0 at `access_count >= 2`, on the maintainer's DB
sampled 2026-09-14T20:14:16Z). I did not re-measure incidence and do not claim any. What I do claim
is the composition *within* that population: of the rows `demotePinned` would have moved on the
maintainer's live DB, **16 of 17 were lesson-bearing** (`lib/maintain-core.mjs:538`, the author's own
figure). So where this clause acts at all, the majority sub-population is the one it gets wrong.

Routes by which a lesson row reaches `importance = 1` are narrow but real: an explicit
`update N --importance 1` (which the docblock already discusses as an unfixed design decision — this
is its mirror image), and `restore`, which clamps a missing/out-of-range importance to 1 while
carrying `lesson_learned` through (`mem-cli.mjs:2381`). Nothing backfills `lesson_learned` onto an
existing row — I checked, so the "demoted, then enriched" route does **not** exist.

Remedy shape: exclude only when the row is already at or below its own floor, i.e. reuse
`PINNED_FLOOR_SQL` rather than a blanket `AND NOT (...)`; or scope the exclusion to no-lesson rows.

---

## P2 — `search-scoring.mjs:355` — the threshold boundary is unguarded; both new arms sit one above it

`tests/server.test.mjs:1593` and `:1616` both set `injection_count = PINNED_INJ_THRESHOLD + 1`.
Nothing exercises `injection_count === PINNED_INJ_THRESHOLD`, which is the value the `>=` is
*about*, and which `lib/maintain-core.mjs:521` also treats as in-scope.

**Mutation**: `COALESCE(injection_count, 0) >=` → `>` at `search-scoring.mjs:355`.

- `npx vitest run tests/server.test.mjs` → **104 passed (104)**, GREEN.
- `npx vitest run` (whole suite) → `2 failed | 6354 passed | 1 skipped` — **identical to baseline**, GREEN.

Restored byte-identical. So an off-by-one on the comparator is invisible to all 6357 tests, and its
effect is precisely the defect this commit exists to close, at the boundary value: a row with
`injection_count = 8, cited_count = 0` gets floored by `demote_pinned` and re-promoted by the next
`get`. Importing the constant (which the arms correctly do) protects against the threshold *moving*;
it does nothing about the *comparator*. One arm at exactly `PINNED_INJ_THRESHOLD` closes it.

---

## P2 — `install.mjs:1684-1688` — the new non-ENOENT branch has zero coverage, and is reachable

**Mutation**: rewrite the branch body to `push('ok', 'cli', 'MUTANT-BRANCH-NEVER-ASSERTED', …)` —
i.e. report a broken-but-present CLI as healthy.

- `npx vitest run` (whole suite) → `2 failed | 6354 passed | 1 skipped` — **identical to baseline**, GREEN.

Restored byte-identical. All three new arms pin `PATH` to one empty directory
(`tests/install-ergonomics.test.mjs:449,456`), so the bare name never resolves and every arm lands on
`ENOENT`. The branch added for the *other* two worlds is never entered by any test in the repo.

It is reachable, and the message is correct when it fires — measured with a sandboxed `HOME` and an
absolute `node` path:

```
(a) non-executable file named claude-mem-lite on PATH
    ⚠ CLI: on PATH but "claude-mem-lite --help" failed — spawnSync claude-mem-lite EACCES
(c) executable on PATH that exits 3
    ⚠ CLI: on PATH but "claude-mem-lite --help" failed — Command failed: claude-mem-lite --help
```

Case (c) also confirms the branch is correct for a non-zero exit, where `execFileSync` leaves
`e.code` undefined: `e.code !== 'ENOENT'` is true, which is the wanted arm. So the branch is right
and simply untested — one arm with a `chmod 644` fixture covers it.

---

## P2 — `tests/install-ergonomics.test.mjs:484,495` — two arms depend on a directory the fixture cannot sandbox

`CLI_BIN_DIRS` is `[~/.local/bin, /usr/local/bin]` (`install.mjs:54`) and the new `existsSync` scan
(`install.mjs:1693`) reads **both**. The fixture sandboxes `HOME`, which controls only the first.
`/usr/local/bin` is an absolute machine path, and `npm i -g claude-mem-lite` puts
`claude-mem-lite` there.

The file's own header reasons about exactly this hazard on the *PATH* axis ("a maintainer with a
global `npm i -g claude-mem-lite` would otherwise land in the ✓ branch and make every assertion below
vacuous on exactly one machine") and pins `PATH` to an empty dir to neutralise it. But the fix adds a
second axis — a filesystem scan of two fixed directories — and that one is not neutralised.

**Measured** by redirecting `CLI_BIN_DIRS[1]` to a fixture directory containing a
`claude-mem-lite` symlink (simulating a machine that has a global install), then running the new
describe block:

```
Tests  2 failed | 2 passed | 11 skipped (15)
```

The two failures are `keeps the reinstall remedy when no symlink exists anywhere` (:484) and
`treats a DANGLING symlink as absent` (:495) — both assert `not.toContain('is not on PATH — add it')`,
which a populated `/usr/local/bin` falsifies. Restored byte-identical. They pass here only because
this machine has no `/usr/local/bin/claude-mem-lite` (verified). The premise "no symlink exists
anywhere" is asserted but not established. Fix: make the scanned directories injectable, or assert
the premise (`existsSync('/usr/local/bin/claude-mem-lite') === false`) so a machine that breaks it
reports a skipped/failed premise rather than a mysterious message mismatch.

---

## P3 — `install.mjs:1693-1700` — a DIRECTORY named `claude-mem-lite` gets advice that cannot converge

`existsSync` is true for a directory. With `~/.local/bin/claude-mem-lite` a directory and nothing on
PATH, the new branch prints:

```
⚠ CLI: installed at <home>/.local/bin/claude-mem-lite but <home>/.local/bin is not on PATH
  — add it: export PATH="<home>/.local/bin:$PATH"
```

Adding that directory to PATH does not make a directory executable, so the user follows the advice
and `status` prints the same line. That is the precise failure this commit was written to eliminate —
its own comment (`install.mjs:1673-1674`) says "Advice that cannot converge is worse than the silence
it replaced." Rare state, hence P3, but it is a *new* confident wrong answer where the old code gave
a merely-incomplete one. A `statSync(...).isFile()` test, or checking the executable bit, decides it.

## P3 — `search-scoring.mjs:15-20` — the import-cost comment enumerates the wrong closure

The comment claims `lib/maintain-core.mjs` "pulls only `utils.mjs`, `lib/dedup-constants.mjs` and
`lib/inject-search-core.mjs`". It actually imports five modules — those three plus
**`lib/time-constants.mjs`** and **`lib/db-backup.mjs`** (`lib/maintain-core.mjs:31-32`).

The comment's *conclusion* holds and I verified it rather than assuming: `lib/db-backup.mjs` pulls
only `fs`, `path`, `../utils.mjs` and `./time-constants.mjs`; no module in the closure imports
`better-sqlite3` (the only textual hit, `lib/inject-search-core.mjs:73`, is prose inside a comment);
and nothing in the closure imports `search-scoring.mjs`, so there is **no cycle**. Cost, 5 runs per
arm back-to-back: import of `search-scoring.mjs` median **15.74 ms with** the edge vs **13.78 ms
without** — roughly +2 ms once per process, not per query. Not a hot-path problem.

Flagged anyway because this repo's own doctrine is that an import edge taken for one constant drags
its module's whole load graph (CLAUDE.md, `lib/data-paths.mjs` leaf rule), and a premise stated
wrongly in a comment is the input to the next person's decision (doctrine rule 10). Either correct
the enumeration or move `PINNED_INJ_THRESHOLD` to a leaf.

## P3 — `install.mjs:54` — `CLI_BIN_DIRS` freezes `homedir()` at module load

`uninstall`'s sweep previously computed `join(homedir(), '.local', 'bin')` at call time
(`d0169eeb:install.mjs:1274`); the loop now reads a module-load constant (`install.mjs:1283`).
`install.mjs` is imported in-process by ten test files, so an in-process caller that sets
`process.env.HOME` after import would sweep the wrong directory. No such caller exists today — every
`status`/`uninstall` exercise spawns a subprocess — and the module already does this for
`OLD_DATA_DIR` (`install.mjs:45`),
so this is consistency-with-existing-style, noted rather than argued.

---

## Checked and clean (negative results)

- **Other callers of `autoBoostIfNeeded`**: exactly one in production, `lib/get-core.mjs:186`. No
  other caller's behaviour changes.
- **NULL handling**: `demotePinned` (`lib/maintain-core.mjs:521-522`) and the new clause
  (`search-scoring.mjs:355-356`) both wrap `injection_count` and `cited_count` in `COALESCE(…, 0)`,
  so `NULL` and `0` agree across the two rules. `COALESCE(importance, 1) = 1` already handled NULL.
- **`status` counting / exit code**: `status()` (`install.mjs:1509-1736`) sets no exit code at all —
  the `issues++` accounting lives in `doctor()` (from `install.mjs:1737`). All three new branches
  `push('warn', …)`, the same level the single old branch used. Counting and exit code are unchanged
  in every state, which is the right answer to the question.
- **Dangling symlink**: behaves as the comment claims — `existsSync` follows the link, reads absent,
  falls through to the reinstall remedy. Covered by :495 (modulo the `/usr/local/bin` premise above).
- **`cli.mjs` listener scope**: no module imports `cli.mjs`; the process-level listener cannot leak
  into a vitest worker or the MCP server.
- **Source-assertion arm** (`tests/cli-broken-pipe.test.mjs`): each of the three asserted patterns
  occurs exactly once in `cli.mjs`, so none is satisfiable by an unrelated line or by the docblock
  above the listener. Not vacuous in the way whole-file text scans usually are. It remains three
  independent whole-file matches rather than one windowed match, so it would accept the three
  fragments landing in three unrelated places — noted, not graded.

## Environment notes

- The 2 baseline failures above are extraction artifacts and invalidate none of these findings; every
  mutation verdict is a diff against that same baseline, not against an assumed all-green.
- **Flake**: across 5 full-suite runs in this tree, 1 run reported a third failing file that the
  re-run did not reproduce and that I did not capture by name. I cannot attribute it and am not
  claiming it is related to this diff.
