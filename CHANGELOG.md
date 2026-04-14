# Changelog

All notable changes to claude-mem-lite are documented in this file.

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
