# Changelog

All notable changes to claude-mem-lite are documented in this file.

## [2.48.0] - 2026-04-24

**Low-risk install + session-start cleanup — install-time prune of stale modules and zero-byte DBs, session-start short-circuit for completed CLAUDE.md legacy cleanup.** Two P1/P2 items from the 2026-04-24 audit: `install.mjs` accumulated stale top-level files from removed modules (`dispatch.mjs`, `dispatch-feedback.mjs`, `dispatch-inject.mjs`, `dispatch-workflow.mjs` removed in v2.20.0; zero-byte `mem.db`/`memory.db`/`registry.db` from pre-consolidation installs); `cleanupClaudeMdLegacyBlock` ran on every SessionStart for 16 consecutive minor versions (v2.30 → v2.47) re-scanning a file that had been cleaned once. Both silent-drag issues — no correctness impact, pure operational hygiene.

### Migration note

Run once on next install (either `npx claude-mem-lite install` or plugin auto-update): prune removes old top-level `.mjs` files not in `SOURCE_FILES` + zero-byte `.db` files (`claude-mem-lite.db` / `resource-registry.db` always preserved). No user action required. Opt-out: not applicable — prune is strictly additive cleanup, and non-empty DB files are never touched regardless of name.

Session-start marker lives at `~/.claude-mem-lite/runtime/.legacy-claude-md-cleaned-<project>`. First SessionStart after upgrade runs the legacy cleanup once, drops the marker, and every subsequent session-start short-circuits. Recovery (if a user manually re-introduces the legacy block): delete the marker file and the next session-start sweeps again.

### Added

- **`install.mjs::pruneStaleInstallFiles(dataDir, sourceFiles) → string[]`** — strict whitelist prune, top-level only (never descends into subdirs). Removes `.mjs` files whose basename is not in `SOURCE_FILES` + 0-byte `.db` files (except `claude-mem-lite.db` / `resource-registry.db`). Symlinks preserved (dev-mode safety). Returns absolute paths of deleted files for logging.
- **`hook-context.mjs::cleanupClaudeMdLegacyBlock`** — idempotent marker in `RUNTIME_DIR/.legacy-claude-md-cleaned-<project>`. First call drops marker on every exit path (found / not-found / CLAUDE.md missing); subsequent calls short-circuit with a single `existsSync` probe.
- **6 new tests:**
  - `tests/install-e2e.test.mjs` (+4): pruneStaleInstallFiles removes dispatch-* stale modules; removes 0-byte non-whitelist DBs while preserving canonical DBs and non-empty stale DBs; does not descend into managed/runtime/scripts/lib subdirs; idempotent + no-op on clean dir.
  - `tests/hook-context.test.mjs` (+2): marker file dropped after first run + short-circuits on second call even when legacy block is re-introduced; marker dropped when CLAUDE.md does not exist (no repeated stat).

### Changed

- **`tests/hook-context.test.mjs`** — beforeEach/afterEach now clear the legacy-cleanup marker so each test exercises the full sweep path.
- **`install.mjs::install()`** — in non-`--dev` mode, after source-file copy completes, calls `pruneStaleInstallFiles` and emits `ok("Pruned N stale file(s): ...")` when any files were removed. Failures are swallowed (prune is best-effort).

### Measurements

- Full test suite: **1921 / 1921** green (was 1915 at v2.47.0 head; +6 net-new).
- Benchmark (`node benchmark/benchmark.mjs`, 30 queries): Recall@10 0.8796, Precision@10 0.9731, nDCG@10 0.959, MRR@10 0.9667 — all unchanged from v2.47.0. P95 latency 0.18ms (v2.47.0: 0.17ms) — inside the 5ms regression gate.
- Expected live-install effect after upgrade: 4 `dispatch-*.mjs` + 3 zero-byte `.db` files pruned from `~/.claude-mem-lite/` on next `install`; session-start marker ends repeated legacy-block regex scan (one-time savings, accrues across every project).

---

## [2.47.0] - 2026-04-24

**P0 audit-driven cleanup — observation_vectors GC, noise-penalty recalibration, LOW_SIGNAL write-side cap.** A full-project audit on 2026-04-24 (54 MB live DB, 3789 obs across 10 projects) surfaced three unrelated-but-compounding problems: the TF-IDF vector table had 5577/6429 (86.75%) dead rows (2839 orphan + 3282 vocab-stale) because `rebuildVocabulary` never pruned old versions and historic migrations ran with FK off; the injection-noise penalty gates (inj≥10 / inj≥20) had never fired in production because actual max injection_count was 9 across 2 months of data; and 341/3789 (9%) LOW_SIGNAL-titled observations carried Haiku-inflated importance=3 despite 339/341 (99.4%) having no lesson and no facts. This release closes all three on the write path so future DBs don't re-accumulate the same debt.

### Migration note

One-shot cleanup runs on first `ensureDb()` after upgrade — idempotent `DELETE FROM observation_vectors` scrubs orphan + stale rows. Expected live-DB reduction: ~54 MB → ~40 MB (based on observed vector-table bloat). No user action required. Opt-out: `CLAUDE_MEM_KEEP_LOW_SIGNAL=1` still preserves pre-P0-3 write behavior for the LOW_SIGNAL cap.

### Schema

- **`schema.mjs` CURRENT_SCHEMA_VERSION 27 → 28.** One-shot cleanup on ensureDb(): `DELETE FROM observation_vectors WHERE observation_id NOT IN (SELECT id FROM observations)` removes orphans. Idempotent — NOT IN is empty on a clean DB.

### Fixed

- **`tfidf.mjs::rebuildVocabulary`** — transactionally `DELETE FROM observation_vectors WHERE vocab_version != ?` so the new version's corpus replaces (not accumulates with) the old. Pre-v2.47: 3282/6429 (51%) of live vectors had stale versions that vectorSearch filtered at query time but still paid the storage cost on every version rebuild.
- **`scoring-sql.mjs::noisePenaltyClause`** — tier-1 gate lowered `inj≥10 → inj≥4`, tier-2 `inj≥20 → inj≥8`. Ratio thresholds (>3, >5) unchanged — ratio remains the primary precision signal. Live distribution at audit: max injection_count=9 across all 3789 active obs, so the v26 thresholds never triggered. Recalibration targets the moderate-noise band where data actually lives (#3518 inj=6 acc=1 ratio=6.0 is the first real hit).
- **`hook-llm.mjs::saveObservation`** — calls new `capNoiseImportance(obs)` before dedup/insert. LOW_SIGNAL title + no lesson + no facts → importance forced to 1 regardless of input. Complements the drop-path (`isNoiseObservation`): drop when narrative is also thin; demote when narrative survives but importance was inflated.
- **`hook.mjs` auto-compress** — added accelerated 7-day window for LOW_SIGNAL + no-lesson + no-facts imp=1 obs, alongside the existing 30-day window for generic imp=1. Lets the projected ~32.5% corpus reduction materialize within a week on live DBs.

### Added

- **`lib/low-signal-patterns.mjs::capNoiseImportance(obs) → number`.** Write-side importance demotion for LOW_SIGNAL titles that lack lesson + facts. Preserves importance when `lesson_learned` is non-'none' or `facts` has ≥1 non-empty string. Non-LOW_SIGNAL titles pass through unchanged.
- **8 new tests:**
  - `tests/tfidf.test.mjs` (+1): rebuildVocabulary deletes stale-version vectors (regression anchor for 3282/6429 stale count).
  - `tests/schema.test.mjs` (+1): initSchema deletes orphan observation_vectors (regression anchor for 2839/6429 orphan count).
  - `tests/low-signal-block.test.mjs` (+6): capNoiseImportance contract — caps LOW_SIGNAL+no-signal, preserves lesson/facts signal, handles 'none' lesson, non-LOW_SIGNAL passthrough, imp=0/1 passthrough.

### Changed

- **`tests/injection-tracking.test.mjs`** — threshold-calibration tests rewritten for new tier boundaries (inj=4 tier-1, inj=8 tier-2). Added live-distribution fixtures (#5588 inj=9 acc=10 ratio=0.9 stays 1.0×; #3518 inj=6 acc=1 ratio=6.0 becomes 0.5×).
- **`tests/hook-llm.test.mjs`** — pre-saved observation fixture now carries a lesson so the new capNoiseImportance gate is bypassed (LOW_SIGNAL+lesson=2 stays imp=2 through enrichment).

### Measurements

- Full test suite: **1915 / 1915** green (was 1907 at v2.46.0 head; +8 net-new; one pre-existing test updated for new cap semantics).
- Benchmark (`node benchmark/benchmark.mjs`, 30 queries): Recall@10 0.8796 (v2.46.0: 0.8796), Precision@10 0.9731 (0.9731), nDCG@10 0.959 (0.959), MRR@10 0.9667 (0.9667), P95 latency 0.17ms (v2.46.0 baseline: 0.24ms, 30× under the 5ms regression gate).
- Expected live-DB effects after first ensureDb() + first session-start: 2839 orphan vectors deleted on open, 3282 stale-vocab vectors deleted on next rebuildVocabulary, 341 LOW_SIGNAL/imp=3 rows + future writes capped to imp=1 and GC-eligible after 7 days.

---

## [2.46.0] - 2026-04-23

**Cross-session memory capture hardening — targeted handoff consume + structural §10 extractor.** A production audit on 2026-04-23 (55MB DB, 115 completed sessions in 7d) surfaced that `session_handoffs` held only 2 rows total — the entire cross-session memory contract was near-empty despite 115 upstream writes. Two cascading bugs: `hook.mjs` wildcard `DELETE ... type = 'exit'` wiped every exit handoff for the project on any continuation-intent prompt, not just the one being injected; and `handleLLMSummary` filled `remaining_items` only when Haiku returned content (34/112 = 30% success in the 7d sample), leaving the "Not done" list invisible for the other 70%. This release fixes both paths without a schema migration — the v3 foundation plan that would have introduced new `tasks`/`lessons` tables is parked pending a 2-week fill-rate measurement on the existing columns.

### Fixed

- **`hook.mjs:966-981` — targeted handoff consume.** `handleUserPrompt` now calls `pickHandoffToInject` to identify the exact row that `renderHandoffInjection` will render, then deletes only that `(project, type, session_id)` row. Pre-fix: the `DELETE ... type = 'exit'` predicate was unscoped by session — any continuation-intent prompt wiped every cross-session handoff the project had accumulated. Post-fix: sibling sessions' exit handoffs remain queryable for future resumes.
- **`hook-llm.mjs:855-868` — Haiku UPDATE preserves structural content.** `handleLLMSummary`'s UPSERT of `session_summaries` changed from raw overwrite to `COALESCE(NULLIF(?, ''), field)` per column. When Haiku returns an empty `remaining_items` / `lessons` / `key_decisions` (a common degraded-return shape), the structural fast-baseline content written earlier in `handleStop` is preserved rather than zeroed.

### Added

- **`lib/summary-extractor.mjs`** — deterministic §10 four-section extractor.
  - `extractTailAssistantText(transcriptPath)` reads the last assistant text block from the Claude Code JSONL transcript.
  - `extractStructuredSummary(text)` pulls `done` / `notDone` / `failed` / `uncertain` from line-start markers: EN `Done:` / `Not done:` / `Failed:` / `Uncertain:` and 中文 `剩下的` / `剩余` / `还剩` / `未完成` / `下次(要做|做|继续)` / `待做` / `未做`. Handles bullet continuations across blank lines; terminates on next header or non-bullet paragraph.
- **`hook.mjs handleStop` fast-baseline wired to the extractor** — before the session_summaries INSERT, the tail assistant message is parsed and the extracted `done` / `notDone` feed `completed` / `remaining_items`; `failed` + `uncertain` join into `notes`. Haiku later enriches narrative fields but, per the UPDATE fix above, cannot erase the deterministic floor.
- **`hook-handoff.mjs::pickHandoffToInject`** — exported pick function factored out of `renderHandoffInjection` so callers can know which row rendered (for targeted consume). `renderHandoffInjection` remains API-compatible as a thin wrapper.
- **18 new tests:**
  - `tests/summary-extractor.test.mjs` (17): EN markers, 中文 markers, blank-line termination, bullet continuation, transcript JSONL parsing, malformed-line resilience, round-trip with real tail text.
  - `tests/handoff.test.mjs` (+3): `pickHandoffToInject` returns the same row `renderHandoffInjection` renders; null parity; 3-session fixture where targeted DELETE consumes only the picked row.
  - `tests/hook-llm.test.mjs` (+1): Haiku empty `remaining_items` does not clobber pre-populated structural content.

### Measurements

- Full test suite: **1907 / 1907** green (was 1889 at v2.45.0 head; +18 net-new).
- Production DB at audit time (projects--mem, 2026-04-23): 2 `session_handoffs` rows vs 115 completed sessions in 7d; 34/112 session_summaries (~30%) had `remaining_items` populated. Post-fix, the write paths are corrected but historical rows are not backfilled — each future `Stop` captures into the existing schema with structural fallbacks. A 2-week re-measurement is the planned input to deciding whether the parked v3 schema (new `tasks` + `lessons` tables) is still needed.

### Parked

- **mem v3 schema foundation** (`docs/superpowers/plans/parked/2026-04-23-mem-v3-schema-foundation.md`) — full plan-eng-review + /autoplan CEO/Eng/DX reviews ran. CEO subagent surfaced a User Challenge: today's structural extractor already writes to existing `session_summaries.completed` / `remaining_items`, so new `done` / `not_done` / `failed` / `uncertain` columns are premature until fill-rate data says otherwise. Decision: ship 2.46 against existing schema, measure for 2 weeks, then re-evaluate.

## [2.45.0] - 2026-04-23

**`discovery/importance=3` over-weighting fix.** Continuing the end-user quality pass from v2.44.0, a stats-level audit of the observation corpus surfaced 100 `discovery/importance=3` rows where 34 (34%) carried `LOW_SIGNAL` titles ("Worked on X", "Reviewed N files: ...") — auto-generated fallback titles Haiku writes when summarization is unavailable. These should have been capped at imp=1 per existing `buildImmediateObservation` logic, but the cap only fired when `computeRuleImportance` returned ≤2: a rule=3 signal (any file matching `schema.*`, `migration`, `auth.*`, `.env`, `.pem`, `.key`) bypassed the cap and leaked through as imp=3. In broad multi-file episodes (e.g. "Worked on 5 files" where one happens to be `schema.js` read alongside 4 others), this produced false-positive critical-importance rows that then dominated scoring (`0.5 + 0.5·3 = 2.0×` composite multiplier) and injection ranking.

### Fixed

- **`hook-llm.mjs:433-460` — `buildImmediateObservation` cap logic closes the rule=3 leak (lesson to save).** Prior behavior: `isReviewPattern → Math.max(2, rule)`, `isLowSignal && rule<=2 → 1`, else → rule. The `else` branch leaked rule=3 for LOW_SIGNAL titles because the prior condition required rule≤2. New behavior:
  - `isReviewPattern` → **imp=2** (was `Math.max(2, rule)` → rule=3 leaked as 3). Review titles are auto-generated from file count; can't distinguish "critical file was the focus" from "one of N read".
  - `isLowSignal && !isReviewPattern` → **rule=3 → 2, rule≤2 → 1** (was: rule=3 → 3, rule≤2 → 1). Rule signals "notable" but title signals Haiku couldn't extract meaning — cap at 2 rather than surface imp=3 without a real title.
  - `!isLowSignal` → rule (unchanged). Real Haiku-generated titles still honor rule=3 when warranted.

### Added

- **4 new regression tests** in `tests/hook-llm.test.mjs` exercising `buildImmediateObservation` directly (now re-exported via named import): (a) review pattern + schema file caps at 2, (b) LOW_SIGNAL title + schema file (rule=3) caps at 2, (c) LOW_SIGNAL + non-critical file (rule=1) stays at 1, (d) LOW_SIGNAL + test-error (rule=3 from bashSig) caps at 2 — covers the non-file path through `computeRuleImportance`.

### Measurements

- Full test suite: **1886 / 1886** green (up from 1882 in v2.44.0: +4 net-new cap tests).
- Production corpus baseline (2026-04-23, `projects--mem`): 34/100 `discovery/importance=3` rows had LOW_SIGNAL titles; 7 `change/importance=3` same. Forward fix stops the leak; existing rows are not backfilled by this change — they decay naturally under the 90-day compression/tier-archive pipeline. Targeted cleanup can run via `mem_maintain execute --ops cleanup --project <name>` in a separate session if desired.

### Design note — Coarse heuristics + degraded signals

`computeRuleImportance` uses file-name regex (`schema.*`, `migration`, `auth.*`) as proxies for "this file matters". Useful in well-summarized episodes but lossy when combined with LOW_SIGNAL auto-titles: a broad multi-file episode incidentally touching `schema.js` while Haiku is rate-limited produces `"Worked on 5 files"` + imp=3 — technically true by rule but indistinguishable from real schema work. This release trades off that false-positive rate for a +1-level cap; if Haiku comes back and writes a real title, the regular path runs and rule=3 is honored. Lesson: when combining heuristic signal layers, each layer's confidence is multiplicative — downgrade the combined output to match the weakest layer rather than summing them.

## [2.44.0] - 2026-04-23

**Hook injection quality pass + carry-over parity fixes.** Running the tool as an end user on an unfamiliar-to-me workflow surfaced a composite-score inflation path: `UserPromptSubmit` hook's OR-fallback branch scores a single-stem match on an `importance=3` bugfix obs past `TOP_REL_FLOOR=50` because the composite multiplier stack (`× decay × type_quality × (0.5+0.5·importance) × noise_penalty`) ≈ 4-6× inflates raw BM25 magnitudes of 19-22 into composite 66-76. Broad multi-topic prompts (e.g. "simulate testing features, find bugs, evaluate coding efficiency") thus surfaced three tangentially-related importance-3 bugfix obs regardless of semantic alignment. New gate ties this closed. Also rolling up three carry-over parity items that had been sitting in the working tree.

### Fixed

- **`scripts/user-prompt-search.js` — OR-fallback raw-BM25 magnitude floor (lesson `#8144`).** `searchByFts` now returns `{rows, mode}` with a `bm25_raw` column alongside the composite `relevance`, and the hook's main flow applies a new `OR_TOP_BM25_FLOOR = 30` (env `CLAUDE_MEM_UPS_OR_BM25_MIN`) that fires *only* when `relaxFtsQueryToOr` was used. Empirical production-corpus distribution (`projects--mem`, 584 obs, 11-prompt probe): real signal `top-|bm25_raw| ≥ 41`, broad/meta noise `≤ 22`, a clean 22→41 gap. AND mode bypasses the gate — AND's all-stems-match constraint is already a precision signal and legitimate hits like `"how does noise penalty work in observation scoring"` score `bm25_raw=19.3` (would be lost under an absolute raw-BM25 gate). Gate piggy-backs on `TOP_REL_FLOOR=0` kill switch: on sparse test corpora (1–2 seeded obs) `|bm25|` collapses to ~4e-6 because FTS5 IDF needs real document distribution, so `runScript`'s existing `CLAUDE_MEM_UPS_TOP_MIN=0` semantic disables both gates together. Pre-fix reproducer: BROAD Chinese prompt surfaced `#7549` (stats test failure) `#7844` (optimize schema) `#5588` (regex fix) — all importance-3 bugfixes sharing one stem. Post-fix: OR path drops, prompt-fallback surfaces context-appropriate prior user questions; GOOD narrow prompts (e.g. `"CLI MCP parity include_noise flag"`) still surface `#8139 / #8126 / #8050` unchanged.
- **`mem-cli.mjs:497-509`, `server.mjs:2176-2195` — `recall` (CLI + MCP) now filters hook-llm fallback titles by default.** Pre-fix: `claude-mem-lite recall mem-cli.mjs` and `mem_recall({ file: 'mem-cli.mjs' })` returned `"Modified X"` / `"Worked on X"` / raw-error-log rows that `search` already filtered — the read-path parity gap called out in lesson `#8139`. Post-fix: both surfaces apply `notLowSignalTitleClause('o')` (same clause `search` uses); new `--include-noise` flag (CLI) / `include_noise: true` (MCP) opts back in for audit/debug workflows. Contract: `tests/contract.test.mjs` asserts `memRecallSchema` accepts `include_noise`; `tests/cli-e2e.test.mjs` asserts noise hidden by default + surfaced under `--include-noise`.
- **`scripts/prompt-search-utils.mjs:13-24` — `shouldSkip` now recognizes pure continuation and meta-pause directives.** Two new regex classes: `CONTINUATION_RE` (`继续 / 接着 / continue / keep going / proceed / more please / ...`) and `META_PAUSE_RE` (`怎么停 / 为什么停 / why did you stop / ...`). Pre-fix: `继续!` or `怎么停下来了？` passed the 8-unit effective-length gate and triggered a full FTS lookup — the hook's stdout landing between an in-flight tool result and the model's next action reads as a turn boundary and biases turn-end (lesson `#8140`). Post-fix: these prompts are skipped entirely. Conservative match: tail content after the directive disqualifies skip (`继续，先做 X 再做 Y` still triggers injection — new instruction is present). 7 new unit tests in `tests/user-prompt-search.test.mjs`.
- **`install.mjs:1208` — doctor dev-drift fix command uses absolute `install.mjs` path.** Pre-fix: the `warn()` line read `(re-run: node install.mjs install --dev)` — a relative path that breaks when the drift is detected from `~/.claude-mem-lite/` or any CWD that isn't the project root; `install.mjs` *itself* being the drifted file made the command self-referential-but-wrong. Post-fix: `(re-run: node /abs/path/to/install.mjs install --dev)` via `join(PROJECT_DIR, 'install.mjs')`. Cosmetic UX fix but the self-referential case was the only repro path, noted in lesson `#8138`.

### Added

- **`scripts/user-prompt-search.js` `OR_TOP_BM25_FLOOR` + `CLAUDE_MEM_UPS_OR_BM25_MIN` env knob** — default 30 (production), auto-disabled when `TOP_REL_FLOOR=0` (test harness). Per-environment tuning documented in the constant block comment.
- **`tool-schemas.mjs` `memRecallSchema.include_noise`** — boolean opt-in for hook-llm fallback titles in MCP `mem_recall`, matching the CLI `--include-noise` shape for `search` / `recall`.
- **Header text refresh: `FYI — Related memories (continue your task)`** replaces the bare `Related memories:` banner on both obs and prompt-fallback output paths. Weak signal but reinforces that the block is context, not a new user turn — cheap complement to the shouldSkip gates (lesson `#8140`).
- **3 new regression tests** in `tests/user-prompt-search.test.mjs` for the OR-BM25 gate: (a) disabled under test-harness default `TOP_MIN=0`, (b) explicit `CLAUDE_MEM_UPS_OR_BM25_MIN=0` kill switch works as independent override, (c) gate fires under production-like config with `TOP_MIN` nonzero.

### Measurements

- Full test suite: **1882 / 1882** green (up from 1874 in v2.43.0: +8 net-new — 3 OR-BM25 gate + 3 shouldSkip skip-pattern + 1 contract include_noise + 1 cli-e2e recall noise-filter).
- Live production-corpus probe (`projects--mem`, 584 obs): 4 BAD OR-fallback prompts now drop to prompt-fallback or empty; 1 GOOD OR-fallback prompt (`"CLI MCP parity include_noise flag"`) surfaces top-5 obs unchanged (composite rel 135 / 110 / 107 / 98 / 92).
- AND-mode scoring path untouched — 1 legitimate AND hit at `bm25_raw=19.3` (`"how does noise penalty work"`) remains surfaced.

### Design note — Mode-aware scoring gates

Composite scoring multipliers are the right place to express "this type/recency/importance should rank higher given a match" but the wrong place to *gate* relevance. When the caller has fallen back to OR semantics (AND returned 0), every matched row is by definition a partial match, and the composite can be dominated by multipliers rather than fit. Separating the two — `relevance` ranks, raw `bm25_raw` gates — lets the ranker stay expressive without leaking inflated weak hits past the floor. AND mode keeps the original composite-only gate because AND's match-all constraint is the precision signal; gating on raw BM25 there would drop legitimate short-title hits. Lesson `#8144` captures this pattern for reuse.

## [2.43.0] - 2026-04-23

**Both known follow-ups from v2.42.0 closed, plus a new bug class surfaced by the user-simulation pass and a Level-2 invariant to keep it closed.** Running `claude-mem-lite` as an end user found two live defects the earlier release had explicitly deferred: (1) `timeline` anchored at a compressed obs produced an asymmetric, unexplained window; (2) `mem_save({ files: [...] })` round-tripped through some MCP bridges as a JSON string and was silently dropped by the strict `z.array(z.string())` schema. Shipping the follow-up from `#8127` in the same release — `mem_get` MCP now accepts the same `P#N` / `S#N` / `#N` prefix tokens as its CLI twin — and adding a round-trip parity harness that locks the Postel's-Law contract for every ID-accepting MCP schema going forward.

### Fixed

- **`mem-cli.mjs:719`, `server.mjs:795`** — `timeline` bare-int `obsExists` fast-path now selects `compressed_into` and routes positive values to the compression parent (`anchored to #P, #N was compressed into it`), negative sentinels (`-1` dropped / `-2` pending purge) surface an explicit "compressed and pruned" error. Pre-fix: `timeline --anchor 7826` (a compressed row) silently anchored on a dead record while the before/after window filters `COALESCE(compressed_into, 0) = 0` — yielding a partial asymmetric window with no note. Post-fix reproduces to `Timeline around #7875 (anchored to #7875, #7826 was compressed into it)`. MCP-side bonus: `server.mjs` widened its `if (typeof anchorId === 'string')` resolution guard to `string | number` so bare-int anchors hit the same compressed check as CLI — previously the numeric MCP path skipped the entire resolution block. Closes the "Known follow-up" #2 from v2.42.0. Lesson `#8131` saved.
- **`tool-schemas.mjs` `memSaveSchema.files` + `memGetSchema.fields`** — bare `z.array(z.string())` used to reject `files: '["a.mjs","b.mjs"]'` (JSON-string shape emitted by some MCP bridges) with `MCP error -32602: expected array, received string`, which Claude then silently retries without the field — producing a saved observation with empty `files_modified` that only surfaces on later inspection. Both fields now route through a new `coerceStringArray` preprocess that accepts native array, JSON-array string, comma-separated string, or bare string; downstream render confirms `files_modified: ["coerce-test.mjs","tool-schemas.mjs"]` survives end-to-end via stdio. Parallel to the pre-existing `coerceIntArray` / `coerceBool` pattern. Lesson `#8134` saved.

### Added

- **MCP `mem_get` accepts `P#N` / `S#N` / `#N` / mixed prefix tokens** (`tool-schemas.mjs`, `server.mjs:925-1040`) — closes the "Known follow-up" #1 from v2.42.0 (the `TODO(#8126)` marker in `tool-schemas.mjs:80` is removed in this diff). Pre-fix: `mem_get({ ids: ['P#3462'] })` hit `MCP error -32602: expected number, received string`; callers had to manually split per-source and pass `source='prompt'`. Post-fix: `mem_get({ ids: ['#8127','P#3462','S#100'] })` buckets each token via its prefix and renders obs/session/prompt sections in one response. Comma-string (`'1,P#2,S#3'`), JSON-array string (`'[1,"P#2"]'`), and bare ints (back-compat) all coerce the same way. Explicit `source` override still wins over per-token prefixes. Missing-ID note now shows bucket-aware prefixes (`#999999`, `P#12`, `S#7`) so the caller sees which source returned nothing. Reachable via every smoke scenario: mix-prefix, comma-mix, JSON-mix, bare-int back-compat, bad-token rejection, explicit-source override.
- **`lib/id-routing.bucketIdTokens(tokens, {explicit, defaultSource})`** — extracted single-source-of-truth bucketing so CLI `cmdGet` (`mem-cli.mjs:599-613`) and MCP `mem_get` handler now delegate to the same function. CLI-only lines removed: 15 LOC of inline per-token parse + per-source dispatch loop, replaced by one call. Applies lesson `#8050` (CLI↔MCP logic must live in `lib/`, not inline).
- **`coerceMixedIdTokens`** (`tool-schemas.mjs`) — preprocess → `z.array(z.string().regex(/^[PpSs]?#?\d+$/))` that accepts array / comma-string / JSON-array-string / single scalar. Keeps each token as a stringified form so the bucketing stage can read its prefix; regex-pipe catches non-renderable garbage at the schema boundary (loud failure, not silent strip).
- **`tests/schema-roundtrip.test.mjs`** (new, 17 tests) — enumerates every token form the CLI/MCP render sites emit (`#N`, `P#N`, `S#N`, lowercase variants, comma-string, JSON-array string) and asserts every ID-accepting MCP schema parses them. This is the Level-2 invariant: if anyone adds a new rendering site later, this test either already covers it or fails with a clear "extend `RENDERED_TOKEN_FORMS`" signal. `memDeleteSchema` intentionally locked to int-only (non-destructive-on-prompt/session by design — `cli.test.mjs:1795-1806` owns the other side of the same contract).
- **3 new CLI regression tests** in `tests/cli.test.mjs` covering mixed-prefix routing through `bucketIdTokens`: per-prefix dispatch (`get '#N,P#N'` resolves obs + prompt in one call), explicit `--source` override wins over per-token prefix, unparseable token tolerance (garbage token logged, valid tokens still resolve).
- **2 new CLI regression tests** for the compressed-anchor path (parent re-anchor emits explanatory note; pruned sentinel surfaces explicit error).
- **8 new contract tests** for `coerceMixedIdTokens` + `coerceStringArray` (native array, comma-string, JSON-string, bare scalar, regex reject).

### Refactored

- **`mem-cli.mjs cmdGet`** (`mem-cli.mjs:599-613`) now delegates bucketing to `lib/id-routing.bucketIdTokens`. Removed inline `parsed + bySrc` loop. Public behavior unchanged — existing CLI tests all green including the `delete/update rejects P#/S#` contract at `cli.test.mjs:1795-1806`.
- **`server.mjs mem_get` handler** (`server.mjs:931-1043`) rewritten from single-source SELECT to per-bucket SELECT + render. Each source section emits its prefix header (`── #N ──`, `── S#N ──`, `── P#N ──`); access_count increment remains obs-only. "No records found in source(s) [X]" error generalized to list queried buckets; four `audit-fixes.test.mjs` assertions updated to the new wording.
- **Intentional contract change** — `memGetSchema.ids` now emits `string[]` (pre: `number[]`). External MCP callers that only *send* args are unaffected; any internal zod-inferred-type consumer sees the new shape. Four pre-existing `contract.test.mjs` assertions updated to reflect the new token contract.

### Measurements

- Full test suite: **1874 / 1874** green (up from 1843 in v2.42.0: +31 net-new — 17 roundtrip + 3 CLI mixed-prefix + 2 CLI compressed-anchor + 3 CLI lifecycle + 8 contract coercion − 2 pre-existing consolidated; 8 assertions updated for new contracts).
- Lint clean on all 8 changed files after one `eqeqeq` fix.
- Live prod DB smoke (stdio against `/server.mjs`): 6/6 `mem_get` scenarios pass (mix-prefix, comma-mix, JSON-mix, bare-int back-compat, bad-token rejected at schema, explicit-source override). `mem_timeline` compressed-anchor routing verified on `#7826` (live compressed obs in `projects--mem`).
- `npm audit --omit=dev`: 0 vulnerabilities.

### Design note — LLM-mediated typed RPC

Running the tool like a real user surfaced a class of failure specific to LLM clients: a strict zod reject produces a *loud* protocol error but a *silent* downstream degradation, because the LLM absorbs the error and retries with fields stripped. The fix pattern — coerce at the boundary, keep tokens in their original shape until the handler, regex-reject only true garbage — is summarized as "tolerant input, strict internal representation" in lesson `#8134`. The `schema-roundtrip.test.mjs` harness is the machine-enforced half of that principle.

## [2.42.0] - 2026-04-23

**Two bugfixes surfaced by an end-to-end user-simulation pass + parity follow-up for MCP.** A fresh round of "use the tool like a user" testing against the CLI and MCP surfaces exposed two reachable UX gaps: (1) `recent` / `timeline` CLI output emitted `#N` tokens with a leading space when the ID had fewer than 5 digits, breaking copy-paste into `claude-mem-lite get`; (2) MCP `mem_timeline` rejected prefixed anchor tokens (`P#N` / `S#N` / `#N`) that the CLI has accepted since v2.39.0 — a reachable CLI↔MCP parity gap in the exact shape called out by lesson `#8050`.

### Fixed

- **`mem-cli.mjs:479,790,843`** — `recent` / `timeline` (both fallback and anchored paths) replaced `` `#${String(r.id).padStart(5)} ...` `` with `` `${('#' + r.id).padEnd(6)} ...` ``. Pre-fix: 4-digit IDs rendered as `# 8121` (padStart inside the token inserts a space between `#` and digits); `claude-mem-lite get "# 8121"` then failed with `Ignoring unparseable ID token(s): # 8121`. Post-fix: token emits `#8121 ` (pad moved to trailing position), column alignment preserved, `#N` paste-safe into every other CLI command. Matches the pre-existing unpadded format in MCP `server.mjs:745` so CLI / MCP output formats now agree. Lesson `#8123` saved for future-session auditability.

### Added

- **MCP `mem_timeline` accepts `P#N` / `S#N` / `#N` prefix anchors** (`tool-schemas.mjs`, `server.mjs`) — restores parity with CLI `timeline --anchor` which has supported the prefixed form since v2.39.0. Pre-fix reproducer: `mem_timeline({ anchor: 'P#3462' })` returned `MCP error -32602: Input validation error: [{ expected: "number", code: "invalid_type", path: ["anchor"] }]`. Post-fix: same call returns `Timeline around #5327 (anchored to #5327, closest obs to P#3462)` with the full timeline window, mirroring CLI semantics (prompt/session anchors resolve to the nearest-in-time observation via `ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1`, project-scoped when `args.project` is set). Bare `#N` / `N` anchors use the same obs-first + prompt/session fallback path as the CLI's bare-int branch. Header emits `anchored to #M, closest obs to X#N` note so callers see the resolution. Plain integer anchors (`anchor: 8121`) are untouched — legacy callers keep working. Lesson `#8126` saved.
- **6 stdio regression tests** in a new `T-anchor-prefix` describe block in `tests/audit-fixes.test.mjs` — seeds 5 obs at known epoch offsets plus one `user_prompts` row at obs#3's epoch and one `session_summaries` row at obs#5's epoch, then exercises `mem_timeline({ anchor: 'P#...' | 'S#...' | '#...' | <int> | 'X#...' (malformed) })` via JSON-RPC against a spawned `server.mjs`. The malformed-prefix test asserts both `resp.result.isError === true` and the error-text regex, locking both the error shape and the message content against future MCP-SDK drift.
- **4 contract tests** in `tests/contract.test.mjs` covering the widened `memTimelineSchema.anchor`: accepts `'#123'` / `'P#456'` / `'S#789'` / `'p123'` (lowercase), rejects `'X#42'` / `'#abc'` / `''`, and preserves the legacy path where plain-int strings (`'42'`) coerce to `number 42`.

### Refactored

- **`parseIdToken` moved from `cli/common.mjs` to `lib/id-routing.mjs`** — applies lesson `#8050` ("extract CLI↔MCP shared business logic to `lib/`; never inline duplicate logic across the two paths"). `cli/common.mjs` now re-exports `parseIdToken` so all 5 CLI call sites (`mem-cli.mjs:25, 603, 686, 1237, 1298`) continue to work unchanged — ESM named re-export preserves live-binding identity, so `===` semantics hold across the module boundary. `server.mjs:30` imports `parseIdToken` directly from `lib/id-routing.mjs` alongside the pre-existing `probeOtherSources`. Re-export scope note in `cli/common.mjs:1-8` updated to explicitly permit `lib/` leaf utilities (previously said "no imports from other cli/ files" which was ambiguous about `lib/`).

### Known follow-ups (explicitly scoped out of this release)

- **`memGetSchema.ids` still rejects `P#N` / `S#N` prefix strings** (`tool-schemas.mjs:80` carries a `TODO(#8126)` marker). CLI `cmdGet` already supports mixed-prefix routing via per-token `parseIdToken` + `bySrc.obs/session/prompt` bucketing (`mem-cli.mjs:599-627`); the MCP handler is single-source and would need a ~40 LOC refactor plus new stdio tests for mixed-bucket render. Intentional deferral — `mem_timeline` and `mem_get` are a workflow pair (the `Workflow:` hint at `server.mjs:747` chains them), so the surprise-gap is visible; the `#8127` follow-up memo records the scope.
- **`obsExists` fast-path ignores `compressed_into`** (pre-existing, mirrored in both CLI `mem-cli.mjs:719` and `server.mjs:792`) — `SELECT 1 FROM observations WHERE id = ?` has no `COALESCE(compressed_into, 0) = 0` filter, so a compressed obs id silently takes the fast-path while surrounding timeline before/after queries *do* filter out compressed items, producing a partial window with no explanation. Flagged during code review of this release; one-line patch per call site. Not in this diff because it pre-dates the release and the fix carries its own behavior-change evaluation.

### Measurements

- Full test suite: **1843 / 1843** green (up from 1834 in v2.41.0: +9 net-new regression guards — 6 stdio + 4 contract − 1 pre-existing test consolidated).
- Lint clean on all 7 changed files.
- Live prod DB round-trip: `anchor='P#3462'` goes from schema-error to `Timeline around #5327` with a full window; `anchor=8121` (int) legacy path byte-identical.
- `npm audit --omit=dev`: 0 vulnerabilities.

### Verification

- Fixture obs (`#8124`) created during round-trip testing was deleted via `claude-mem-lite delete 8124 --confirm` before release; no test data left in the prod DB. Saved lessons: `#8123` (pad-after-ID), `#8126` (schema widen + handler resolution), `#8127` (mem_get deferred + compressed_into follow-up).

---

## [2.41.0] - 2026-04-23

**Architecture audit follow-up — 8 production-quality improvements + partial god-module split.** A comprehensive review of v2.40.0 against production criteria identified 12 recommendations spanning ranking quality, observability, data integrity, and code structure. This release ships the complete A+B set (7 additive improvements) plus the first slice of the god-module refactor (C). 1709 → 1834 tests green (+125 new regression guards).

### Added

- **Schema forward-incompat guard** (`schema.mjs`) — `initSchema` throws on `version > CURRENT_SCHEMA_VERSION`, preventing an older claude-mem-lite from silently re-running old migrations over a DB written by a newer build. Error names the gap and suggests `npm i -g claude-mem-lite@latest` or a fresh `CLAUDE_MEM_DIR`. 2 tests in `tests/schema.test.mjs`.
- **`CLAUDE_MEM_CATCH_SAMPLE` env** (`lib/err-sampler.mjs`) — float in [0,1]. When set, a random fraction of `debugCatch` calls append a JSON line to `$DB_DIR/errors/YYYY-MM-DD.jsonl` (ts / ctx / msg / stack head). Closes the "silently-swallowed column-drift" gap that hid `rebuildVector`'s wrong-column-name bug until R-7 (#7556). Default off — hook hot path pays zero when unset. 9 tests in `tests/err-sampler.test.mjs`.
- **`CLAUDE_MEM_METRICS` env + `lib/metrics.mjs`** — JSONL sink at `$DB_DIR/metrics/YYYY-MM-DD.jsonl`, one row per injection event with `{event, durationMs, candidates, aboveThreshold, returned, orFallback}`. `recordMetric(dbDir, payload)` is the write API, `aggregateMetrics(dbDir, days=7)` computes per-event p50/p95/p99 + error counts. 15 tests in `tests/metrics.test.mjs`. Integrated at `hook-memory.mjs::searchRelevantMemories` (all exit points).
- **`claude-mem-lite doctor --metrics [--days N] [--json]`** — reads the JSONL sink, aggregates, and prints a one-line-per-event summary (or JSON with `--json`). Read-side has no env gate — you can inspect whatever was recorded even when metrics are currently off. Routed via `cli/doctor.mjs`.
- **`MEM_CROSS_PROJECT_BOOST` env** (`hook-memory.mjs`) — float in [0,1], default 0.7 (the pre-v2.41 hardcoded cross-project penalty). Single-project users can set to 1.0 to disable the penalty; multi-project users can tune. Invalid / out-of-range values fall back to default. 4 tests.
- **Benchmark stale-baseline warning** (`benchmark/ci-gate.mjs`) — prints `⚠ STALE BASELINE` on stderr when `benchmark/baseline.json` is older than 30 days (by internal `timestamp` field, falling back to `mtime`). Advisory only — gate continues to run. Current baseline is 71d old; recapture: `node benchmark/benchmark.mjs > benchmark/baseline.json`. 4 tests.
- **Property test for tier parity** (`tests/tier.test.mjs`) — fast-check generates 100 random observation rows covering every branch of the decision tree, asserts `computeTier(row, ctx) === SQL TIER_CASE_SQL result`. Drift guard for the JS/SQL duplication that prior tests only covered with 7 hand-picked samples.

### Changed

- **FTS5 `_au` trigger scoped to indexed columns** (`schema.mjs`, schema v27) — `observations_au` / `session_summaries_au` / `user_prompts_au` now declare `AFTER UPDATE OF <fts_cols>` instead of `AFTER UPDATE`. Pre-v27 any column UPDATE (including `access_count` / `injection_count` / `last_accessed_at` bumps) triggered a wasted FTS delete+reinsert cycle — amplifying `SQLITE_CORRUPT_VTAB` blast radius (`project_non_obvious.md`). Migration detects the legacy unscoped form via `sqlite_master` DDL regex and drops the trigger so `ensureFTS` recreates it with the scoped template. 3 tests cover fresh-DB, sibling triggers, and the legacy-upgrade path.
- **Term-coverage hay expanded** (`hook-memory.mjs::candidateCoverage`) — was `title + lesson_learned`; now `title + subtitle + lesson_learned + first 400 chars of narrative`. Aligns with `OBS_BM25` column weights (title=10, subtitle=5, narrative=5, lesson_learned=8): a row whose only query-term mentions live in narrative no longer drops below the 0.4 threshold just because its title is terse. 2 tests (hay-expansion + null/empty-field edge case) added to `tests/memory-inject.test.mjs`.
- **`tests/test-helpers.mjs::insertObs`** — accepts `subtitle` param (was hardcoded `''`), enabling hay-expansion tests. Default still `''` so existing callers remain byte-identical.

### Refactored (partial god-module split, v2.41 方案 X)

- **`cli/common.mjs`** — shared CLI helpers: `parseArgs`, `out`, `fail`, `relativeTime`, `fmtDateShort`, `parseIdToken`, `formatProbeHints`. Every per-command file under `cli/` imports from here.
- **`cli/fts-check.mjs`** — `cmdFtsCheck` extracted from `mem-cli.mjs`.
- **`cli/doctor.mjs`** — `cmdDoctor` (incl. new `--metrics` flag) extracted.
- **`cli/activity.mjs`** — `cmdActivity` (save/search/recent/show) extracted.
- **`server/fts-check.mjs`** — `handleMemFtsCheck` MCP handler extracted. `registerTool` body becomes a thin delegate.
- **`mem-cli.mjs` 2534 → 2318 LOC** (-216, -8.5%); **`server.mjs` 2317 → 2304 LOC**. Remaining 19 CLI commands + 16 MCP handlers stay in the god modules — future sessions continue the pattern established by these 5 files. Extracted modules added to `source-files.mjs` + `package.json` `files` so auto-update + npm release ship them.

### Fixed

- **Unused imports removed** from `mem-cli.mjs` and `server.mjs` (`checkFTSIntegrity`, `rebuildFTS`) — consumers moved to the extracted handler modules.

### Migration

- Schema v26 → v27 via idempotent trigger rebuild. No data migration; FTS content unchanged. Pre-v27 DBs get the scoped trigger on next `ensureDb()`; fresh DBs get it from the start. Rollback would require reinstating the old wide trigger — the v2.41 guard would then reject the rollback DB on a subsequent v2.41+ open, which is the intended behavior.

### Measurements

- Full test suite: **1834 / 1834** green (up from 1709 in v2.40.0: +125 net-new regression guards).
- Hot-path cost of new env-gated features: **zero** when `CLAUDE_MEM_METRICS` / `CLAUDE_MEM_CATCH_SAMPLE` are unset (early-return before any fs work).
- god-module reduction: `mem-cli.mjs` -216 LOC, `server.mjs` -13 LOC; pattern for remaining 35 extraction targets documented.

---

## [2.40.0] - 2026-04-23

**Two hook-visibility fixes surfaced by an end-to-end QA pass.** (1) `mem_search` / `claude-mem-lite search` silently relaxed strict multi-term AND queries to OR when zero results came back — callers (including Claude Code agents) could not distinguish a genuine strict match from a loose recovery. (2) `PreToolUse` Edit/Write recall injection lacked a framing disclaimer; two observed turn-end incidents traced to the lesson block being misread as a closing note, mirroring `#7758 handoff injection misread as user message`.

### Added

- **AND→OR fallback hint** on `mem_search` (MCP) and `claude-mem-lite search` (CLI). When the FTS5 AND query returns zero and the OR relaxation recovers non-empty, the result header appends ` (relaxed AND→OR)`. Suppressed when the caller explicitly requested OR (`or=true` / `--or`). `searchObservations` in `server.mjs` sets `ctx.orFallbackFired` on OR-recovery; the CLI tracks the same state in a local scoped to the observation branch of `cmdSearch`. `formatSearchOutput` takes a new optional `orFallbackFired` parameter (default `false`) so the existing early-return path for sanitized-empty queries stays byte-identical.
- **6 regression tests** — 3 in `tests/audit-fixes.test.mjs` (MCP: hint on AND→OR, no hint on clean AND, no hint on `or=true`), 3 in `tests/cli-e2e.test.mjs` (CLI parity).

### Fixed

- **`scripts/pre-tool-recall.js`** — `additionalContext` now prepends `[mem] PreToolUse recall — system-injected context, continue your planned action:` to BOTH branches (lessons-found and no-prior-lessons backfill reminder). Without the framing line, two QA sessions stopped mid-task right after Edit tool calls triggered the lesson injection; the block's passive tone read as a turn closer. Same class as `#7758` — any hook output adjacent to tool results needs an explicit "system-injected, not a new turn boundary" preface. 2 regression tests in `tests/pre-tool-recall.test.mjs` assert the framing is present on both branches.

---

## [2.39.1] - 2026-04-23

**Handoff "Unfinished" section no longer mislabels successful release commands as pending.** A resume-session user report flagged three `git push` / `git tag` / `git add` lines from a completed release pipeline showing under `## Unfinished` in the injected `<session-handoff>` block. Root cause: `buildAndSaveHandoff` filtered episode entries with `e.isSignificant || e.isError`, but `isSignificant` has two unrelated origins in `hook.mjs:246` — it is set to true for EDIT_TOOLS invocations (real in-flight work) OR any Bash command that matches `bash-utils.mjs::detectBashSignificance` (git/test/build/deploy), regardless of exit status. A successful `git push` therefore carried `isSignificant=true, isError=false` and was surfaced as pending.

### Fixed

- **`hook-handoff.mjs::buildAndSaveHandoff`** — filter tightened from `e.isSignificant || e.isError` to `e.isError || EDIT_TOOLS.has(e.tool)`. Successful Bash commands (git/test/build/deploy) no longer leak into the pending list; in-flight edits (Edit/Write/NotebookEdit) and surfaced errors still do. Entry shape already carries `tool` in production (`hook.mjs:241`); four pre-existing tests gained explicit `tool: 'Edit'` / `'Bash'` to match.

### Changed

- **Section header rename** — `## Unfinished` → `## Recent activity` in `hook-handoff.mjs::renderHandoffInjection` and inline `- Unfinished:` → `- Recent activity:` in `hook-context.mjs::buildSessionContextLines`. The section mixes in-flight edits with surfaced errors; "Unfinished" was a completeness claim the episode buffer cannot substantiate. Descriptive label removes the mental-model conflict users hit when reading a handoff for a cleanly-`/exit`ed release session.

### Added

- **Regression test** `tests/handoff.test.mjs::buildAndSaveHandoff > successful bash commands (git push, test, build) are NOT pending activity` — snapshot containing only `isSignificant=true, isError=false` Bash entries must not leak `git` / `vitest` descs into the pending portion of `unfinished`.

### Known followups

- `session_handoffs.type='exit'` is written on every Stop hook, not only on real `/exit` — it's the "last Stop snapshot" for the prior CC session, not an exit event. Distinguishing real exit would require wiring CC's `SessionEnd` hook + a schema migration; deferred because current injection semantics (inject the most recent Stop snapshot from a *different* CC session) are what resume actually wants, just under a misleading type tag.
- `age` on injected handoffs measures time since last Stop write, not since user's actual `/exit`. Technically correct but can feel jarring when a session's tail turn took minutes to generate. No threshold gate proposed — auto-suppressing short-gap handoffs risks dropping legitimate same-day resumes.

## [2.39.0] - 2026-04-23

**Term-coverage filter for related-memory injection + timeline bare-int fallback.** An in-session retrospective on a 15-command search chain traced the low efficiency to a single root cause: the UserPromptSubmit hook was injecting rows that shared one FTS token with the user's query but none of the query's actual intent — e.g. query "handoff working_on staleness" returned three rows whose only common token was "handoff". This release adds a post-BM25 filter that drops low-coverage candidates, and fixes an unrelated CLI UX trap surfaced in the same review.

### Added

- **`hook-memory.mjs::candidateCoverage(row, queryTerms)`** — computes the fraction of the query's significant terms (after `tokenizeHandoff` + `HANDOFF_STOP_WORDS` filter + `extractCjkKeywords` for CJK) that appear in the candidate's `title + lesson_learned`. ASCII terms use word-boundary match (`\bfoo\b`) to prevent "race" matching "trace"; CJK terms use substring match because there are no ASCII word boundaries.
- **`MEM_COVERAGE_THRESHOLD` env override** — read per-call via `getCoverageThreshold()`. Default `0.4` (≥40% term coverage); `0` disables the filter entirely for rollback / debugging.
- **4 new test cases** in `tests/memory-inject.test.mjs::v27 term-coverage filter` covering: sparse-title drop, lesson_learned counted toward coverage, skip-when-<2-significant-terms, env-disable.
- **CLI `timeline --anchor N` bare-int fallback** (`mem-cli.mjs::cmdTimeline`) — when a plain integer anchor misses observations, probe `user_prompts` then `session_summaries` and resolve to the nearest-in-time observation, same pattern the explicit `P#N` / `S#N` prefixes already use. Header annotates the conversion: `(anchored to #N, closest obs to P#N)`.
- **2 new test cases** in `tests/cli.test.mjs::CLI timeline anchor prefix routing` covering bare-int → prompt fallback and cross-source not-found message.

### Changed

- **`searchRelevantMemories` post-filter order** — coverage filter runs after the existing BM25+score threshold and before `MAX_MEMORY_INJECTIONS` truncation. Purely read-side; does not touch `injection_count` / `access_count` / noise penalty (so the v2.37.0 noise-ratio signal stays clean).
- **CLI timeline error wording** — `Observation #N not found` → `Observation, prompt, or session with id N not found` when the bare int matches nothing in any table. "not found" phrase preserved for existing error-matcher compatibility.

### Fixed

- The originating trap: query "handoff working_on staleness" previously injected three rows sharing only "handoff" in their titles; with the 0.4 coverage threshold these drop to 1/3 = 0.33 and get filtered, leaving the injection block empty when no high-coverage rows exist — which is the correct signal to steer callers toward `grep` the code instead of rotating mem synonyms.

### Known followups

- MCP `mem_timeline` anchor routing still accepts only plain integers (no P#/S# prefix, no bare-int fallback). CLI↔MCP parity work is deferred; the CLI fix is the higher-impact of the two since it's where users paste IDs from search output.

## [2.38.0] - 2026-04-23

**Prefix-aware ID routing in CLI `get` / `timeline`.** `search` output labels records as `#N` (obs), `P#N` (prompt), `S#N` (session), but `get` defaulted to observations and silently returned "No observations found" when IDs were copy-pasted with prefix — a real session logged 10 failed `claude-mem-lite get` calls to recover 2 records that a single `git log` would have produced. Root cause: "display namespace ≠ query namespace." This release closes that gap end-to-end.

### Added

- **`lib/id-routing.mjs::probeOtherSources(db, ids, excludeSrcs)`** — shared cross-source probe used by CLI `cmdGet` and MCP `mem_get`. When a lookup misses in one source, the probe checks the other two so the response can hint `Try: #1 (obs); P#5 (prompt)` instead of dead-ending. Single SQL layer keeps CLI and MCP from drifting; formatting stays per-call-site.
- **CLI `get` prefix routing** (`mem-cli.mjs::parseIdToken`) — `get P#N` / `get S#N` / `get #N` / `get N` each route to the right table. Mixed prefixes in one call (`get P#1,S#1,#1`) split by source and merge output.
- **CLI `timeline --anchor` prefix routing** — `timeline --anchor P#N` / `S#N` resolve to the nearest-in-time observation (same project when `--project` given); header annotates the conversion: `Timeline around #8103 (anchored to #8103, closest obs to P#5419)`.
- **CLI `delete` / `update` explicit rejection of P#/S#** — previously `parseInt('P#5419')` returned `NaN` and the token was silently dropped into "No valid IDs." Now the command fails loudly: `delete only works on observations. Rejected: P#5419. Prompts and sessions are append-only — inspect with \`mem get P#N --source prompt\` / \`--source session\`.`
- **13 new test cases** in `tests/cli.test.mjs` covering prefix routing, multi-source merge, cross-source hint on miss, `--source` override stripping prefixes, unparseable token warnings, timeline P# anchor resolution, delete/update rejection, and a CLI↔MCP parity assertion on `probeOtherSources`.

### Changed

- **MCP `mem_get` symmetric miss-hint** (`server.mjs`) — before, only `source=session/prompt` returning empty would hint `Try source='obs'`. Now symmetric: `source=obs` with an ID that lives in `session_summaries` or `user_prompts` emits the corresponding hint. Both CLI and MCP route through `lib/id-routing.mjs`, so schema drift surfaces as a failing parity test, not as diverging agent behavior.
- **`mem get --help`** documents the prefix syntax and the `--source` override semantics inline. `mem_get` tool description mentions the `Try: …` hint so LLM callers know to look for it instead of making a second guess.
- **CLI miss-error wording** — old: `No observations found for given IDs`. New: `No records found in source(s) [obs] for the given ID(s). Try: P#5419 (prompt).` Cites the queried source set so ambiguity about what was actually tried disappears.

### Fixed

- Real-DB repro from the originating session: `get P#5419` → previously `No observations found` (misleading — the prompt exists), now returns the prompt text directly. `get 5419` without prefix → previously `No observations found`, now hints `Try: P#5419 (prompt).` The 10-call failure loop collapses to 2 calls.

## [2.37.0] - 2026-04-23

**Injection-noise penalty (P0 of integration audit).** Diagnostic on 30d projects--mem transcripts measured inject-recall at 13.6% (116/850 unique injected IDs ever cited) while inject occurrences hit 2561/30d (~48/session) — oversaturation, not "Claude ignores lessons". This release adds a per-observation noise-ratio penalty that deprioritizes obs auto-injected often but rarely opened/cited.

### Added

- **`scoring-sql.mjs::noisePenaltyClause(alias)`** — SQL CASE expression that shrinks relevance magnitude based on `injection_count` vs `access_count`. Thresholds calibrated from baseline: `>=20 inject AND ratio>5 → 0.2×`; `>=10 inject AND ratio>3 → 0.5×`; else `1.0×`. Applied in `user-prompt-search.js` FTS query and `hook-memory.mjs::searchRelevantMemories`. Cross-session signal: an ID that keeps getting pushed but never used loses BM25 prominence automatically, while heavy-use obs (#5597 29/10 ratio=2.9) stay at full weight.
- **`injection_count` + `last_injected_at` columns** on `observations` (schema v26, additive). `injection_count` bumps only on UserPromptSubmit / hook-memory auto-injection; `access_count` reserved for explicit access paths (Stop-hook citation tracker, `cmdRecall` / `cmdGet` / `cmdTimeline`, pre-tool-recall). This separation is what makes the noise-ratio signal clean.
- **`tests/injection-tracking.test.mjs`** — 12 cases covering migration defaults, penalty at 3 tiers, NULL-safety, accumulation across calls, and demotion ordering in `searchRelevantMemories`.
- **`scripts/p0-forward-probe.mjs`** — audit helper that seeds `injection_count` from transcript scan data into a DB snapshot and reports tier distribution + per-obs penalty. Used to validate that penalty impact is narrow (3/850 tier-2, 14/850 tier-1 on current data) before shipping.

### Changed

- **`hook-memory.mjs` bump semantic (internal, not user-visible)** — auto-injection now bumps `injection_count` instead of `access_count`. Pre-v26 this code path was polluting `access_count` with inject events, which would have broken the noise-ratio signal. `access_count` now reflects only real access (cite / recall / get / timeline / pre-tool-recall), matching the semantic P4 (citation-tracker) established in v2.36.0.

### Migration

- Schema v25→v26 via two additive `ALTER TABLE` statements (guarded for idempotency). No data migration; existing rows get default 0 / NULL. Pre-v26 observations have `injection_count=0` until they get auto-injected again, at which point the penalty begins to apply. The empirical measurement baseline lives at `docs/p0-injection-noise-baseline.txt` and `docs/p0-forward-probe-baseline.txt` for before/after comparison next cycle.

## [2.36.0] - 2026-04-23

**Write-side signal quality (P0-P4).** Diagnostic on projects--mem 30d data found 52% of observations were LOW_SIGNAL auto-titles (`Modified X`, `Error:`, `Worked on`) with empty facts / null lesson — noise that inflates the FTS index and crowds recall. This release blocks them at insert time.

### Added

- **`lib/low-signal-patterns.mjs::isNoiseObservation()`** — write-side filter called from `hook-llm.mjs:saveObservation`. Drops observations where title matches LOW_SIGNAL pattern AND no downstream signal (no lesson, importance<2, empty facts, narrative <40 chars / raw stderr). Expected impact on projects--mem: 30d low-signal drops 164 → ~40-60.
- **`CLAUDE_MEM_KEEP_LOW_SIGNAL=1`** env var — opt-out flag that preserves pre-v2.36 insert-everything behavior. For users who want to audit hook capture end-to-end without the filter.

### Changed

- **Haiku episode prompt (P1)** — added `type:` classifier line with explicit trigger for each type. Concrete decision examples from this project (rejected schema migration, heterogeneous hook events) guide Haiku toward correct `decision` classification. Motivation: 30d `decision` rate was 3.8% (12/315) vs `change` 77% — imbalance attributed to missing classification guidance, not to lack of architectural decisions in the work.
- **`isNoiseObservation` narrative heuristic (P2)** — extends the P0 filter to detect raw tool-output passthrough in narrative: `cmd → output` arrows, stack traces, `node:internal/` paths, diff blocks, test-runner failure banners, or multi-`; ` joined descs with no sentence prose. 30d audit found 19 `Error:` observations (38% of bugfix type) had long but non-substantive narratives that bypassed the initial P0 check — this pattern drives them to 0.
- **Lesson-retry for bugfix/decision (P3)** — if Haiku's first pass writes null/empty/'none' for `lesson_learned` on a `bugfix` or `decision` episode, `hook-llm.mjs` issues one additional `callLLM` with a lesson-focused prompt (root cause for bugfix, tradeoff for decision). Recovered lesson replaces null; "none" retry result is respected. Retry is scoped to bugfix/decision (highest-reuse types, ~72.7% hit-rate vs `change` ~16.5%); `CLAUDE_MEM_NO_LESSON_RETRY=1` disables. Motivation: 30d curated observations were 70% null-lesson (105/151) — Haiku gives up on first pass; a targeted retry recovers real insights.
- **Citation access-count tracking (P4)** — new `lib/citation-tracker.mjs` scans the Claude Code transcript on `Stop` for `#NN` observation-id citations in assistant text, and bulk-increments `access_count` on matched rows (project-scoped). Closes the feedback loop on the CLAUDE.md "cite #NN" contract — previously honored citations were invisible in `mem_stats`; now each cite boosts the cited observation's access-hit counter, keeping useful lessons out of dead-memory sweeps. Opt-out: `CLAUDE_MEM_NO_CITATION_TRACK=1`. FTS5 trigger safety: per-row UPDATE wrapped in try/catch per `project_non_obvious.md`.

### Migration

- Degraded fallback saves (`Modified X`, `Error: X` with no substantive facts/lesson) are now dropped at the hook. Haiku-enriched observations are unaffected. To revert: `export CLAUDE_MEM_KEEP_LOW_SIGNAL=1`.

## [2.35.0] - 2026-04-23

**CLI↔MCP parity + doctor dev-drift detection + injection quality treatments.** Bundles 5 commits since v2.34.6 across three themes: MCP/CLI feature parity, doctor diagnostics, and injection-side quality filtering.

**Data-driven LOW_SIGNAL treatment.** A 30d transcript scan (51 mem-project sessions, 573 injection blocks, 828 unique `#NN` injected, 2408 occurrences) measured cite-precision at 93.3% (335/359 cites matched an injected ID — contract semantics work) but inject-recall at 12.2% (101/828 unique injected IDs ever cited — 88% silent). Root cause was inverted from prior assumption: not "Claude ignores lessons" but "injection picks too many low-relevance IDs". `Codebase exploration:` pattern added to `LOW_SIGNAL_PATTERNS`; 3 deprecated-topic observations (dispatch architecture, E2E timeout analysis, dispatch-fixes migration) superseded in DB. Main injection paths (`hook-memory.mjs`, `pre-tool-recall.js`) were already filtering via `notLowSignalTitleClause` — the measurement ruled out a planned 3-4h Stop-hook measurement infra.

### Added

- **`mem_search` MCP**: `or` parameter for OR-mode search (previously CLI-only).
- **`mem_stats` MCP**: `mode=quality` exposes lesson-rate / LOW_SIGNAL-ratio / type-breakdown (previously CLI-only).
- **`lib/stats-quality.mjs`**: shared quality-stats module consumed by both CLI (`mem-cli.mjs`) and MCP (`server.mjs`).
- **`claude-mem-lite doctor` dev-drift detection**: flags symlink + plain install mix (`lib/doctor-drift.mjs`).
- **MCP server-side instructions trace**: `[mem] instructions: <mode> reason=<why>` on stderr so client-side trace captures routing decisions.
- **`lib/low-signal-patterns.mjs`**: single-source module for 13 patterns (β refactor per #8058). `utils.mjs` regex / `scoring-sql.mjs` NOT LIKE / `scripts/pre-tool-recall.js` all derive from one list.
- New LOW_SIGNAL pattern: `Codebase exploration%` — exploration-type auto-titles bypass the filter no longer.

### Changed

- **`scripts/pre-skill-bridge.js:76`**: truncated-skill prompt uses `Read("<portablePath>")` instead of `mem_use(name=...)`. Decouples skill-bridge from the `mem_use` MCP tool (30d=0 agent calls), preparing for hidden-MCP surface shrink in a follow-up.

### Fixed

- **`scripts/pre-tool-recall.js` Edit-path fallback (Bug 4)**: LOW_SIGNAL title filter now applies to the type-OR fallback too (bugfix/decision-without-lesson fork previously bypassed the filter).
- **`hook-llm.mjs:buildDegradedTitle`**: dedup basenames before slice — previously when same basename appeared multiple times in `files_modified`, the slice kept duplicates and dropped signal.
- **`claude-mem-lite doctor` dep checks**: use import probe, not path check — import can fail even when path exists (SDK version drift / transitive-dep corruption invisible to `fs.existsSync`).

### DB side-effect (one-shot)

- `UPDATE observations SET superseded_at = now` on #983 (Dispatch System Architecture — v2.20 removed), #3320 (E2E test timeout analysis — one-shot historical), #5553 (dispatch-fixes.md migration note).

### Measurements

- Full test suite: 1709 / 1709 green across all 5 commits (CI verified at `4637b99` / `0325ec5`).
- 30d transcript scan script preserved at `/tmp/p14-p15-scan.mjs` (per `#8062` lesson) — reusable for future injection-quality audits.

## [2.34.6] - 2026-04-22

PreToolUse gains **Read-side recall** with asymmetric quiet-mode. When Claude Reads a file (the exploration phase before deciding what to edit), one top-matching lesson is injected if the file has a lesson-bearing observation — otherwise silent. Edit/Write behavior is unchanged. Addresses the audit finding that lessons appear only AFTER the decision to Edit, missing the planning-Read window where the guidance is most useful.

**Data-driven design.** A tree-walk over `projects--mem` measured Read-side hit rate (importance≥2 + lesson_learned REQUIRED) by file category: `core` .mjs 36.2% (17/47), `scripts/` 25.0%, `config` 23.1%, `tests/` 16.1%, `docs/*.md` 4.7% (3/64). Overall 16.9% (36/213) — low enough that exploration Reads of docs/configs rarely trigger, high enough that implementation Reads of core files usefully surface lessons. Estimated net-new load for a typical implementation session: ~3.6 Read injections × ~60 tokens = ~220 tokens (0.02% of a 1M window).

**Asymmetric filter, not a new gate.** Edit/Write keep their existing treatment (top-3, `lesson_learned` OR `bugfix/decision` type, 240-char truncation, `/lesson` nudge on empty). Read tightens: (1) `lesson_learned` REQUIRED — drops type-only rows that add context noise to passive reads, (2) top-1 — single most-actionable hit, (3) 120-char truncation — half the per-row cost, (4) silent on empty — no `/lesson` nudge since Read is passive and the agent isn't necessarily about to solve anything. Rationale: Read events have lower per-event actionability than Edit events; investing less context per Read is proportional. Follows the #7877 "heterogeneous scorings don't share thresholds" principle.

**Cooldown is shared.** The existing v2.33.1 per-filePath session-scoped cooldown applies to BOTH branches — so Read→Edit on the same file in the same session injects exactly once (the Read). This means the **net-new load comes only from files that are Read but never Edited**; Read→Edit sequences just shift the injection moment earlier without doubling it. 1683 → 1688 tests green (+5 integration tests).

### Changed

- **`scripts/pre-tool-recall.js`**: reads `tool_name` from the event; branches on `isRead = toolName === 'Read'`. Read path uses tighter WHERE clause (`AND o.lesson_learned IS NOT NULL AND o.lesson_learned != ''` — drops type-OR fallback), `LIMIT 1`, 120-char truncation, silent-on-empty (skips the `/lesson` nudge). Same-shape change applied to the events-table query (`body IS NOT NULL AND body != ''`, `LIMIT 1`). Cooldown write applies on all paths including silent-Read so subsequent calls on the same file skip.
- **`install.mjs:492`**: matcher extended from `'Edit|Write|NotebookEdit'` to `'Edit|Write|NotebookEdit|Read'`. Comment block documents the asymmetric quiet-mode.
- **`hooks/hooks.json:23`**: same matcher update (marketplace-shipped source of truth, even though install.mjs-managed settings.json is authoritative at runtime — per #8).

### Added

- **`tests/pre-tool-recall.test.mjs` 5 new integration tests.** (1) Read + file with lesson → top-1 injection with most-recent-first ordering (ordering regression guard). (2) Read + file with only type=bugfix no-lesson → silent (tighter-filter regression guard — Edit would fire, Read must not). (3) Read + no matching obs → silent (no `/lesson` nudge). (4) Read + long lesson → 120-char truncation (verifies the shorter cap vs Edit's 240). (5) Read→Edit same file same session → Edit deduped by shared cooldown (regression guard for the "shift don't double" property).

### Not changed (deliberately)

- No new env var, no feature flag. Asymmetric mode is always on for the Read matcher.
- No `*.md` special case. Data measured `docs/*.md` at 4.7% hit rate — the savings from a special case are a few tens of tokens, not worth the code-path complexity.
- No Glob/Grep matchers. Those tools don't carry `tool_input.file_path` in a recall-meaningful way. Only Read joins the file-scoped recall path.

## [2.34.5] - 2026-04-22

UserPromptSubmit gains a **prompts-table fallback**. When the observations-based search paths (FTS / file-recall / error-signature / recent) all return empty, the hook now scans `user_prompts_fts` within the same project and the same 60-day window, and injects up to 3 prior user questions under a distinct `[mem] Past similar questions:` block prefixed with `P#<id>`. Addresses the audit finding that meta/UX-style prompts (e.g. "为什么 X 没有用", "以使用者的身份...") match zero observations but often have a near-identical prior prompt whose answer is what the user actually wants surfaced. 1679 → 1683 tests green (+4 integration tests in `tests/user-prompt-search.test.mjs`).

**Scope discipline.** Fallback fires **only** when the primary observation merge is empty — observation hits suppress the fallback so users editing code keep seeing codebase lessons, not prior chatter. Prompt IDs are namespaced as strings (`"P" + id`) in the dedup store so they don't collide with future observation IDs.

**Gap 2 (CJK threshold) measured, not changed.** A 30-day probe against the live `projects--mem` DB measured `91 / 371` prompts (24.5%) blocked by the v2.34.4 `PROMPT_MIN_LENGTH=15` effective-unit gate. The blocked set is genuinely low-signal (confirmations like "方案 C" / "执行方案 B" / "继续写 plan") and follow-up mode's `FOLLOWUP_PROMPT_MIN_LENGTH=8` already admits substantive short follow-ups. No code change.

### Added

- **`scripts/user-prompt-search.js` `searchByUserPrompts(db, queryText, project, limit)`** — mirrors `searchByFts`'s OR-fallback pattern but uses pure BM25 (no decay × type × importance multipliers, since prompts lack those columns). Deliberately no top-|rel| gate: observation BM25 values pass through a scoring expression that multiplies into the 6..133 range while prompt BM25 is raw and lives in a different magnitude band — sharing the floor would fail silently (this is exactly the wedge #7877 warns about). The upstream `shouldSkip` + `PROMPT_MIN_LENGTH` gate still filters low-information prompts at the entrypoint.
- **`scripts/user-prompt-search.js` `formatPromptResults(rows)`** — distinct `[mem] Past similar questions:` header (not "Related memories:") so Claude can tell these are surface-form user questions, not saved codebase insights. Rows render as `P#<id> 💬 <truncated 80-char prompt>`.
- **`tests/test-helpers.mjs` `insertPrompt(db, { contentSessionId, text, promptNumber?, epochOffset? })`** — new helper mirroring `insertObs` for tests that exercise the fallback path. Matches the shape produced by `hook-episode.mjs` at runtime.
- **`tests/user-prompt-search.test.mjs` 4 new integration tests.** (1) fallback fires when obs empty but prompt matches — asserts `[mem] Past similar questions:` header + `P#<digit>` pattern. (2) fallback suppressed when obs hit — asserts the `Related memories:` header and no fallback block. (3) project scope enforced — seeds a prompt under a different project's session and asserts empty output. (4) time cutoff enforced — seeds a prompt 70 days old and asserts empty output.

### Not changed (deliberately)

- No new env vars, no new feature flags. Fallback is always on.
- No top-|rel| gate on prompts. Prompt FTS magnitudes are much smaller than obs scores; sharing the 50-floor would kill almost all real hits.
- `PROMPT_MIN_LENGTH` and `FOLLOWUP_PROMPT_MIN_LENGTH` unchanged — the Gap 2 measurement (91/371 blocked, 24.5%) showed current values are well-calibrated; the blocked set is low-signal confirmations.

## [2.34.4] - 2026-04-17

CJK-short-prompt recall fix. The T3 raw-length gate (`PROMPT_MIN_LENGTH=15`) in `scripts/user-prompt-search.js` was a raw-character count while the upstream `shouldSkip` already weighted CJK at 3× Latin. A 14-char prompt like "优化 hook 性能降低延迟" (8 CJK + 4 Latin + 2 spaces) passed `shouldSkip`'s 8-unit floor (effectiveLen 30) but fell below the raw-15 gate and never reached FTS. Fix shares one weighting function across both gates. 1673 → 1679 tests green (+6: 5 unit tests for `computeEffectiveLen`, 1 integration test for CJK gate admission).

**No breaking changes.** Latin-only prompts keep identical behavior (`computeEffectiveLen` on pure-Latin text equals the raw char count). Only CJK-containing prompts in the 5..14-raw-char / ≥15-effective-unit band change from blocked to admitted.

### Fixed

- **`scripts/prompt-search-utils.mjs` extracted `computeEffectiveLen(text)`** — CJK Unified Ideographs (main `\u4e00-\u9fff` + extension A `\u3400-\u4dbf`) count as 3 units, everything else as 1. `shouldSkip` now delegates to it instead of computing the weighting inline. Exported so the prompt-hook gate can reuse the same formula.
- **`scripts/user-prompt-search.js` PROMPT_MIN_LENGTH applied to effective length, not raw length.** `if (promptText.trim().length < promptMinLen) return;` → `if (computeEffectiveLen(promptText.trim()) < promptMinLen) return;`. Thresholds unchanged (first prompt 15, follow-up 8) — the Latin calibration still holds, CJK now clears it proportionally. Matches the CJK-weighted gate `shouldSkip` has used since v2.22 and closes the one-gate-weighted / one-gate-not inconsistency introduced when the T3 raw gate was added in v2.31.
- **`tests/user-prompt-search.test.mjs` new coverage.** Unit tests for `computeEffectiveLen`: empty/null, Latin counting, CJK 3× weighting, mixed prompts (asserts the user's example "优化 hook 性能降低延迟" → 30), CJK extension A coverage. Integration test in the T3 describe block seeds a `bugfix` observation with "优化" + "性能" terms and asserts the 14-raw-char CJK prompt now produces a non-empty hit (`expect(stdout).toMatch(/优化|性能/)`). Mutation-resistant: reverting to raw `.length` re-blocks the prompt before FTS runs, the test fails with empty stdout.

## [2.34.3] - 2026-04-17

UserPromptSubmit FTS recall now drops tangential-keyword noise hits via a top-|rel| sanity gate. Triggered by a simulation run where "today's date please help me" surfaced an unrelated v2.34.1 UX audit observation at |rel|=37.8 — clearly in the noise band, but the per-row `BM25_MIN_SCORE` floor at `1e-5` was six orders of magnitude below observed score magnitudes and never fired. 1670 → 1673 tests green (+3 gate tests, +0.18%).

**No breaking changes.** Same injection behavior for all FTS matches above the gap; the gate only drops sets where even the top match is weak.

### Fixed

- **`scripts/user-prompt-search.js` top-|rel| sanity gate added (`TOP_REL_FLOOR=50`).** Noise prompts like `today's date please help me`, `what is the current time right now`, `can you please confirm this works okay` were surfacing 3-5 tangential memories each via OR-fallback single-stem matches. Per-row filtering left them through because every row scored ~25-48, which is "above the floor" relative to the stale `1e-5` constant but nowhere near SIGNAL range. **Empirical distribution (12-prompt probe):** SIGNAL top-|rel| 60..133, NOISE top-|rel| 25..48, WEAK-META 6.86..33 — there is a clean 48→60 gap with no observed prompt landing inside. New gate drops the entire FTS result set when `Math.abs(ftsRows[0].relevance) < 50`. Error-signature hits (`sigRows`) and file-recall (`fileRows`) bypass the gate — both are precision passes with independent signal. Env-overridable via `CLAUDE_MEM_UPS_TOP_MIN` for project-specific tuning. Integration tests cover: gate-fires (env 1e9, signal seed, expect empty), gate-off (env 0, signal seed, expect hit), file-recall bypass (env 1e9, filename-match seed, expect hit).
- **`scripts/user-prompt-search.js` `BM25_MIN_SCORE` comment retuned.** Historic comment claimed |rel| falls in 3e-6..5e-5 and justified `1e-5` as a tight floor. Real data spans ~6..133 — the scoring expression was revised in later versions and the constant was never re-tuned. 1e-5 now acts as a NULL-rel guard only; the new `TOP_REL_FLOOR` is the actual noise filter. Constant kept (no behavior change) to preserve the env override path.
- **`scripts/user-prompt-search.js` follow-up halving scoped narrowly.** v2.33.1 added `FOLLOWUP_BM25_MIN_SCORE` (half of primary) to loosen per-row filtering for short follow-up prompts. The initial v2.34.3 draft added a parallel `FOLLOWUP_TOP_REL_FLOOR=25` — but the top-|rel| gap is an *absolute* distribution separator, not a relative one. Halving to 25 re-admitted the 37..48 NOISE band the gate exists to drop (caught via live probe: `today's date` injected on second-in-session invocation). Follow-up halving is now scoped to length / per-row BM25 only.

## [2.34.2] - 2026-04-17

Three-round user-perspective audit of all 17 MCP tools (6 core + 11 hidden-but-callable) across both MCP stdio and CLI paths. Four concrete issues found and fixed; each comes with a regression test. 1669 → 1670 tests green (+1 timeline cross-project test, retargeted truncation test from 120 → 240). `git diff --stat`: 5 files, 73+/18-.

**No breaking changes.** Timeline scope change is a bug fix — anchor-supplied-then-leaked-cross-project was never an intentional contract.

### Fixed

- **`mem_timeline` anchor-based calls no longer bleed cross-project observations.** Both `server.mjs:782-793` and `mem-cli.mjs:739-746` selected `anchorRow.project` but never fed it back into the before/after SQL. When `--project` / `project` arg was omitted, sibling projects sharing the same time window appeared in the output — e.g. timeline around a `projects--mem` decision included three `projects--code-graph-mcp` changes inline. Fix: `effectiveProject = args.project || anchorRow.project`. Regression test in `tests/cli.test.mjs` asserts obs from `other--project` stay out when anchor is in `test--project`. Opt-out: if you actually want cross-project context around an anchor, use `mem_search` with `date_from`/`date_to` bounds.
- **`scripts/pre-tool-recall.js` lesson truncation raised from 120 → 240 chars.** Measured against 29 lesson-bearing observations: avg=247, p50=218, p90=398, max=452. At the old 120 cap, 28/29 (97%) lessons were truncated and 4/5 of those containing a ` Fix:` keyword had the fix guidance past char 117 — the actionable half of the lesson was invisible at the Edit site. Per-Edit cost delta: 3 lessons × 120 extra chars ≈ 180 tokens. Lesson tests in `tests/pre-tool-recall.test.mjs` updated to cover both the new cap and a preserved p50-length lesson.
- **`mem-cli.mjs` `maintain execute --ops dedup --merge-ids` validates numeric IDs.** The old parser did `.map(Number).filter(n => !isNaN(n))`, so `--merge-ids abc:def` became `[]` and the entire segment was silently skipped, printing `Merged 0 duplicate observations` with no indication the input was malformed. Now each segment is parsed and non-numeric or non-positive tokens trigger a one-line warning listing the ignored segments; valid segments still merge normally.
- **`claude-mem-lite --help` now lists `optimize` and `doctor` subcommands.** Both were registered in the command switch (`mem-cli.mjs:2446, 2454`) and fully documented in code, but the printed help block stopped at `maintain` and jumped to `fts-check` — users had no way to discover them without reading the source. Added the `optimize` section (--run / --run-all / --task / --max / --scope) and a one-line `doctor --benchmark` entry.

## [2.34.1] - 2026-04-17

Four-tier audit of every user-facing entrypoint — 17 MCP tools (core + hidden-but-callable) + 5 Claude Code hook events + 3 external hook scripts = **25 surfaces**. Every finding was reproduced live against the MCP server over stdio or via the CLI / hook subprocess, then fixed with a regression test in `tests/audit-fixes.test.mjs` (40 new assertions). Zero feature additions; focus is correctness, CLI/MCP parity, schema completeness, and safety gates on destructive ops.

**No breaking changes.** Schema additions are optional (`mem_optimize.scope`, `mem_maintain.confirm`, `mem_timeline` description-only wording) and every existing caller keeps the prior default behavior.

### Fixed (P0 — correctness / data safety)

- **`mem-cli.mjs` cmdSave — `--lesson` / `--lesson-learned` now actually persists.** The CLI used to accept the flag via `parseArgs` but never read it, and the INSERT statement omitted the `lesson_learned` column entirely. Users who followed the tool description's "Equivalent CLI" example lost their lesson silently, violating the project's bugfix-after-save contract. Fixed by mirroring `cmdUpdate`'s flag parsing (accepts both spellings), adding a ≤500 char guard, including the column in the INSERT, folding the lesson into the indexed text so the BM25 +0.3 lesson-boost actually surfaces it, and printing the `💡lesson captured` suffix on success.
- **`server.mjs` mem_search — `sort='time'` / `sort='importance'` tie-breaker no longer no-op.** `buildObsFtsQuery` did not select `o.created_at_epoch`, `ftsRowToResult` did not copy it, and the non-FTS path stored the epoch under the name `dateEpoch` while the user-requested sort expression referenced `r.created_at_epoch`. Result objects always carried `undefined`, so the sort reduced to a no-op identity — the relevance order was returned regardless of `sort=`. Fixed by adding `created_at_epoch` to every FTS SELECT (observations / sessions / prompts / CJK fallback), propagating it through `ftsRowToResult`, and renaming the non-FTS field from `dateEpoch` to `created_at_epoch` so there is one canonical name.
- **`server.mjs` mem_maintain purge_stale — destructive op now behind a confirm gate.** The tool description claimed "needs confirm via scan first" but the handler jumped straight to DELETE; a single `mem_maintain(action='execute', operations=['purge_stale'])` call wiped every pending-purge row with no preview and no opt-in. During the audit itself this deleted 421 rows from the real user DB (4002 → 3581) — concrete proof of the risk. Fixed by adding `confirm: boolean` to `memMaintainSchema`, emitting a dry-run preview (candidate count + oldest / newest dates + ready-to-use `confirm=true` command) when `confirm` is absent or `false`, and deleting only when `confirm=true`. CLI `maintain execute --ops purge_stale` gets the same `--confirm` gate for parity.
- **`tool-schemas.mjs` / `server.mjs` mem_optimize — `scope=narrow|wide` now reachable via MCP.** The CLI had `--scope wide` (R-7 re-enrich backfill for `bugfix` / `refactor` / `feature` / `decision` observations with narrative but `lesson_learned='none'`) since the R-7 work, but `memOptimizeSchema` never exposed it — MCP callers always got narrow mode. Fixed by adding `scope: z.enum(['narrow','wide']).optional().default('narrow')` to the schema and passing `reenrichScope: args.scope` through to `optimizeRun`. `safeParse(undefined)` still defaults to `narrow`, so existing callers are unaffected.

### Fixed (P1 — CLI/MCP parity, silent drops, hook behavior)

- **`server.mjs` mem_get — all-invalid `fields` is now an error, partial-invalid emits a note.** Previously `args.fields=['bogus']` returned `── #ID ──` with no body and no warning because the silent `.filter(allFields.includes)` left an empty array. CLI `mem get` at least warned to stderr and failed. Fixed by throwing when every requested field is unknown (message lists the valid set) and prepending a `Note: unknown field(s) dropped: …` line when a subset is valid.
- **`server.mjs` mem_get — missing IDs are now surfaced.** `mem_delete` already appended `Note: ID(s) X not found` for partial hits; `mem_get` silently skipped them. Fixed by computing the set difference after the SELECT and appending the same style of note. For `source='session'` / `source='prompt'` misses we additionally probe whether the IDs exist as observations and hint `Try source='obs'` when they do.
- **`server.mjs` mem_maintain execute — empty `operations: []` now errors instead of running only FTS optimize.** An explicit empty array previously silently passed all `ops.includes(...)` checks and reached only the FTS5 optimize step, looking like a success. Fixed by short-circuiting with `isError: true` and a message directing callers to a non-empty list or omission (which picks up the default `['cleanup','decay','boost']`).
- **`mem-cli.mjs` cmdMaintain — OP_CAP hit warnings + merge-ids-without-dedup warning on parity with MCP.** The MCP handler appended `(cap reached, re-run for more)` when any op hit its 1000-row safety cap; the CLI didn't — users thought the cleanup was finished when it wasn't. The MCP handler also warned when `merge_ids` was supplied without `dedup` in `operations`; the CLI silently discarded it. Both behaviors now match.
- **`mem-cli.mjs` cmdOptimize — `--max 0` (and other invalid values) no longer silently becomes 15.** The `parseInt(v) || 15` fallback treated 0, NaN, negative, and >100 values as "use default", which in practice meant spending 15 LLM calls instead of zero. Fixed with an explicit integer + `[1, 100]` range check and a clear `Invalid --max` error. Same fix category for `--task` which now accepts a comma-separated list (parity with MCP's `tasks` array) and rejects unknown task names by listing the valid four.
- **`server.mjs` mem_export — invalid `date_from` / `date_to` now throws instead of silently dropping the filter.** Previously `date_from: 'not-a-date'` was just ignored and the export returned every row in scope; `mem_search` already threw on invalid dates. Now parity: unambiguous error with the expected format hint.
- **`hook.mjs` auto-maintain — "7-day retention" is now actually seven days.** The purge filter `created_at_epoch < now - 7d` was redundant with the 30-day marking gate (rows marked pending-purge are already ≥30d old), so the effective retention window was the next maintenance cycle (~24h), not seven days. Fixed by changing the cutoff to `now - 37d` (30d marking threshold + 7d grace). Schema gains no new column — the comment and the code now agree, and a row marked today genuinely has a week before auto-delete.
- **`scripts/pre-skill-bridge.js` — switched to JSON `hookSpecificOutput` envelope for CC variant parity.** The bridge printed plain-text `<skill-bridge>…</skill-bridge>` via `console.log`, which works on stock Claude Code but is silently dropped by some variants (notably `sdscc` — documented in `pre-tool-recall.js:185` comment). On those variants the bridge read the managed skill and emitted nothing, so `Skill(<managed-name>)` no-oped. Now uses `process.stdout.write(JSON.stringify({suppressOutput:true, hookSpecificOutput:{hookEventName:'PreToolUse', additionalContext}}))` — the same envelope `pre-tool-recall.js` has used since v2.31 T2.

### Fixed (P2 — polish / UX)

- **`tool-schemas.mjs` memTimelineSchema — `anchor` / `query` precedence is now documented.** When both are provided, `anchor` wins and `query` is ignored. The schema descriptions previously gave no hint of this.
- **`server.mjs` mem_search — empty query now labels the output.** `mem_search` with no `query` falls through to a "list most recent" path. Previously the header rendered as `Found N result(s):` which looked identical to a relevance-ranked set. Now labeled `Found N result(s) (no query — listing recent):`.
- **`server.mjs` mem_export — cap message distinguishes "limit reached" from "all rows exhausted".** `rows.length >= exportLimit` couldn't tell apart "user asked for 100 and we had exactly 100" from "user asked for 100 and we truncated from 500". Fixed by querying `LIMIT+1` and only rendering the `Results capped at N` note when more rows actually exist beyond the limit.
- **`server.mjs` mem_export — JSON / JSONL output now includes `branch`, `access_count`, `memory_session_id`.** These columns were dropped from the SELECT list, so round-trip import after export lost branch-aware filtering, reuse frequency, and session provenance. The three fields are now part of every exported row.
- **`server.mjs` mem_registry list — orders by adoption count and prints `adopt:0` instead of `adopt:null`.** The previous `ORDER BY type, name` put never-adopted resources ahead of popular ones, and `${r.adopt_count}` rendered `null` directly. CLI list already had the better ordering; now MCP matches: `ORDER BY COALESCE(adopt_count,0) DESC, COALESCE(recommend_count,0) DESC, type, name` plus `?? 0` in the display.
- **`server.mjs` mem_fts_check — removed unreachable `Unknown action` branch.** Zod's `action: z.enum(['check','rebuild'])` rejects any other value at the schema layer, so the fallback return was dead code.
- **`hook.mjs` handleStop — fast summary INSERT is now idempotent.** A second Stop fire for the same session id (rare but possible in crash-recovery / re-run scenarios) would insert a duplicate `session_summaries` row; `handleSessionStart`'s fallback path already guarded against this with a `hasSummary` check, but Stop did not. Now both paths share the same guard. Uses the mem-internal `sessionId` as the WHERE key per the file-top dual-id invariant (#7789).
- **`hook.mjs` handleUserPrompt — `prompt_counter` read is now atomic.** Previously `UPDATE sdk_sessions SET prompt_counter = ... + 1` was followed by a separate `SELECT prompt_counter` — two concurrent UserPromptSubmit events could each UPDATE and then each SELECT the post-second-update value, writing duplicate `prompt_number` rows into `user_prompts`. Fixed with a single `UPDATE … RETURNING prompt_counter` (SQLite 3.35+).

### Added

- **`tests/audit-fixes.test.mjs`** — 40 regression tests split across the four audit tiers (T1 retrieval / T2 write-maintenance / T3 read-aux / T4 hook chain). Each test documents the pre-fix symptom so a future revert is flagged loudly. Mixes CLI-via-`run()` (with `vi.mock`'d DB), MCP-over-stdio (real `server.mjs` spawned per test into a `mkdtempSync` DB), and direct Zod-description assertions. Uses real-homedir skill fixtures for `pre-skill-bridge` (non-vacuous RED, per memory #7637).
- **`tests/cli.test.mjs`** — one new assertion around the `purge_stale --confirm` / preview split; one existing `execute runs purge_stale operation` test fixed to use the correct `COMPRESSED_PENDING_PURGE` sentinel (`-2`, not `-1`) and pass `--confirm`.

### Internal

- **`mem-cli.mjs`** — `cmdSave` rebuilds the FTS-indexed `text` field to include `safeLesson` (mirrors MCP `mem_save`'s `indexText`) so `notLowSignalTitleClause`-filtered search actually surfaces lesson-bearing rows via the +0.3 BM25 boost.
- **`server.mjs` `buildObsFtsQuery`** + `ftsRowToResult` — `created_at_epoch` now flows end-to-end through the FTS pipeline; `dateEpoch` is gone as a field name.
- **`hook.mjs` `handleUserPrompt`** — `promptNumber` replaces the removed `counter` local; downstream `<= 3` gate on the handoff injection block updated in the same edit.
- **`CLAUDE.md`** — Quick Reference test-file count refreshed from 44 → 61 (drift accumulated across v2.30–v2.34).

Tests: 1664 → 1668 pass (61 files, +40 new in `audit-fixes.test.mjs`, 0 regressions). Lint: clean on all touched files.

## [2.34.0] - 2026-04-17

**Migration note (user-visible default behavior change).** The MCP server now exposes 6 core tools in `tools/list` (`mem_search` / `mem_recent` / `mem_recall` / `mem_get` / `mem_save` / `mem_timeline`) instead of all 17. The remaining 11 tools (`mem_browse`, `mem_compress`, `mem_delete`, `mem_export`, `mem_fts_check`, `mem_maintain`, `mem_optimize`, `mem_registry`, `mem_stats`, `mem_update`, `mem_use`) stay registered and are still callable by exact name via `tools/call`, so scripts and direct MCP clients continue to work unchanged. Claude Code sessions will no longer see these 11 in their tool list — the supported entry for them is now the `claude-mem-lite <cmd>` CLI (documented in the refreshed README tables and in each adopted project's `memory/plugin_claude_mem_lite.md`).

**Revert path**: set the `CLAUDE_MEM_ALL_TOOLS=1` environment variable in your MCP launch env to restore pre-v2.34.0 behavior (all 17 tools in `tools/list`). Unset it to keep the new default.

**Discoverability signal**: the server prints a one-line banner to stderr on session start that states the current visibility mode and the opt-out env var (suppressed under `MEM_QUIET_HOOKS=1`).

**Why**: per the existing "passive hook first, MCP tools second" design (see memory `feedback_passive_first.md`), 17 tool schemas at session start was larger than needed — the 6 core tools cover every hot path the invited-memory contract promises (recall before Edit, save after bugfix, search/recent/timeline/get for retrieval). The 11 hidden tools are maintenance/admin/browser surface that's already served better by the CLI.

### Changed

- **`tool-schemas.mjs`** — the exported `tools` array now carries `hidden: true` on 11 of the 17 entries. Shape is unchanged for the 6 core tools; consumers reading `tools` directly get one extra boolean field on the hidden entries.
- **`server.mjs`** — registers all 17 tools unchanged, then overrides the `ListToolsRequestSchema` handler on `server.server` (a Map.set at the protocol layer) to filter hidden names out of the response. `enabled` stays `true` on every tool, so `tools/call <name>` routes exactly as before — setting `enabled: false` would have broken callability (mcp.js:106 throws "tool disabled" on disabled-tool calls, which is why this ships as a filter and not a flag flip).
- **`adopt-content.mjs`** — `getDetailDoc()` revised: Decision-rules block trimmed to the 3 core-only shortcuts; new "维护 / 管理类工具（走 CLI）" table enumerates the 11 hidden tools with their CLI equivalents. `getIndexLine()` and `CURRENT_SENTINEL_VERSION` unchanged, so existing `claude-mem-lite adopt`ed projects keep their sentinel hash and refresh only the detail doc on next adopt — no `UserEditedError` conflicts.
- **`README.md` / `README.zh-CN.md`** — MCP Tools table split into a "Core (6)" section and a "Hidden-but-callable (11)" table that lists the exact CLI to reach each. The registry architecture paragraph in `README.md` rewritten so the documentation stops claiming Claude autonomously invokes `mem_registry`.
- **`CLAUDE.md`** (project) — `server.mjs` row in the Architecture table updated to document the 6+11 split and point at `tool-schemas.mjs` as the source of truth.

### Added

- **`tests/tool-visibility.test.mjs`** — spawns the real server over stdio and drives `initialize` + `tools/list` + `tools/call mem_stats` handshakes. Three cases: (a) default config returns exactly the 6 core names; (b) `CLAUDE_MEM_ALL_TOOLS=1` restores all 17 (revert-path regression guard); (c) `tools/call mem_stats` succeeds despite the tool being filtered from `tools/list`. Sandbox DBs via `CLAUDE_MEM_DIR=<tmpdir>`; zero tmp-dir residue across runs.
- **`tests/tool-schemas.test.mjs`** — 4 new assertions: total 17 split into exactly 6 core + 11 hidden, the 6 core names match the invited-memory contract, the 11 hidden names match the maintenance/admin/specialized list, and the `hidden` flag is boolean-true (no truthy-string drift).

Tests: 1621 → 1627 pass (60 files, +6 new cases in 2 files: 4 in `tool-schemas.test.mjs`, 3 in the new `tool-visibility.test.mjs` — which include the opt-out regression guard — offset by -1 because one pre-existing assertion was subsumed into a split count check, 0 regressions). Lint: clean on 5 touched files.

## [2.33.5] - 2026-04-17

Follow-up patch to v2.33.4. Code review of the Stop-schema fix flagged two gaps: the PostToolUse receipt emission path (untouched by v2.33.4 but newly gated by the `RECEIPT_EVENTS` allowlist) had no positive regression test, and the `flushEpisode` header comment carried two eras of explanation (v2.33.3 + v2.33.4) that were confusing to read together. Neither gap was a correctness problem on its own, but both reduce the cost of the next Stop-schema incident if CC ever tightens SessionStart or another event.

### Added

- **`tests/e2e.test.mjs`** — new test `PostToolUse flush emits receipt JSON with correct event tag`. Fills the episode buffer to 10, then the 11th post-tool-use call triggers `flushEpisode` and the test asserts the stdout receipt has `hookSpecificOutput.hookEventName === 'PostToolUse'` and `additionalContext` matches `/\[mem\] episode flushed: \d+ entries/`. Guards against a future over-broadening of the `RECEIPT_EVENTS` guard accidentally swallowing the happy-path receipt (the failure mode that motivated v2.33.1's introduction of the receipt in the first place).

### Internal

- **`hook.mjs:112-119`** — consolidated the two-era header comment on `RECEIPT_EVENTS` / `flushEpisode`. The new version explains the dual role of `hookEventName` (emit value + gate key), why Stop is excluded, and the v2.33.1 → v2.33.3 → v2.33.4 regression chain in one block.

Tests: 1620 → 1621 pass (59 files, +1 new, 0 regressions).

## [2.33.4] - 2026-04-17

Follow-up to v2.33.3. The v2.33.3 patch changed `flushEpisode`'s hard-coded `hookEventName: 'PostToolUse'` into a parameter and taught `handleStop` to pass `'Stop'`. That fixed the "expected 'Stop' but got 'PostToolUse'" error class but not the actual user-visible failure in code-graph-mcp: Claude Code's Stop-event schema **forbids `hookSpecificOutput` entirely** (only `PreToolUse` / `UserPromptSubmit` / `PostToolUse` / `SessionStart` carry `additionalContext`). Tagging the receipt with `hookEventName: 'Stop'` still tripped `Hook JSON output validation failed — (root): Invalid input`.

### Fixed

- **`hook.mjs:flushEpisode`** — introduced `RECEIPT_EVENTS = {PostToolUse, SessionStart, UserPromptSubmit}`. When `hookEventName` is outside that set (currently only `'Stop'`), the episode still flushes to DB and spawns `llm-episode` background enrichment, but the structured JSON receipt is skipped. No stdout is emitted for Stop, which is what CC's schema requires.

### Internal

- Regression test updated in `tests/e2e.test.mjs` (`stop flushes episode and marks session completed`): now asserts `parsed?.hookSpecificOutput` is `undefined` when Stop produces any stdout. Reproduces the code-graph-mcp error on v2.33.3, passes on v2.33.4. Test count unchanged.

## [2.33.3] - 2026-04-17

Hotfix for a regression in the v2.33.1 structured flush receipt: `hookEventName` was hard-coded to `'PostToolUse'` but `flushEpisode` is shared by three hook entrypoints. When called from Stop or SessionStart, Claude Code rejected the output with `Hook returned incorrect event name: expected 'Stop' but got 'PostToolUse'` and surfaced the error to the user at session close.

### Fixed

- **`hook.mjs:flushEpisode`** — accepts `hookEventName` as the second parameter, defaulting to `'PostToolUse'`. `handleStop` (line 359) now passes `'Stop'`; `handleSessionStart` leftover-episode flush (line 512) passes `'SessionStart'`. Flush receipt JSON payloads now match the triggering hook event and no longer trip Claude Code's event-name validation.

### Internal

- Regression test strengthened in `tests/e2e.test.mjs` (`stop flushes episode and marks session completed`): now asserts that when stdout contains a `hookSpecificOutput.hookEventName` payload, the value is exactly `'Stop'`. Reproduces the bug on old code, passes on new. 1620 tests, no count change.

## [2.33.2] - 2026-04-17

Dual-id regression fix. Since `bf121aa` (2026-04-12, v2.32.x line) `handleStop` and `handleSessionStart /clear` used `sessionId = ccSessionId || getSessionId()` as the query key for every DB operation. But `handleUserPrompt` still writes `user_prompts` / `sdk_sessions.content_session_id` / `observations.memory_session_id` with the mem-internal id from `getSessionId()`. When Claude Code provided `session_id` in hook stdin (modern CC), the id passed to DB lookups was a CC UUID that matched zero rows — silently.

### Fixed

- **`hook.mjs:handleStop`** — `sessionId` now always comes from `getSessionId()` (mem-internal); `ccSessionId` is passed separately to `buildAndSaveHandoff` as a scope tag only. Without this, `UPDATE sdk_sessions SET status='completed'` matched 0 rows (sessions stayed `active`), `buildAndSaveHandoff`'s `user_prompts` lookup returned empty and early-returned (no handoff row written), and the fast-summary `firstPrompt` / `recentObs` queries missed every row.
- **`hook.mjs:handleSessionStart`** — same split applied to the `/clear` handoff path: query key = `prevSessionId` (mem-internal from session file), scope key = `ccSessionId || prevSessionId`.
- **`hook-handoff.mjs:buildAndSaveHandoff`** — new optional 6th arg `scopeSessionId`. When provided, overrides only the value written into `session_handoffs.session_id`; every internal lookup still uses `sessionId` (arg 2). Default `null` preserves legacy behavior for tests / older callers.

### Added

- **File-level session-id invariant doc** (`hook.mjs:6-20`) — explicit contract: mem-internal id owns `user_prompts` / `sdk_sessions` / `observations`; CC UUID is valid only for `session_handoffs.session_id` scoping. Historical precedent (this regression, 4 days undetected) inlined for future contributors.

### Data migration

- **One-time**: `UPDATE sdk_sessions SET status='abandoned' WHERE status='active' AND started_at_epoch < now - 3600000` — 59 stuck rows across `projects--mem` (38), `projects--code-graph-mcp` (20), `tmp--mem-test-fresh` (1) cleared. 1h cutoff protects currently-running sessions; they'll self-clean on next `/exit` now that the fix is in place.

### Internal

- 1618 → 1620 tests (+2 regression tests in `tests/handoff.test.mjs`: `scopeSessionId` tags the handoff row while `querySessionId` drives `user_prompts` lookup; default-to-`sessionId` backward-compat).
- No public API / schema change. Hook contract unchanged for callers.

## [2.33.1] - 2026-04-17

Feedback-loop + signal-density patch. Audit of in-session plugin behavior (4-turn conversation, 1 PreToolUse Edit hit, 0 follow-up UserPromptSubmit injections, type distribution `decision 9 / change 1171`) surfaced four gaps — this release fixes all four and prunes historical noise.

### Added

- **Follow-up-aware UserPromptSubmit gate (`scripts/user-prompt-search.js`)** — once a session has injected memory ≥1×, short continuation prompts ("前面那个?", "does it work?") get relaxed thresholds: `PROMPT_MIN_LENGTH` 15→8, `BM25_MIN_SCORE` 1e-5→5e-6. First prompt behavior unchanged. Env overridable via `CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP`.
- **Session-scoped PreToolUse cooldown (`scripts/pre-tool-recall.js`)** — same file recalls exactly once per session (was: 5-min global window). File keyed by `event.session_id`; different session gets fresh recall. Legacy path preserved when no session_id present. Session cooldown files GC'd on write when older than 24h.
- **Structured PostToolUse flush receipt (`hook.mjs:flushEpisode`)** — on episode flush, emits JSON `hookSpecificOutput.additionalContext` with entry count + top-3 tool counts (`[mem] episode flushed: 10 entries (Edit×9, Grep×1)`). The legacy plain-text error→fix nudge now consolidates into the same structured output, reliably rendering across CC variants (sdscc dropped the plain-text variant).

### Changed

- **Expanded low-signal lesson filter (`hook-llm.mjs:handleLLMEpisode`)** — reject list widened from `'none'` alone to `{'none', '', 'n/a', 'null', 'todo', 'tbd', 'na', '-', 'nothing', 'nil'}` plus `length < 12`. For noise-prone types (`change` / `discovery`) with a low-signal lesson, Haiku's importance inflation is capped: `importance = min(ruleImportance, 1)`. `bugfix` / `decision` / `feature` / `refactor` / `discovery-with-lesson` importance is preserved — a real lesson means the downgrade does not apply regardless of type.

### Data migration

- **One-time `UPDATE observations SET importance=0`** for 2012 rows where `type IN ('change','discovery')` AND lesson is low-signal (empty / 'none' / < 12 chars). Rollback: `UPDATE observations SET importance=1 WHERE importance=0 AND type IN ('change','discovery')`. Signal density in local DB went from 3956 → 1948 visible (49%) — hook queries (`importance >= 1`) now skip the rest.

### Internal

- 1610 → 1618 tests (+8: 5 low-signal `it.each`, 1 real-lesson regression, 2 session-scoped cooldown paths).
- No public API change. MCP tools / CLI commands / schema unchanged.

### Audit notes

- Post-change signal density by type: `bugfix 1109 (100% visible) / refactor 526 (100%) / feature 219 (100%) / decision 22 (100%) / discovery 40 of 759 (5.3%) / change 32 of 1325 (2.4%)`. Consistent with CLAUDE.md's prior finding that `decision` memories have ~72.7% hit rate vs `change` at 16.5%.
- Skipped during this audit: `#NN` citation-detection follow-up (Stop-hook transcript scan, cost >> benefit). Deferred to future work.

## [2.33.0] - 2026-04-17

**Default behavior change** (minor bump): plugin-mode installs now auto-adopt the invited-memory sentinel on first SessionStart per project. `/plugin install claude-mem-lite@sdsrss` already represents consent to integration — the prior opt-in step was redundant friction. npm/npx CLI users are unaffected and remain opt-in.

### Migration note

- **If you installed as a Claude Code plugin**: the first SessionStart after upgrading will silently write the `<!-- claude-mem-lite:begin v1 -->` sentinel block into your per-project `~/.claude/projects/<encoded>/memory/MEMORY.md`, plus a `plugin_claude_mem_lite.md` detail file in the same memdir. This is reversible via `/unadopt`. A first-attempt marker is persisted under `~/.claude-mem-lite/runtime/.auto-adopt-<project>` so a subsequent `/unadopt` is respected permanently — no re-adopt loop.
- **If you prefer the old opt-in behavior**: set `MEM_NO_AUTO_ADOPT=1` globally (e.g. in `~/.claude/settings.json` `env`). `MEM_QUIET_HOOKS=1` also disables auto-adopt (quiet = no side-effects semantics).
- **If you installed via npm/npx (not as a CC plugin)**: no change — the `CLAUDE_PLUGIN_ROOT` env gate keeps you on the opt-in path.

### Added

- **`silentAutoAdopt()` + `hasAutoAdoptMarker()` in `adopt-cli.mjs`** — helper functions for hook-side silent adopt with per-project marker persistence. Never throws, never logs; structured return for telemetry.
- **Plugin-mode auto-adopt in `hook.mjs` SessionStart handler** — gated by `CLAUDE_PLUGIN_ROOT`, `!MEM_NO_AUTO_ADOPT`, `!MEM_QUIET_HOOKS`, and absent marker. Runs synchronously early in SessionStart, errors swallowed (marker still written on failure to avoid retry-storm).
- **5 new integration tests in `tests/e2e.test.mjs` Suite 11** covering all gating paths: plugin-mode first-run adopts, no-plugin-mode does not, `MEM_NO_AUTO_ADOPT=1` opts out, `MEM_QUIET_HOOKS=1` opts out, marker presence respects `/unadopt`.
- **5 new unit tests in `tests/adopt-cli.test.mjs`** covering `silentAutoAdopt` result shapes: first-run adopts, already-adopted short-circuits, hand-edited sentinel handling, marker scoping per-project, marker persists on failure.

### Internal

- 1600 → 1610 tests (+10: 5 unit + 5 integration).
- `CLAUDE_MEM_AUTO_ADOPT` env (previously proposed as power-user opt-in) is NOT added — auto-adopt is now the plugin-mode default, so the env would be a no-op. `MEM_NO_AUTO_ADOPT` is the sole opt-out.
- No public API change for MCP tools, CLI commands, or schema.

## [2.32.8] - 2026-04-17

Precision improvements to the UserPromptSubmit auto-search hook. Two orthogonal additions: exact-match error-signature recall, and a widened CJK pattern for spoken-language "have we seen this" recall.

### Added

- **`extractErrorSignature()` in `scripts/prompt-search-utils.mjs`** — extracts typed exception signatures from user prompts (`TypeError: ...`, `ValueError: ...`, `Error [ERR_MODULE_NOT_FOUND]: ...`, `AssertionError: ...`, etc.). Two-pass regex: typed `<CapCase>(Error|Exception|Panic)` first, then bare `Error|Exception|Panic [ERR_CODE]` (Node idiom). Bare "Error: ..." without a typed class or code is intentionally skipped — those stay on the intent-based FTS path.
- **Error-signature precision pass in `scripts/user-prompt-search.js`** — when a signature is detected, runs an exact-match `type='bugfix'` FTS search before the intent-based flow. Signature hits take priority slots in the merged output (capped at `MAX_RESULTS=5`). A stack-trace-adjacent prompt now surfaces the exact prior `mem_save({type:'bugfix', ...})` observation for that error class, not tangential bugfix matches.
- **Spoken-CN recall patterns in `INTENTS` (`scripts/prompt-search-utils.mjs:53`)** — recall intent regex extended with `碰到过|遇到过|见过|同样的问题|类似的问题|seen this|same\s+issue`. Prompts like "这个问题碰到过没" / "have we seen this before" now correctly route to recall-mode (shows recent observations) instead of falling through to no-match.

### Internal

- 1588 → 1600 tests (+12: 10 for `extractErrorSignature` shapes, 2 for CJK recall pattern).
- No contract change for MCP tools, CLI, hook I/O surface, or on-disk schema.
- `extractErrorSignature` is exported but internal to the hook; not added to any public API boundary.

## [2.32.7] - 2026-04-17

Handoff continuation-detection hardening. Three rough edges in `detectContinuationIntent` + `hook.mjs` injection cleanup made stale handoffs (especially `/exit` type, which survive 7 days) re-inject across new sessions even when the new prompt was unrelated. Addressed together so the gating story is coherent.

### Fixed

- **Stage -1 git_sha anchor age cap (`hook-handoff.mjs:172-191`)** — the anchor previously returned `true` for ANY matching `git_sha_at_handoff` regardless of age; after "weeks of no commits" it fired aggressively on unrelated prompts. Now capped at `HANDOFF_ANCHOR_MAX_AGE = 72h` — stale-HEAD handoffs no longer shortcut the rest of the pipeline. Sub-72h behavior unchanged.
- **Exit handoff not consumed on injection (`hook.mjs:860-870`)** — the post-injection `DELETE` only covered `type='clear'`, so `/exit` handoffs kept matching the first 3 prompts of every new session in the same project until they aged out at 7 days. Now consumes both `clear` and `exit`; the 7-day expiry becomes a "if nobody ever comes back" safety net instead of a re-injection window.
- **Stage 0 unscoped short-prompt auto-true (`hook-handoff.mjs:194-228`)** — `prompt.length < 40` + fresh clear handoff returned `true` unconditionally. In the session-scoped path (`currentCcSessionId` present), that is fine — same user, same context. In the unscoped/legacy path it produced cross-session noise ("你好" on a fresh unrelated session would resume someone else's `/clear`). Unscoped short prompts now require a `CONTINUE_KEYWORDS` match or keyword overlap with the handoff. Scoped path unchanged.

### Added

- **`tests/handoff.test.mjs`** — four new cases: `anchor within 72h age cap still matches`, `anchor older than 72h does NOT match`, `session-scoped 2-char prompts still auto-continue`, `unscoped 2-char prompts without keyword do NOT auto-continue`. Existing tests adjusted to pin the new contract.
- **`hook-shared.mjs`** — exported `HANDOFF_ANCHOR_MAX_AGE` constant (72h).

### Internal

- 1584 → 1588 tests (+4 coverage for hardened gates).
- No contract change for MCP tools, CLI, or hook I/O surface — only continuation-intent behavior.

## [2.32.6] - 2026-04-17

Handoff injection UX fix. When the `UserPromptSubmit` hook surfaced a prior `/exit` handoff as `additionalContext`, the opening block looked like:

```
<session-handoff source="exit" age="5d">
## Working On
<whatever the prior session was about, often a human-language question>
```

Models sometimes misread that embedded `## Working On` text as a fresh user message — ending the turn, answering the old task, or treating `continue` replies as contradictory. Dogfooding this repo hit it three times in one session before the pattern was identified.

### Fixed

- **`renderHandoffInjection` framing (`hook-handoff.mjs:302`)** — the injection now leads with an explicit `[mem]` framing line: `[mem] Resumed context from previous session (<type>, age <N>) — system-injected, NOT a new user message:` before the `<session-handoff>` tag. The tag also carries a new `origin="hook-injected"` attribute for programmatic callers.

### Added

- **`tests/handoff.test.mjs`** — regression test asserting the injection's first line matches `/^\[mem\]/`, contains "previous" + "not", and the opening tag carries `origin="hook-injected"`. Prevents future reverts that would reintroduce the raw-prompt ambiguity.

### Internal

- 1583 → 1584 tests (+1 framing regression).

## [2.32.5] - 2026-04-17

End-to-end install/update audit caught a cross-module drift between `install.mjs` and `hook-update.mjs`: both maintained independent `SOURCE_FILES` lists, and `hook-update.mjs`'s copy had fallen 8 files behind over v2.31–v2.32. Any npx/npm-installed (non-plugin-mode) user auto-updating from v2.30- to v2.32.x would download the new `hook-llm.mjs` without `lib/activity.mjs` → `ERR_MODULE_NOT_FOUND` on the next SessionStart. Rolled into this release: a latent gap where `registry-enricher/-github/-importer.mjs` were imported by `server.mjs` / `mem-cli.mjs` but never copied to `~/.claude-mem-lite/`, plus two UX papercuts around `/plugin marketplace update` messaging and dev-mode `doctor` output.

### Fixed

- **`hook-update.mjs` SOURCE_FILES drift (P0)** — auto-update no longer silently omits `lib/activity.mjs`, `lib/task-reader.mjs`, `lib/plan-reader.mjs`, `lib/git-state.mjs`, `lib/startup-dashboard.mjs`, `lib/doctor-benchmark.mjs`, `memdir.mjs`, `adopt-content.mjs`, `adopt-cli.mjs`. `install.mjs` and `hook-update.mjs` now both `import SOURCE_FILES from './source-files.mjs'`; drift is impossible by construction.
- **`install.mjs` SOURCE_FILES missing registry helpers (latent P0)** — `registry-enricher.mjs`, `registry-github.mjs`, `registry-importer.mjs` are imported by `server.mjs` (mem_registry tool) and `mem-cli.mjs` (registry CLI) but were never copied to `~/.claude-mem-lite/`. Added to the shared list.
- **`install.mjs::doctor` dev-mode false warning (P2)** — symlinked (dev) installs correctly skip state-file writes in `hook-update.mjs`, but `doctor` still reported `⚠ Update state: no state file (first run?)`. Now reports `✓ Update state: skipped (dev mode — symlinked install)` when `~/.claude-mem-lite/server.mjs` is a symlink.
- **`install.mjs::manualUpdate` plugin-mode upgrade instructions (P1)** — when the plugin system defers auto-install, the notification now tells users exactly what to type: `/plugin marketplace update sdsrss` + `/plugin install claude-mem-lite@sdsrss`. Previously it said "reinstall/update the plugin to apply it" without naming the commands, and users left on whatever version they first pulled.

### Added

- **`source-files.mjs`** — single shared `SOURCE_FILES` manifest, imported by `install.mjs` + `hook-update.mjs`.
- **`tests/source-files-sync.test.mjs`** — 3 regression tests: (1) every `.mjs` statically or dynamically imported by `cli.mjs` / `hook.mjs` / `server.mjs` / `mem-cli.mjs` / `install.mjs` appears in `SOURCE_FILES`; (2) both consumers `import` from the shared module (no inline duplicates creep back); (3) `package.json.files` ships `source-files.mjs` and every SOURCE_FILES entry.

### Changed

- **`CLAUDE.md`** — MCP tool count in the `server.mjs` row corrected from 16 to 17 (missing `mem_use`).
- **`README.md`** — plugin-mode upgrade notes now lead with the two `/plugin …` commands users must run inside Claude Code; previously the docs said "plugin mode only reports available updates" without telling users how to apply one.

### Internal

- 1580 → 1583 tests (+3 source-files-sync regressions).
- `tests/e2e.test.mjs` Suite 10 reads SOURCE_FILES by `import` rather than regex-parsing `install.mjs`.

## [2.32.4] - 2026-04-16

Hotfix — `claude-mem-lite adopt` / `claude-mem-lite unadopt` at the CLI entry point returned `[mem] Unknown command` on v2.32.0–v2.32.3 because `cli.mjs`'s `CLI_COMMANDS` Set was missing both names. The `/adopt` slash command (`!claude-mem-lite adopt $ARGUMENTS`) was broken for installed users. In-process paths (install-time dogfood auto-adopt, direct `import('./adopt-cli.mjs')`) were unaffected.

### Fixed

- `cli.mjs::CLI_COMMANDS` — added `'adopt'` and `'unadopt'` so both commands route through `mem-cli.mjs` instead of falling through to the unknown-command branch.

### Added

- `tests/cli-e2e.test.mjs` — 3 regression tests at the `cli.mjs` subprocess layer: adopt + unadopt are routed (not unknown-command), help output advertises both. Previous coverage (`tests/adopt-cli.test.mjs`) only exercised `cmdAdopt` / `cmdUnadopt` directly, so the missing-entry bug was invisible to the suite.

### Internal

- 1577 → 1580 tests (+3: adopt routing × 2, help-text advertisement × 1).

## [2.32.3] - 2026-04-16

Post-ship code-review fixes for v2.32.0–v2.32.2. No functional regressions; strengthens the 2.32 line.

### Fixed

- **`memdir.mjs::countLines` off-by-one** — `raw.split('\n').length` overcounted by 1 when MEMORY.md ended with a trailing newline (almost always). A POSIX-accurate 180-line file was incorrectly rejected as 181 at the budget edge. Replaced with a newline-count primitive that matches the POSIX line definition. Regression tests: accept at 180, reject at 181.
- **`memdir.mjs::removePluginSection` leading whitespace** — when removing the first of two coexisting plugin sentinels, the tail used to start with stranded blank lines. Added `^\s+` strip + `\n{3,}` collapse so the result looks hand-authored.

### Added

- **Regression test for slash-command shipping gap** — `tests/npm-tarball-completeness.test.mjs` previously only walked `.mjs` / `.js` imports, so asset-style `commands/*.md` files could slip past the gate (as `commands/lesson.md` + `commands/bug.md` did in v2.32.1). New assertion: every `commands/*.md` on disk must appear in `package.json.files`.
- **Restart caveat documented** — `commands/adopt.md` + README "Invited Memory" sections now explain that the MCP-instructions trim requires a Claude Code restart (MCP protocol has no way to push updated instructions to a live session). Hook-layer trim and the MEMORY.md sentinel both activate on the next SessionStart automatically.

### Internal

- 1573 → 1577 tests (+4: 180-line boundary × 2, first-sentinel leading-whitespace × 1, commands-md tarball coverage × 1).

## [2.32.2] - 2026-04-16

Hotfix — resolves [#14](https://github.com/sdsrss/claude-mem-lite/issues/14): npm-installed users crash on first SessionStart with `ERR_MODULE_NOT_FOUND` because 10 files imported by `hook.mjs` / `server.mjs` / `mem-cli.mjs` were never in the npm tarball. Auto-update (copy-file path) was unaffected; only `npm install -g` / `npx` users hit it. Bug originated in v2.29.0 (2026-03), first reported 2026-04-02; v2.31.2's hook-update fix only repaired the auto-update path, not the npm tarball.

### Fixed

- `package.json` `files` array now includes: `hook-optimize.mjs`, `plugin-cache-guard.mjs`, `lib/activity.mjs`, `lib/git-state.mjs`, `lib/task-reader.mjs`, `lib/plan-reader.mjs`, `lib/startup-dashboard.mjs`, `lib/doctor-benchmark.mjs`, `commands/lesson.md`, `commands/bug.md`.
- Verified via `npm pack --dry-run`: all 10 files now ship (previously the tarball was 62 files; v2.32.2 ships 72).

### Added

- `tests/npm-tarball-completeness.test.mjs` (+2 tests) — regression gate that walks static + dynamic imports from every entry module (`cli.mjs`, `hook.mjs`, `server.mjs`, `mem-cli.mjs`, `install.mjs`) and asserts every reachable local module is listed in `package.json.files`. Also asserts no dangling entry points to a non-existent path. This is the permanent root-cause fix: future `SOURCE_FILES` additions in `install.mjs` that forget the `files` array will trigger a red test on the next PR.

## [2.32.1] - 2026-04-16

Hotfix — clear a transitive `npm audit` moderate vulnerability so the Release workflow's `npm audit --omit=dev` gate passes and the 2.32 line can reach the npm registry.

### Fixed

- `hono@4.12.12` (transitive via `@modelcontextprotocol/sdk@1.26.0 → @hono/node-server`) had [GHSA-458j-xx4x-4375](https://github.com/advisories/GHSA-458j-xx4x-4375) (improper JSX attribute handling → HTML injection in SSR). Added `overrides: { "hono": ">=4.12.14" }` to `package.json`; fresh `npm install` now resolves `hono@4.12.14`. `npm audit --omit=dev` reports 0 vulnerabilities.
- 2.32.0 commits + GitHub Release page exist on the sdsrss/claude-mem-lite repo, but the npm-publish leg of the Release workflow never ran (blocked by the same audit gate). 2.32.1 unblocks the pipeline.

### No functional changes

All 1571 tests from 2.32.0 still pass; no source files touched outside `package.json` / `package-lock.json` / version strings / this changelog.

## [2.32.0] - 2026-04-16

Invited-memory: opt-in mechanism that installs a sentinel-wrapped line into the project's Claude Code memdir (`~/.claude/projects/<encoded>/memory/MEMORY.md`) so the plugin's MCP-tool triggers are loaded as `user-memory` — a higher instruction-following authority than MCP server instructions (which Claude frames as tool metadata). Post-adopt the conservative hook layer auto-trims: MCP instructions shrink 1677 → 805 bytes (measured), SessionStart drops the `File Lessons` / `Key Context` sections, UserPromptSubmit drops the lesson suffix. Users who never adopt see zero behavior change.

### Added

- **`MEM_QUIET_HOOKS=1` env switch** — drops `File Lessons` / `Key Context` blocks from SessionStart injection, the lesson suffix from `[mem] Related memories`, and the `WHEN TO USE` / `Decision rules` sections from MCP server instructions. IDs and the `Recent` table still surface so `mem_get` remains reachable.
- **`memdir.mjs`** — primitives for the per-project memdir: `encodeProjectPath` (mirrors Claude Code's non-alphanumeric mangling), `memdirPath`, `readMemoryIndex`, `writePluginSection`, `removePluginSection`, `writePluginDoc`, `removePluginDoc`, `isAdopted`. Hash-guarded via a `.plugin_<slug>_state.json` sidecar; 180-line budget enforces the 200-line `MEMORY.md` cap.
- **`adopt-content.mjs`** + **`adopt-cli.mjs`** — CLI handlers for the new `adopt` / `unadopt` subcommands with `--all` / `--force` / `--dry-run` / `--status` flags.
- **`claude-mem-lite adopt` / `unadopt`** CLI subcommands.
- **`/adopt` / `/unadopt`** slash commands in Claude Code chat.
- **`install.mjs` dogfood auto-adopt** — runs adopt for the current project only when `install.mjs` is invoked from a git checkout whose `origin` matches `sdsrss/claude-mem-lite`. All other installs (npm, npx, plugin marketplace) are silent. `--no-adopt` override respected.
- **Runtime conditional trim** — `server.mjs` and `hook-context.mjs` now consult `effectiveQuiet()` which ORs the env switch with `isAdoptedHere()`. Adopted projects automatically get the slim output; projects without adoption (or on older Claude Code versions that don't auto-load `memory/MEMORY.md`) keep the full verbose output unchanged.
- **Self-clearing adopt hint** — SessionStart startup dashboard now appends a one-line `🧷 Invited-memory 未启用：claude-mem-lite adopt …` hint on every SessionStart until the sentinel is installed. Silence via `MEM_NO_ADOPT_HINT=1` (or `MEM_QUIET_HOOKS=1`).
- **`docs/plans/2026-04-16-invited-memory-pattern.md`** — the plan document.
- **`docs/templates/invited-memory-template.md`** — reusable blueprint for other Claude Code plugins that want to follow the same integration pattern.
- New env vars in README tables: `MEM_QUIET_HOOKS`, `MEM_NO_ADOPT_HINT`.
- New READMEs section `### Invited Memory` (English + 中文).

### Changed

- `server.mjs` instructions builder extracted to `server-internals.mjs::buildServerInstructions(quiet)` for testability.
- `lib/doctor-benchmark.mjs` MCP-instructions scanner learned a third form (builder-call reconstruction from `INSTRUCTIONS_BASE` + `INSTRUCTIONS_VERBOSE`) so the byte-count baseline keeps working after the refactor.
- Uninstall no longer automatically `unadopt`s — an adopted project may still be active in other Claude Code sessions. Uninstall prints the one-liner `claude-mem-lite unadopt --all` instead.

### Internal

- 1516 → 1571 tests (+55 net: +13 quiet-hooks, +29 memdir, +12 adopt-cli, +10 adopted-detection, +4 startup-dashboard adopt-hint, −13 where 1 existing test was modified).
- Four new test files: `tests/quiet-hooks.test.mjs`, `tests/memdir.test.mjs`, `tests/adopt-cli.test.mjs`, `tests/adopted-detection.test.mjs`.
- Zero new runtime deps. Zero breaking changes. Backward-compatible schema (none added).

### Compat note

Invited-memory is opt-in. Users on `v2.31.x` who upgrade without running `adopt` see identical behavior — the only delta is the one-line adopt hint on SessionStart (silence: `MEM_NO_ADOPT_HINT=1`). Adopt is per-project; no global state is touched.

## [2.31.2] - 2026-04-15

Hotfix — close the auto-upgrade gap introduced in 2.31.1.

**Problem**: 2.31.1's `hook.mjs` added a *static* `import` of the newly added `plugin-cache-guard.mjs`, but `hook-update.mjs`'s `SOURCE_FILES` list (the list the running update process uses to stage files) was not updated. Users on 2.31.0 auto-upgrading to 2.31.1 got the new `hook.mjs` but **not** `plugin-cache-guard.mjs` — next session-start failed with `ERR_MODULE_NOT_FOUND`, taking all mem hooks (including the update checker itself) offline.

### Fixed

- **`hook.mjs`** now loads `plugin-cache-guard.mjs` via **dynamic import with try/catch fallback**. Degrades gracefully to no-op self-heal when the guard module is absent; hook loading no longer crashes.
- **`hook-update.mjs`** `SOURCE_FILES` updated to include `plugin-cache-guard.mjs` and `hook-optimize.mjs` (the latter was also missing — silently shipped as a dev-mode-only feature since v2.29.0).
- **`hook-update.mjs`** post-install now calls `clearCacheHookResidue()` — clears populated `hooks.json` in every remaining cache version after `prunePluginCache`. Layer 1 (cache-clearing) now runs from the auto-update path, not only from manual `install.mjs`.

### Added

- `hook-update.mjs:clearCacheHookResidue` — inline (no import of plugin-cache-guard to keep the update path robust when that module is missing on disk).
- 2 new unit tests in `tests/hook-update.test.mjs` covering `clearCacheHookResidue`.

### Recovery for users stuck on broken 2.31.1

If mem hooks are silently failing after auto-upgrade (no `<memory-context>` blocks, no `<session-handoff>`), manually rerun:

```bash
node ~/.claude-mem-lite/install.mjs install
```

This re-deploys `plugin-cache-guard.mjs` and restores hook loading. Subsequent auto-upgrades will then proceed correctly.

### Internal

- 1501 → 1503 tests (+2).

## [2.31.1] - 2026-04-15

Hotfix — prevent duplicate hook registration when install.mjs-managed `settings.json` entries coexist with a stale plugin cache `hooks.json`. Claude Code runtime reads plugin hooks from `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json`, not from the marketplace source — install.mjs was only clearing the marketplace path, so stale cache entries caused every session start / user prompt hook to fire twice.

### Fixed

- **install.mjs** now clears `hooks.json` in every plugin cache version directory (the loop that already syncs `launch.mjs` was extended to handle the hooks file). New test `install-e2e.test.mjs > install clears stale hooks.json in every plugin cache version to prevent double firing` covers two version dirs with populated hooks.
- **hook.mjs `session-start`** self-heals on every session: if install.mjs-managed hooks are active in `settings.json` and a populated cache `hooks.json` is detected, it clears the cache entry silently. Prevents recurrence after Claude Code auto-updates the marketplace plugin.

### Added

- `plugin-cache-guard.mjs` — shared module exposing `scanPluginCacheHookPollution`, `clearPluginCacheHooks`, `hasInstallManagedHooks`. Unit tests at `tests/plugin-cache-guard.test.mjs` (10 new tests).
- `install.mjs status` now reports plugin cache pollution state (`fail` when stale cache coexists with install.mjs hooks; `ok` when clean). Two new integration tests in `tests/install-lifecycle.test.mjs`.
- `plugin-cache-guard.mjs` added to `SOURCE_FILES` so dev-mode symlinks and copy-mode deploys include it.

### Internal

- 1490 → 1501 tests (+11).

## [2.31.0] - 2026-04-14

v2.31 MVP — hook quality hardening + activity namespace + SessionStart dashboard. Ten-task slice distilled from the v3.0 / v3.1 refactor proposals (`docs/plans/2026-04-14-mem-v2.31-mvp.md`), delivered additively with zero breaking changes. Schema bumped 22 → 25 via three idempotent additive migrations; 1398 → 1490 tests (+92).

### Added

- **Activity namespace** (`events` table + FTS5, T6–T9): non-memdir event types (`bugfix`, `lesson`, `bug`, `discovery`, `refactor`, `feature`, `observation`, `decision`) now live in a dedicated `events` table so they don't fight sdscc `WHAT_NOT_TO_SAVE` semantics. New compound index `idx_events_project_created` backs hot-path queries.
- **`activity` CLI subcommand group** (T7): `claude-mem-lite activity save|search|recent|show` with `--project`, `--files` (plural comma-split), `--type` validation against the 8-value enum.
- **`/lesson` and `/bug` slash commands** (T8): frictionless capture entry points that write to the events table, never to memdir.
- **`hook-llm` routes non-memdir types to events** (T9): `handleLLMEpisode` clean-insert and upgrade paths now dispatch through `persistHaikuSummary`. Upgrade branch for event-typed summaries is atomic (DELETE observations + INSERT events inside a transaction).
- **Startup Dashboard** (T10c): SessionStart hook aggregates `git status` + `~/.claude/tasks/*.json` + `~/.claude/plans/*.md` + most-recent exit handoff + events count into a single structured injection, JSON-output via `hookSpecificOutput.additionalContext`.
- **Git-commit continuation anchor** (T10d): `detectContinuationIntent` adds a Stage -1 anchor — any handoff whose `git_sha_at_handoff` matches current HEAD returns true regardless of TTL. Code state is a stronger continuation signal than wall time.
- **TaskList-sourced Unfinished** (T10d): `buildAndSaveHandoff` prefers `~/.claude/tasks/<id>/*.json` structured signals over text heuristics when no episode snapshot is available.
- **`doctor --benchmark`** (T1): baseline token/latency capture; first snapshot committed at `docs/plans/baselines/v2.30.1.json`.
- Five new helper modules: `lib/activity.mjs`, `lib/task-reader.mjs`, `lib/plan-reader.mjs`, `lib/git-state.mjs`, `lib/startup-dashboard.mjs`.

### Fixed

- **PreToolUse JSON output** (T2): `scripts/pre-tool-recall.js` now emits `{suppressOutput: true, hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext}}` instead of plain-text `console.log`. Plain-text PreToolUse stdout is silently dropped by sdscc's `messages.ts:3797` (`hook_success` filter); JSON via `hook_additional_context` works across CC variants.
- **16KB skill auto-load removed** (T4): `scripts/user-prompt-search.js` no longer injects the full body of a matched registry skill; it emits a one-line pointer so Claude can decide to invoke via SkillTool on demand.

### Changed

- **UserPromptSubmit BM25 gate** (T3): `scripts/user-prompt-search.js` now suppresses injection when the top FTS row's relevance magnitude is below `CLAUDE_MEM_UPS_BM25_MIN` (default `1e-5`, env-overridable) or the prompt's raw length is under 15 chars. Calibrated empirically via probe; plan's hinted `3.5` was six orders of magnitude off for this scoring expression.
- **Discouragement-style MCP descriptions** (T5): all 17 tool descriptions rewritten in `DO NOT use when … / USE when … / Equivalent CLI` format and centralized in `tool-schemas.mjs` (single source of truth; `server.mjs` now resolves each via `descriptionOf(name)`). Target: reduce over-invocation by 40–60% per the `mcp-tool-description-design` pattern.

### Schema

- v23: add `events` table + `events_fts` virtual table + INSERT/DELETE/UPDATE triggers (external-content FTS5 delete pattern uses real `old.*` values, not empty strings — learned during T6 implementation).
- v24: add compound index `idx_events_project_created ON events(project, created_at_epoch DESC)`.
- v25: add `session_handoffs.git_sha_at_handoff TEXT`. Placed after the existing PK-widen migration so the rebuild doesn't drop the new column.

### Internal

- Subagent-driven-development workflow: per-task spec compliance + code quality reviews, two reworks (T1 polish: FTS prepared statement hoisted out of hot loop; T9 rework: `persistHaikuSummary` wired into real capture path after initial commit left it as a dead export).

## [2.30.1] - 2026-04-12

Bug fix: `session_handoffs` no longer bleeds across parallel Claude Code sessions for the same project. Root cause was a PK-level assumption (`(project, type)`) made at the original feature landing — one row per project per type — which silently overwrote handoffs when you ran two terminals/worktrees against the same project. The visible symptom: in session A, typing a single character like `a` after session B had just `/exit`'d would inject B's entire context into A via the Stage 0 short-prompt auto-match. See `docs/bug.txt` for the full post-mortem.

### Fixed
- `session_handoffs` schema: PK widened from `(project, type)` to `(project, type, session_id)`. Schema version bumped to 22; idempotent rebuild migration preserves legacy rows and creates a new `idx_handoffs_project_time` index. Zero data loss for existing installs.
- `hook.mjs` now reads Claude Code's real `session_id` from hook stdin in `handleStop`, `handleSessionStart`, and `handleUserPrompt` — this is parallel-safe, unlike the mem plugin's file-based `getSessionId()` which collides across terminals for the same project. Falls back to the legacy id if stdin is unavailable.
- `detectContinuationIntent` / `renderHandoffInjection` gained an optional `currentCcSessionId` parameter. With it: `clear` handoffs are matched only against the session that wrote them ("continue my own /clear"), and `exit` handoffs are matched only against *other* sessions ("resume a previous session's exit"). Without it, legacy behavior is preserved for backward compatibility — no existing test or CLI call breaks.
- `detectContinuationIntent` input guard: empty / whitespace / single-character prompts can no longer trigger Stage 0 auto-injection. The `a` case from the bug report is now rejected at the entry of the function.
- `buildSessionContextLines` in `hook-context.mjs` accepts a `currentCcSessionId` so the "Working State (from /clear)" block at SessionStart is scoped to the current session, closing the secondary delivery path (SessionStart stdout block).
- `handleUserPrompt` consume-after-inject `DELETE` now includes `AND session_id = ?` — previously it would wipe out parallel sessions' clear handoffs as a side effect of consuming its own.
- `buildAndSaveHandoff` UPSERT conflict target updated to `(project, type, session_id)` so same-session re-writes (e.g. repeat `/clear`) still update in place, while parallel sessions coexist as separate rows.

### Tests
- 15 new unit tests in `tests/handoff.test.mjs` covering schema PK, parallel-session coexistence, tiny-prompt guards (`''`, `' '`, `'a'`, `'好'`), and `currentCcSessionId` filter semantics for both `detectContinuationIntent` and `renderHandoffInjection`.
- 3 new simulation tests in `tests/handoff-simulation.test.mjs` replaying the `docs/bug.txt` scenarios end-to-end: parallel sessions, single-char bleed prevention, own-clear resumption, and two-exit → fresh-session-resumes-latest.
- 1395/1395 tests green, no flakes.

## [2.30.0] - 2026-04-12

Stage 1+2 of the deep-review response: search-quality wins from filter realignment and rank tuning, plus a new quality-metrics dashboard. No breaking changes; all existing CLI/MCP surfaces are backward compatible.

### Added
- `mem stats --quality` quality dashboard. Surfaces in-window writes, lesson rate, LOW_SIGNAL title rate, per-type hit% / lesson%, top-5 most-accessed lessons, and explicit R-2 watchdog targets (lesson_rate ≥ 15%, LOW_SIGNAL ≤ 30%). Designed to be eyeballed once a day.
- `mem stats --quality` `Unresolved bugfix` sentinel — counts in-window bugfix observations whose narrative explicitly contains "not yet identified" / "still fail" / "errors persisted" patterns. Tracks the "investigation marked as fix" pollution rate so the R-6 manual-save contract can be measured over time.
- `mem search --include-noise` (CLI) and `mem_search(include_noise=true)` (MCP) opt-in flag to surface hook-llm fallback titles ("Modified X", "Worked on X", raw error logs) when explicitly auditing.
- `mem optimize --scope wide` flag — widens `findReenrichCandidates` to target bugfix/refactor/feature/decision observations that have concepts+facts populated but are missing `lesson_learned` (the "Haiku judged 'none'" cases). Single-task mode (`--task re-enrich`) now also gives the task the full `--max N` budget instead of the proportional 40% slice from `distributeBudget()`.
- `claude-mem-lite optimize` is now reachable via the top-level CLI router (was previously wired in `mem-cli.mjs` but missing from `cli.mjs`'s whitelist).
- `CLAUDE_MEM_DB_PATH` and `CLAUDE_MEM_RUNTIME_DIR` env overrides for `scripts/pre-tool-recall.js` so tests and debug tools can point the hook at an isolated DB without touching the user's real state.
- `rebuildVector` is now exported from `hook-optimize.mjs` for direct testing.

### Changed
- **Search rank**: `mem_search` and CLI `cmdSearch` now apply `notLowSignalTitleClause()` by default, mirroring the filter that was already active in `hook-memory.mjs`, `hook-context.mjs`, and `user-prompt-search.js`. ~49% of observations in production have LOW_SIGNAL titles, so explicit search results carried that much noise. Vector-side RRF merge also filters so noise can't be re-admitted via the similarity path.
- **Score formula**: `FULL_SCORE` and `SIMPLE_SCORE` (server.mjs) and `cmdSearch` SQL (mem-cli.mjs) now multiply BM25 by `(1.0 + 0.3 * (lesson_learned IS NOT NULL))`. Empirical basis: bugfix observations with lessons have +6.3pp hit rate over those without (29.5% vs 35.8%). Intentionally gentle — a rerank nudge, not a bucket.
- **PreToolUse hook reminder**: `scripts/pre-tool-recall.js` no longer exits silently when no lessons match for the file. Emits a one-line reminder asking the user to `mem save --type bugfix --lesson "..."` after solving a non-obvious bug, so the assistant gets a habit-shaping nudge. Cooldown applies to both hit and miss branches to avoid spam.
- **CLAUDE.md mem usage contract** strengthened with explicit "must cite", "must save", and "must not write 'none'" rules for Edit/Write actions and bug-solve / decision moments.

### Fixed
- **`rebuildVector` column name**: `hook-optimize.mjs` was writing `INSERT INTO observation_vectors (..., computed_at)` but the schema column is `created_at_epoch`. Every successful re-enrich silently caught a `SqliteError: no column named computed_at` and the vector was never updated. The other 8 INSERT callsites already used the correct name; this was the only drift. Surfaced during the R-7 micro-experiment with `CLAUDE_MEM_DEBUG=1`.
- **`LOW_SIGNAL_TITLE` `(error)` suffix miss**: Both the JS regex (`utils.mjs`) and the SQL clause (`scoring-sql.mjs`) only matched the literal title `(error)` (exact equality). Tool-fragment titles like `"gh release list ... (error)"` — generated by `makeEntryDesc()` when a tool call fails — leaked through in 110 observations (~4% of the wide-scope re-enrich pool). The regex now has `\(error\)$` as a top-level alternative; the SQL clause uses `title NOT LIKE '%(error)'` (subsumes the original exact-match). Both files reference each other in comments to prevent future drift.
- **Date-arithmetic test flake**: `tests/e2e.test.mjs` `auto-compress weekly summary` test computed `Date.now() - 90d` and added 0..3 hours, expecting all four observations to fall in the same ISO week. Triggered ~once a week when the wall-clock crossed a Sunday→Monday boundary, splitting the four into two ISO weeks and tripping the `obs.length < 3` floor. Fix: anchor to a Wednesday-noon-UTC epoch ≥95 days ago, guaranteed mid-week regardless of when the test runs.

### Performance / Quality
- Search noise reduced ~49% on default queries (LOW_SIGNAL filter now applied to explicit search paths).
- Lesson-bearing observations get a +30% rank boost in all search expressions (FULL_SCORE / SIMPLE_SCORE / cmdSearch).

### Tests
- 1376 tests total (was 1333 at the start of this release window). +43 new TDD-written tests covering R-1 / R-3 / R-4 / R-7 micro / N-1 / Bug #1 / Bug #2 / N-1 ext.

## [2.11.2] - 2026-03-17

### Fixed
- Stopped `setup.sh` from clearing marketplace `.mcp.json` on every SessionStart, which caused MCP server registration to disappear after plugin updates. Claude Code copies `.mcp.json` from marketplace → cache, so clearing the marketplace copy broke the chain.

## [2.10.4] - 2026-03-16

### Fixed
- Made plugin SessionStart MCP cleanup idempotent so old direct-install `mem` entries in `~/.claude.json` are removed even if an earlier migration marker already exists.
- Added a regression test covering stale global `mem` cleanup when older dedup markers are present.

## [2.10.3] - 2026-03-16

### Fixed
- Restored real Claude Code plugin MCP registration by moving `.mcp.json` back to the plugin root, which is the location Claude Code actually loads for marketplace installs.
- Kept duplicate-avoidance focused on removing stale global `mem` registrations and stale marketplace copies instead of moving the plugin MCP manifest out of the root.

## [2.10.1] - 2026-03-16

### Changed
- Moved the MCP source manifest to `claude-plugin/.mcp.json` in the repository as a first step toward removing marketplace-root duplication.

## [2.10.0] - 2026-03-16

### Changed
- Moved the plugin-mode MCP manifest to `.claude-plugin/.mcp.json` so the package layout matches Claude Code's plugin loader behavior.
- Aligned release metadata across `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.

### Fixed
- Duplicate `mem` MCP registration caused by a root-level `.mcp.json` being loaded through both marketplace root scanning and plugin cache loading.
- Stale pre-2.10 marketplace installs now clear the old root `.mcp.json` and legacy global `mem` registration during migration.

## [2.0.0] - 2026-02-10

### Added
- **v3 intelligent skill/agent dispatch system** — 3-tier progressive architecture (fast filter, context signals, FTS5 retrieval, Haiku semantic fallback)
- Closed-loop feedback tracking for dispatch recommendations (adoption + outcome scoring)
- Resource registry database with FTS5 indexing for skills/agents
- Registry scanner, indexer, and retriever modules
- Comprehensive test suite: 470 tests across 14 files (smoke, contract, unit, integration, property, E2E)
- Property-based tests via fast-check (Jaccard, MinHash, FTS5 invariants)
- Benchmark infrastructure with CI regression gate (5% tolerance)
- Pseudo-relevance feedback (PRF) for query expansion
- Concept co-occurrence expansion for improved recall
- Directory-level re-ranking with active file overlap
- Adaptive time windows based on session activity velocity
- Semantic synonym expansion (48+ pairs) in FTS5 queries
- FTS5 snippets in search results
- Fact extraction from observations
- Token-budgeted observation selection for session-start injection
- Structured logging (`debugLog`/`debugCatch`) gated by `CLAUDE_MEM_DEBUG`
- MinHash signature-based cross-session deduplication (7-day window)
- Observation compression (`mem_compress`) for archiving old entries
- Access count tracking with logarithmic boost in search scoring
- Zod schema validation for all MCP tool inputs
- Contract tests ensuring schema compliance
- Plugin marketplace support (`.claude-plugin/`)
- `doctor` and `status` CLI commands for diagnostics
- Bilingual README (English + Chinese)
- `CLAUDE_MEM_DIR` environment variable for custom data directory

### Changed
- Renamed database from `claude-mem.db` to `claude-mem-lite.db` (auto-migration on startup)
- Refactored monolithic `hook.mjs` into focused modules: `hook-episode.mjs`, `hook-context.mjs`, `hook-semaphore.mjs`, `hook-shared.mjs`, `hook-llm.mjs`
- Consolidated database schema into single-source-of-truth `initSchema()` in `schema.mjs`
- Extracted shared utilities to `utils.mjs` (Jaccard, MinHash, secret scrubbing, Bash analysis)
- Upgraded BM25 column weights for better relevance ranking
- Improved recency decay formula (14-day half-life)

### Fixed
- N+1 queries in observation retrieval
- TOCTOU race conditions in episode buffer and lock management
- SQL injection prevention: all queries parameterized, FTS5 identifiers validated
- Stale lock file recovery (PID-aware + timeout-based cleanup)
- Session deduplication before unique index creation (migration safety)
- Large stdin silent discard (256KB truncation with regex salvage)
- Compress summary drift across weekly boundaries
- FTS5 query sanitization for special characters and boolean keywords
- Cold start behavior (graceful when no observations exist)
- Project isolation in cross-session dedup
- Semaphore atomicity for concurrent LLM calls

### Security
- Secret scrubbing: 15+ credential patterns (AWS, OpenAI, GitHub, GitLab, Slack, JWT, PEM, DB URLs, Stripe, npm)
- Atomic writes (tmp + rename) prevent data corruption on crash
- SIGTERM/SIGINT signal handlers flush episode buffers safely
- File path sanitization prevents directory traversal
- Error messages scrubbed of stack traces before user-facing output

## [1.0.0] - 2026-01-20

### Added
- Initial release of claude-mem-lite
- MCP server with 7 tools: `mem_search`, `mem_timeline`, `mem_get`, `mem_save`, `mem_stats`, `mem_delete`, `mem_compress`
- Hook system: PostToolUse, PreToolUse, SessionStart, Stop, UserPromptSubmit
- Episode batching (10 entries or 5-minute gap) for efficient LLM encoding
- FTS5 full-text search with BM25 ranking
- Background LLM workers (Haiku) for observation encoding
- Graceful degradation: saves with inferred metadata when LLM fails
- SQLite WAL mode for concurrent access
- Bash pre-filter (~5ms) for noise suppression
- User prompt capture and scrubbing
- Error-triggered recall (searches memory on Bash failures)
- Proactive file history on edit operations
- CLAUDE.md context injection at session start
- Three installation methods: plugin marketplace, npx, git clone
- Smart installer with migration from original claude-mem
