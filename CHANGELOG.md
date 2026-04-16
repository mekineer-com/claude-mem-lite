# Changelog

All notable changes to claude-mem-lite are documented in this file.

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
