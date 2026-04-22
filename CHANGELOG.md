# Changelog

All notable changes to claude-mem-lite are documented in this file.

## [Unreleased]

**Write-side signal quality (P0-P4).** Diagnostic on projects--mem 30d data found 52% of observations were LOW_SIGNAL auto-titles (`Modified X`, `Error:`, `Worked on`) with empty facts / null lesson — noise that inflates the FTS index and crowds recall. This release blocks them at insert time.

### Added

- **`lib/low-signal-patterns.mjs::isNoiseObservation()`** — write-side filter called from `hook-llm.mjs:saveObservation`. Drops observations where title matches LOW_SIGNAL pattern AND no downstream signal (no lesson, importance<2, empty facts, narrative <40 chars / raw stderr). Expected impact on projects--mem: 30d low-signal drops 164 → ~40-60.
- **`CLAUDE_MEM_KEEP_LOW_SIGNAL=1`** env var — opt-out flag that preserves pre-v2.36 insert-everything behavior. For users who want to audit hook capture end-to-end without the filter.

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
