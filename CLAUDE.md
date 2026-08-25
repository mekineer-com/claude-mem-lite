# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 3.80.0
- **Package manager**: npm
- **Test**: `npx vitest run` (307 test files / 5182 tests, vitest) · **Sandbox install harness** (not in `vitest run`; real `npm i -g` + real MCP stdio, minutes + network): `node tests/sandbox/phaseA-plugin.mjs` / `phaseB-npm.mjs` / `phaseC-update.mjs` — see `tests/sandbox/README.md`
- **Lint**: `npx eslint .`
- **Benchmark**: `node benchmark/benchmark.mjs` (local micro-bench) · `node benchmark/longmemeval.mjs <dataset>` (standard LongMemEval recall, lexical baseline — see `benchmark/datasets/README.md`)
- **Denoising A/B** (evaluate any precision/recall lever BEFORE shipping): `node benchmark/denoise-ab.mjs --save before.json` (control) → apply the change → `node benchmark/denoise-ab.mjs --compare before.json` (verdict). Runs the precision hard-negative, vocab-mismatch paraphrase, AND cjk_mixed suites so a lever's precision gain and recall cost are weighed on one screen — the split that let an OR-BM25 floor ship-then-revert (2026-06-29). Behavioral probes ride the same screen (multiscript guard + cross-source direction + deferred reachability + events end-to-end pipeline); any probe failure overrides the verdict to PROBE-FAIL and exits 1 — "A/B NEUTRAL ≠ safe" on faces the metric suites can't see. Verdict: REJECT / TRADEOFF / NET-POSITIVE / NEUTRAL / PROBE-FAIL.
- **error-recall LIVE replay** (`node benchmark/error-recall-live-replay.mjs [--dump f.json] [--shapes f.json]`): the ruler that closed D#167, and the one to reach for FIRST on this face. No fixture at all — inputs are real failing commands with their real stderr read out of `~/.claude/projects/**/*.jsonl` and filtered through the surface's own `detectBashSignificance().isHardError`; corpus is the live DB, every project with ≥20 rows. Reports the share of injected rows that match NO error term (i.e. admitted on command vocabulary alone) and the share of cases where such a row is TOP-1. **A/B it by flipping `CLAUDE_MEM_ERROR_RECALL_RERANK=off`, not by editing it**, and pass the same `--shapes` file to both arms — the transcript sample grows every session, so a re-extraction between arms silently changes the denominator. It carries a self-check that the membership predicate can return FALSE, because the first version of it could not (see the FTS5 note below) and reported the defect as 0.0%.
- **error-recall calibration** (`node benchmark/error-recall-suite.mjs [--scores|--sweep|--compare]`): denoise-ab **structurally cannot see the error-recall face** — its suites are query→document, while that face's input is a failed command plus its stderr, so a lever there reads NEUTRAL Δ=0 no matter what it does. This is its ruler. `--sweep` is the one to calibrate against: a floor only affects rows that reach the injection cap, so the `--scores` distribution overstates the achievable gain. **Four invariants the suite enforces on itself, each one earned:** (1) every case must pass the real `detectBashSignificance().isHardError` — a case that cannot fire measures a path that does not exist (#10731); (2) the fixture must carry enough filler to keep FTS5's IDF non-degenerate (a small all-one-topic corpus scores every row 0.00, and any floor then removes everything); (3) `--scores` must probe at `floor: 0` and self-checks that it can see below the calibrated value — it once inherited the shipped default and reported the post-gate remnant as the population, making the calibration table unreproducible from its own tool; (4) cases are split into **servable** (the corpus can explain the failure → judged on hit-rate) and **unservable** (it cannot → judged on staying quiet), because with only servable cases present a set-level gate scores identically at every threshold and reads as a no-op. **Standing result (v3.78.0): the |bm25| floor is built, calibrated at 10.5, and OFF by default.** Measured on the live DB at that threshold (8 projects × 9 shapes, 69 firing cases): floor off = 201 injected rows; **set-level = 126 (−37%), 39% of firings silenced**; per-row = 97 (−52%), 38% silenced. Loss concentrates in projects under ~500 observations, which `corpusFloorScale` is documented not to see (it normalises over the whole table, correct for IDF, deliberately project-blind). **The fixture reports the set-level form as a no-op and is wrong** — its hard negatives are constructed to score above 10.5, so it cannot see this cost; two review rounds each caught one level of this same "fixture number standing in for a live one" error. Command words dominating BM25 is a semantic defect and no magnitude gate reaches it → D#167. **D#167 is now closed, and it was filed against the wrong culprit.** Measured over 52 real failing commands (real stderr, pulled from 1110 transcripts, filtered through the real `isHardError`) replayed across 15 live projects: 28 of the 52 name their failure (`ModuleNotFoundError`/`ENOENT`/`JSONDecodeError`) and **25 of those 28 (89.3%) never got that name into the query** — the six-term budget went to the Python banner `traceback,most,recent` and to path fragments (`mnt,data_ssd,dev`). Downstream, 39.2% of injected rows and **42.3% of TOP-1 rows** (the row inlined verbatim into context) matched no error term at all. Two independent defects, and **fixing terms alone does not touch injection**: naming the failure moved cmd-only rows 39.2% → 40.2% (more specific terms match fewer rows, leaving the flat OR *more* room to fill slots with command vocabulary). Shipped: `ERROR_NAMER_RE` (positive pattern for the signal, never a boilerplate stop-list — that enumerates forever) + an error-first rerank that **reorders and never removes** → 22.4% rows / 21.5% top-1, row count unchanged; suite precision 23.1%→34.6%, hit-rate 85.7%→100%. The mandatory-error-term form was rejected on the same sample (−22.4% rows, 21.5% of cases injecting nothing, concentrated in small projects — the floor's failure mode relocated). **Two ruler defects worth remembering:** (1) `SELECT 1 FROM observations_fts WHERE rowid = ? AND fts MATCH ?` **silently drops the rowid constraint** on SQLite 3.53.1 — it is an always-true membership test, and it reported the defect as 0.0%; pull each term's rowid set instead. (2) `ERROR_NAMER_MAX` shipped at 2 on an argument (chained tracebacks) and swept to 1 on data. Residual: the cap evicts the *last* term, which is often the most specific one (a filename lost to a class name) — **that was D#169, and it was built, measured and rejected**: an identifier-first cap (`[._-]`) moved cmd-only rows 22.6% → 35.8% and top-1 21.3% → 33.4% on the live DB, because `[._-]` conflates "discriminative" with "unique to this invocation" — it promotes this run's own filenames (IDF so high they match nothing) and evicts `enoent`/`syscall`, which are exactly what the explaining memories contain. Any retry needs real document frequencies, and `planErrorRecall` is pure with no corpus to count. The negative result lives in the cap's docblock in `bash-utils.mjs`.
- **DB**: better-sqlite3 + FTS5 full-text search
- **Node**: >=20, ESM (`"type": "module"`)

## Health Stack

Used by `/health` skill (gstack). Persisted here so detection skips runtime probing.

- typecheck: (skip — pure JS/ESM, no TS in repo)
- lint: ./node_modules/.bin/eslint .
- test: ./node_modules/.bin/vitest run
- deadcode: ./node_modules/.bin/knip
- shell: shellcheck scripts/post-tool-use.sh scripts/pre-agent-inject.sh scripts/pre-commit.sh scripts/setup.sh

Knip baseline — **measurement contract, read this before comparing any number below (D#161 closed 2026-08-24 by fixing the method, not the discrepancy)**:

1. **Command + context are part of the number.** Measure with `./node_modules/.bin/knip` from the **primary working tree**. A `git worktree add --detach HEAD` checkout reads ~15 LOWER on the same commit with the same binary — reproduced, cause never established (candidates: gitignore evaluation differing per context; `knip.json` listing `tests/**/*.test.mjs` as `entry` while `project` excludes `tests/**`). It is not drift and it is not worth chasing; just never mix the two contexts.
2. **Never attribute a round's delta by subtracting two counts.** Run a **same-tree A/B**: `git show HEAD:<f> > <f>` for only the round's changed files, re-measure, restore, then diff **NAME SETS**. A count subtraction across contexts once read `+14 added` where the true delta was `-1 / +0`.
3. **A count is a smoke alarm; the name set is the evidence.** Treat every historical number in this paragraph as stale until re-measured.

Current (2026-08-24, post-D#154/caliber round, measured per rule 1): **46** unused exports, **0** unused files — and the same-tree A/B per rule 2 returned a **byte-identical name set (+0 / −0)**, so that round added no dead exports (its two new exports, `OBS_ID_DIGITS` and `citationIdRe`, both have real consumers). Earlier line (v3.78.0, 2026-08-24): the working tree measures **46** unused exports and **0** unused files. The +1 against v3.77.0's 45 is `planErrorRecall` in `utils.mjs` — a v2.21 backward-compat re-export that lost its last consumer when `hook.mjs` stopped importing it (the extracted `lib/error-recall-core.mjs` takes it from `bash-utils.mjs`, the canonical source). That puts it in category (a) below alongside the ten other `utils.mjs` re-exports already in the list, so it is **not** removed. The round's own new exports are all consumed; three that were exported by habit and used only inside their module (`DEFAULT_FLOOR_REF_CORPUS`, `floorRefCorpus`, `maxIdf`) plus `ERROR_RECALL_HALF_LIFE_MS` were made module-private rather than carried as a raised baseline (the v3.70.0 precedent, cf. #9675), and `benchmark/error-recall-suite.mjs` was registered in `knip.json`'s `entry` list alongside the other standalone benchmark entry points rather than left reported as an unused file. Earlier line (v3.77.0, 2026-08-22): the working tree measured **45** unused exports, the same number v3.76.2 measured in the same tree shape, and none of that round's three new exports (`findSubagentTranscripts`, `collectSubagentSurface`, `NON_ATTACHMENT_SURFACES`) is in the list — each has a real consumer. Earlier line (v3.76.2, 2026-08-22): the parent commit `2ebc159` measured with the same `./node_modules/.bin/knip` reports **31** unused exports from a `git worktree add --detach HEAD` and **46** from the primary working tree; v3.76.2 itself measures **45** in the working tree (`recallForFile` left the list). A pre-tag review caught the first version of this sentence attributing the 46 to "the same commit" as the 45 — they are the parent and the child. The ~14-name gap is entirely `utils.mjs:12-15`'s backward-compat re-exports (`SYNONYM_MAP` / `FTS_STOP_WORDS` / `CJK_COMPOUNDS` / `expandToken` / `extractCjkSynonymTokens` / `extractCjkLikePatterns` / `TYPE_DECAY_CASE` / `resolveProject` / `_resetProjectCache` / `SECRET_PATTERNS`) plus their `nlp.mjs` / `registry-retriever.mjs` sources. Ruled out: knip cache (no `node_modules/.cache/knip`, and knip v6 has no `--no-cache`), stderr errors (none), untracked files (they would cut the count, not raise it). Not ruled out: gitignore evaluation, and `knip.json` listing `tests/**/*.test.mjs` as `entry` while `project` excludes `tests/**`. Tracked as D#161. **Every historical number in this paragraph is a worktree number**, so a plain working-tree run will read ~15 higher and that is not drift. The gap's composition was enumerated against the 46-name parent run, so treat the name list as indicative rather than exactly 14. **Attribute a round's delta with a same-tree A/B** — swap only the changed files for their HEAD versions, re-run, diff NAME SETS — not by subtracting a worktree number from a working-tree one; this round was misled by exactly that subtraction (it read +14 added; the same-tree A/B showed the true delta, **-1 / +0**, `recallForFile` leaving the list). v3.76.2 same-tree A/B: 46 -> 45 names, zero additions. Earlier line (2026-08-22, post-audit-P2 round): 0 unused files, **31** unused exports — re-measured after this round added `lib/fast-summary.mjs`, `lib/transcript-scan.mjs` and five new exports (`FAST_SUMMARY_LIMITS`, `TRANSCRIPT_CACHE_MAX_BYTES`, `RECOMMEND_MODE_UNIMPLEMENTED`, `getRequestedRecommendMode`, `upsFtsQuery`). NAME SET byte-identical to the previous measurement: zero additions, zero removals — every new export has a real consumer. Earlier line (2026-08-17, post-install-shape round / v3.70.0): 0 unused files, **31** unused exports — re-measured after adding `lib/install-shape.mjs` + `lib/hook-stdout.mjs`, NAME SET byte-identical to the pre-round set. Interim measurement read 34: the three extra were that round's own `DEFAULT_MARKETPLACE` / `DEFAULT_PLUGIN` / `MANAGED_ENTRY_POINTS`, exported by habit and used only inside their module — made module-private rather than carried as new baseline (cf. #9675). Earlier line (2026-08-17, post-e2e-round): 0 unused files, **31** unused exports — measured on the working tree, and the NAME SET is byte-identical to the pre-round measurement (zero additions, zero removals), so the round added no dead exports. The 2026-08-16 line below recorded 32 for the same tree shape; treat every number here as stale until re-measured. Earlier note: 0 unused files, **32** unused exports. Measured, not carried forward: the v3.68.0 batch scored 32 against **33** on the v3.67.0 tag, and a name-set diff between a clean-HEAD worktree and the working tree showed zero ADDITIONS — the single delta is `identifySynonymGroups` LEAVING the list (the new `tests/mcp-nonblocking-llm.test.mjs` imports it). Note the v3.67.0 line below recorded 31 while HEAD actually measured 33; prefer a fresh `npx knip` count over any number written here, and diff NAME SETS rather than counts when attributing drift. Earlier trail: 31→32 on 2026-08-14 (+1 = `BACKUP_EVICTION_GRACE_MS`, v3.63.0 M-9, intentional named constant, category (a)); down from 46 on 2026-07-17, itself down from 53 on 2026-06-29 — dead code cleaned in the v3.43 P3 batch, then OBS_TYPE_ENUM gained real importers in v3.49.0. No invocation-stats/dispatch name is in the list. Two categories:
(a) intentional — v2.21 utils.mjs split backward-compat re-exports + test-only
exports (search-engine.mjs FTS/count helpers, ftsRowToResult) used internally and
by tests; do NOT remove without audit. (b) NOT intentional — the v3 dispatch/
invocation-feedback CRUD in registry.mjs was confirmed dead (0 refs) and DELETED
in 2026-06; if invocation-stats functions reappear in this list they are rot from a
reverted feature, not back-compat. Plus 1 duplicate-name export pair
(FALLBACK_OBS_WINDOW_MS = RELATED_OBS_WINDOW_MS, intentional alias). Treat baseline
as the floor; flag NEW unused exports as PR review signal.

Coverage baseline (2026-08-22, re-measured after the metering + silent-failure batches,
`npx vitest run --coverage`): statements **83.00%** (6804/8197) · branches **77.22%** ·
functions **87.42%** · lines **86.58%**, over all `lib/**/*.mjs` plus the 22 hand-picked
root modules. **The gate now tracks that number**: `vitest.config.mjs` was re-baselined
from 75/75/65 to statements 80 / lines 83 / functions 84 / branches 74 — each ~3 points
under its measurement. It had been left 12 points low after the P2-2 re-scoping, i.e.
coverage could fall by a ninth of the codebase without anything going red; the gate is
verified binding (raising statements to 90 fails the run, 80 passes). Earlier line
(pre-re-baseline): 92 files, statements 82.94% / branches 77.17% / functions 87.27% /
lines 86.55%; and before the re-scoping, 77.47% stmts / 71.72% branch described only the
22 root modules, with `lib/`'s ~70 shipped modules carrying no coverage signal at all.
**The re-scoping did not lower the number, it raised it**: the extracted cores are
better covered than the root modules they were pulled out of, so the audit's premise
(that including `lib/` would force a threshold downgrade) was wrong.
Still **outside** the gate and honest about it: `install.mjs` / `server.mjs` /
`hook.mjs` / `registry*.mjs` (exercised through subprocess E2E, which v8 coverage of
the parent process cannot observe) and `scripts/**` (same reason).

## Architecture

| Module | Role |
|--------|------|
| `cli.mjs` | CLI entry point — routes subcommands to mem-cli.mjs or install.mjs |
| `mem-cli.mjs` | CLI subcommand dispatch: retrieval / write / maintenance / data / insight / adopt families — full command list under Key Patterns |
| `hook.mjs` | Main hook entry — handles session-start/stop/post-tool-use/**post-tool-failure**/user-prompt |
| `lib/tool-refusal.mjs` | Gate on the PostToolUseFailure path — separates a program failing from the agent's own tool chain refusing (sandbox / policy hook / declined permission), plus the interrupt and empty-text gates |
| `hook-context.mjs` | CLAUDE.md context injection, adaptive time windows, token budgeting |
| `hook-llm.mjs` | Haiku-based summarization and title generation |
| `hook-memory.mjs` | Semantic memory injection on user prompt |
| `hook-episode.mjs` | Episode batching for observations |
| `hook-handoff.mjs` | Cross-session handoff state (/clear, /exit continuity) |
| `hook-shared.mjs` | Shared constants/utilities (RUNTIME_DIR, session mgmt) |
| `hook-semaphore.mjs` | Concurrency control for hook execution |
| `hook-update.mjs` | Auto-update via GitHub Releases (24h check, dev-mode skip) |
| `hook-optimize.mjs` | LLM-powered optimization: re-enrich, normalize, cluster-merge, smart-compress |
| `server.mjs` | MCP server — 20 tools total: 9 core exposed via `tools/list` (mem_search/mem_recent/mem_recall/mem_get/mem_save/mem_timeline + mem_defer/mem_defer_list/mem_defer_drop) + 11 hidden-but-callable (mem_delete/mem_update/mem_export/mem_compress/mem_maintain/mem_optimize/mem_fts_check/mem_stats/mem_registry/mem_use/mem_browse). Hidden tools stay routable by exact-name `tools/call`; Claude Code agents reach them via the `claude-mem-lite <cmd>` CLI. Split flag lives in `tool-schemas.mjs`. |
| `registry.mjs` | Resource registry DB schema + CRUD |
| `registry-retriever.mjs` | FTS5 search + BM25 composite scoring + domain filtering |
| `registry-indexer.mjs` | Resource indexing pipeline |
| `registry-recommend.mjs` | Intent-based skill recommendation (shadow-first): 4-gate precision filter over installed skills, append-only shadow log, `Skill`-adoption probe. Funnel reports session-keyed matched precision + per-skill **lift** (P(adopt\|gate PASS) ÷ organic base rate); `computeSweep`/`replayGate` re-run the gate offline at swept (floor,margin) from each reco's logged replay vector (ROC calibration). Mode via `CLAUDE_MEM_RECOMMEND_MODE` (shadow\|off, default shadow; `live` parses but resolves to shadow + warns — Phase 2 unbuilt) |
| `tfidf.mjs` | TF-IDF vector engine — tokenization, vocabulary, vectors, cosine similarity, RRF merge |
| `tier.mjs` | Temporal tier system — activity-based time window classification |
| `schema.mjs` | DB schema definitions and migrations (incl. vocab_state, observation_vectors) |
| `utils.mjs` | FTS query sanitization, synonym expansion, CJK extraction, token estimation |
| `scripts/post-tool-use.sh` | Bash fast pre-filter (~5ms, skips low-value tools) |
| `scripts/user-prompt-search.js` | UserPromptSubmit hook — auto-search memory on user prompts |

## Where new code goes (audit 2026-08-22 P2-7)

The four big files — `mem-cli.mjs` 3366, `install.mjs` 2668, `server.mjs` 2078,
`hook.mjs` 1929 — are **routers and faces, not a split left half-finished**. v2.41 moved
four handlers into `cli/` and stopped; the direction that actually took hold since is a
different one, and it has produced **72 modules under `lib/`**: every piece of logic two
faces share (CLI and MCP, or two hook events) gets extracted into a `lib/*-core.mjs`, and
the big file keeps only argument parsing, rendering, and wiring.

That is the convention, stated so the state stops reading as abandoned work:

- **Shared by two or more faces → `lib/`.** This is what kills the twin-drift defect class
  this project keeps paying for (get-core, registry-core, maintain-core, fast-summary,
  transcript-scan…). Register every new module in BOTH `source-files.mjs` and
  `package.json#files` — a missed registration has shipped a broken tarball three times.
- **Owned by exactly one face → it stays in that face's file.** Moving it buys a file and
  an import, not a guarantee.
- **No standalone split project.** `cli/` stays as it is: `cli/common.mjs` is a shared
  render layer that `server.mjs` also imports, so the directory name is already wrong; a
  further split would spread that confusion rather than resolve it.

Line count is not the trigger — a shared code path is. The four files shrink as cores get
extracted, or they don't, and either is fine.

## Key Patterns

- CLI commands: `claude-mem-lite search|recent|recall|get|timeline|browse|context|save|update|delete|defer|compress|maintain|optimize|enrich|fts-check|restore|export|import|import-jsonl|stats|citation-stats|activity|registry|memdir-audit|adopt|unadopt` (canonical set = `CLI_COMMANDS` in `cli.mjs`; `claude-mem-lite help` for flags)
- Tool name mapping: Claude Code Agent tool = `'Agent'` (not `'Task'`); Skill via `event.tool_input?.skill`
- **`PostToolUse` does NOT fire for a tool call the host marks as failed.** Claude Code delivers those to a *separate* event, `PostToolUseFailure`, **registered since v3.79.0 (D#170)** — before that, `error_recall` was structurally blind to every host-flagged failure and the only "failures" it ever saw were commands that exited **0** while printing error-ish text (the classic shape being `cmd 2>&1 | tail`, where the pipe launders a failure into a success). Verified two independent ways on 2026-08-24: the host bundle 2.1.241 lists `PostToolUseFailure` alongside `PostToolUse` in its event enum with schema in `{hook_event_name, tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?}` / out `{hookEventName, additionalContext?}` — **the failure text is in `error`, there is no `tool_response`**, and `additionalContext` is the injection channel; and a live probe (two genuinely failing Bash calls, one with a full stack frame) left **zero** trace in the episode buffer and the `events` table while the successful calls either side of it were recorded. **Do not try to fix this class by widening `HARD_ERROR_RE`** — that was D#151's plan and every anchor it named (`panicked`/segfault/tsc/gcc/make/go-test/cargo-test/docker/kubectl) measured **zero** gain over 1110 real transcripts, because 89.1% of missed failures never reach that regex at all. Still true and still load-bearing: `hooks/hooks.json` and `install.mjs`'s direct `settings.json` entries are **two separate hook sets** that must be changed together (`tests/audit-silent-20260814.test.mjs` diffs them and is verified binding). The failure path deliberately does **not** feed the episode buffer — episode entries flow into LLM summarisation and the save-nudge, whose behaviour under an influx of failures is unmeasured — and it gates on `lib/tool-refusal.mjs`, because **68.9% of host-flagged Bash failures on this machine are the agent's own guardrails refusing**, not programs failing. Off switch: `CLAUDE_MEM_ERROR_RECALL_ON_FAILURE=off`.
- Tests use `:memory:` DB — schema changes must sync to test files
- FTS5 search: sanitizeFtsQuery (synonym expansion) → BM25 scoring → OR fallback → concept co-occurrence
- Context delivery: SessionStart hook stdout emits the `<claude-mem-context>` block fresh from DB; CLAUDE.md is no longer auto-updated (pre-v2.30 left a stale snapshot here)
- Skill commands (`/search`, `/recall`, `/recent`, `/timeline`) use `!` preprocessing for CLI injection
- Skill recommendation (shadow-first): `CLAUDE_MEM_RECOMMEND_MODE=shadow|off` (default `shadow`; `live` still parses but resolves to shadow with a one-time stderr warning + a `doctor` line — Phase 2 was never built, and an accepted value that silently means something else is worse than an unsupported one). Phase 1 logs would-be recommendations to `RUNTIME_DIR/recommendations/*.jsonl` (zero injection); reco rows carry a CC `session` id + a replay vector (relevance/rel2/intentTop/cooldownTop), adopt rows carry the same `session` so PostToolUse adoptions pair to the reco in-session. Inspect with `claude-mem-lite registry recommend-stats [--days N] [--sweep]`: funnel = session-keyed matched precision + per-skill lift; `--sweep` = offline ROC over (floor,margin). Calibration caveat: shadow adoption is a biased-LOW proxy for live `P(adopt|inject)`, so the flip metric is **lift > 1** (gate beats organic base rate) + per-session PASS density, NOT a raw-precision threshold (single-dev volume never reaches significance). Live injection (UserPromptSubmit, sibling to the T4 explicit-name pointer) is Phase 2. Adoption = `Skill` tool only (`mem_use` is pre-filtered in PostToolUse).

<!-- claude-mem-lite:begin v1 -->
## claude-mem-lite — persistent memory

PreToolUse hooks already run `mem_recall` for past lessons before Read/Edit/Write. The calls worth making proactively:

| When | Call |
|------|------|
| Before Edit/Write | hook already recalled; if a `#NN` lesson was injected, cite `#NN` next time you produce user-visible text (citing = adopting the feedback; uncited lessons decay) |
| After fixing a non-trivial bug | `mem_save(type="bugfix", lesson_learned="<root cause + fix>", importance=2)` |
| After a non-obvious architecture decision | `mem_save(type="decision", lesson_learned="<constraint + tradeoff>")` |
| Deferring to a future session | `mem_defer({title, priority:1|2|3, detail})`; when fixed, add `closes_deferred=[N]` to `mem_save` |
| Looking up past work / history | `mem_search "keywords"` · `mem_recent` · `mem_timeline` |

Path cost is round-trips, not milliseconds: the PreToolUse hook above already recalls (0 calls) — prefer it. For an explicit query, if these `mem_*` tools are deferred behind ToolSearch this session, the Bash CLI (exact path in the detail doc) is one call vs two (ToolSearch + call).

Full tool + CLI tables, citation/decay rules, and save discipline → `.claude/plugin_claude_mem_lite.md`
<!-- claude-mem-lite:end -->

<!-- code-graph-mcp:begin v2 -->
## Code Graph (repo-wide AST index)

AST + FTS + vector index of the whole repo — prefer over multi-round Grep/Read for
structural queries (LSP only sees open files; this sees everything). Fastest path = Bash CLI:

| Intent | Command |
|--------|---------|
| Who calls X / what X calls | `code-graph-mcp callgraph X` |
| Impact before editing a fn | `code-graph-mcp impact X` |
| Unfamiliar dir / module | `code-graph-mcp overview <dir>` |
| Symbol source / signature | `code-graph-mcp show X` |
| Concept search (no exact name) | `code-graph-mcp search "…"` (vector: MCP `semantic_code_search`) |
| grep + AST context | `code-graph-mcp grep "pat" [paths] [-t lang] [-g glob] [-c]` |

Still use Grep for literal strings/regex in non-code files; still Read files you'll edit.
Full command + MCP-tool table: `.claude/plugin_code_graph_mcp.md`
<!-- code-graph-mcp:end -->
