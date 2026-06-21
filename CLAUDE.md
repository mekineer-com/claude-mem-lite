# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 3.4.0
- **Package manager**: npm
- **Test**: `npx vitest run` (61 test files, vitest)
- **Lint**: `npx eslint .`
- **Benchmark**: `node benchmark/benchmark.mjs` (local micro-bench) · `node benchmark/longmemeval.mjs <dataset>` (standard LongMemEval recall, lexical baseline — see `benchmark/datasets/README.md`)
- **DB**: better-sqlite3 + FTS5 full-text search
- **Node**: >=18, ESM (`"type": "module"`)

## Health Stack

Used by `/health` skill (gstack). Persisted here so detection skips runtime probing.

- typecheck: (skip — pure JS/ESM, no TS in repo)
- lint: ./node_modules/.bin/eslint .
- test: ./node_modules/.bin/vitest run
- deadcode: ./node_modules/.bin/knip
- shell: shellcheck scripts/post-tool-use.sh scripts/pre-commit.sh scripts/setup.sh

Knip baseline (2026-06-05): 0 unused files, 51 unused exports. Two categories:
(a) intentional — v2.21 utils.mjs split backward-compat re-exports + test-only
exports (search-engine.mjs FTS/count helpers, ftsRowToResult) used internally and
by tests; do NOT remove without audit. (b) NOT intentional — the v3 dispatch/
invocation-feedback CRUD in registry.mjs was confirmed dead (0 refs) and DELETED
in 2026-06; if invocation-stats functions reappear in this list they are rot from a
reverted feature, not back-compat. Plus 1 duplicate-name export pair
(FALLBACK_OBS_WINDOW_MS = RELATED_OBS_WINDOW_MS, intentional alias). Treat baseline
as the floor; flag NEW unused exports as PR review signal.

## Architecture

| Module | Role |
|--------|------|
| `cli.mjs` | CLI entry point — routes subcommands to mem-cli.mjs or install.mjs |
| `mem-cli.mjs` | CLI commands: search, recent, recall, get, timeline, save, delete, update, export, compress, maintain, fts-check, stats, context, browse, registry |
| `hook.mjs` | Main hook entry — handles session-start/stop/post-tool-use/user-prompt |
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
| `tfidf.mjs` | TF-IDF vector engine — tokenization, vocabulary, vectors, cosine similarity, RRF merge |
| `tier.mjs` | Temporal tier system — activity-based time window classification |
| `schema.mjs` | DB schema definitions and migrations (incl. vocab_state, observation_vectors) |
| `utils.mjs` | FTS query sanitization, synonym expansion, CJK extraction, token estimation |
| `scripts/post-tool-use.sh` | Bash fast pre-filter (~5ms, skips low-value tools) |
| `scripts/user-prompt-search.js` | UserPromptSubmit hook — auto-search memory on user prompts |

## Key Patterns

- CLI commands: `claude-mem-lite search|recent|recall|get|timeline|save|delete|update|export|compress|maintain|optimize|fts-check|stats|context|browse|registry`
- Tool name mapping: Claude Code Agent tool = `'Agent'` (not `'Task'`); Skill via `event.tool_input?.skill`
- Tests use `:memory:` DB — schema changes must sync to test files
- FTS5 search: sanitizeFtsQuery (synonym expansion) → BM25 scoring → OR fallback → concept co-occurrence
- Context delivery: SessionStart hook stdout emits the `<claude-mem-context>` block fresh from DB; CLAUDE.md is no longer auto-updated (pre-v2.30 left a stale snapshot here)
- Skill commands (`/search`, `/recall`, `/recent`, `/timeline`) use `!` preprocessing for CLI injection

## Mem usage contract (applies to ALL sessions touching this repo)

This project *is* the memory plugin. Dogfood it. The rules below override soft "proactive trigger"
language in the MCP tool description — when the two conflict, this contract wins.

**Before you Read, Edit, or Write any code file**: the PreToolUse hook
(`scripts/pre-tool-recall.js`) has already run `mem_recall` for that file. Read mode is
asymmetric-quiet (1 lesson, 120-char cap, requires `lesson_learned`); Edit/Write is
decision-support (up to 3 lessons, 240-char cap, admits high-importance bugfix/decision
without lesson when title is non-LOW_SIGNAL). Read→Edit on the same file in one session
shares cooldown for the lesson BODIES (no double injection), but since v2.98 the first
Edit after a Read-time injection re-surfaces the lesson IDs as a one-line ack directive —
answer it ('#NN applied' or '#NN n/a — <reason>') in your next user-facing text; Edit-path
lesson blocks carry the same directive (opt-out: CLAUDE_MEM_SALIENCE=legacy). Rationale:
the #8651 severe test showed passively-framed lessons get ignored ~50% of the time even
when on-topic. If you saw lines like `#NN [bugfix] ...`, cite `#NN`
the NEXT time you produce user-facing text — tool-only follow-up turns don't satisfy this;
carry the IDs in working memory and cite when you write back. The plugin tracks citation
outcomes per session: un-cited lessons auto-decay (importance −1 after 3 consecutive uncited
sessions; floor 0) and cited lessons auto-promote (importance +1, capped at 3). The injection
pool self-tunes from your behavior — citing is feedback to the system, not a compliance ritual.

**After solving a non-trivial bug** (≠ typo fix, ≠ rename): you **must** call
`mem_save(type='bugfix', lesson_learned='<one-line root cause + one-line fix>',
importance=2)`. Test: could a future session touching the same file have avoided this bug
if they'd seen the lesson? If yes → save it. If no → it wasn't a real bug fix.

**After making a non-obvious architectural decision** (≠ renaming, ≠ moving code): call
`mem_save(type='decision', lesson_learned='<constraint + why this choice + what it trades off>')`.
Empirical note: `decision` observations retrieve at a materially higher cite-rate than
`change` (~3:1 in current telemetry; an older 2026-05 snapshot read ~20:1 but that magnitude
no longer holds — re-measure with `claude-mem-lite stats` rather than trusting a fixed
number). The direction is robust: a good decision memory is worth several change memories.
Do not inflate this — decision is reserved for real tradeoffs, not style choices.

**When deferring work to a future session** (≠ in-flight todo, ≠ this-PR follow-up):
call `mem_defer({title: '<one-line subject>', priority: <1|2|3>, detail: '<constraint + why deferred>'})`.

Triggers (bilingual):
- 中文: "下次/下个会话/留给独立 session/不在本轮范围/留给下个会话"
- en: "next session / defer to next round / out of scope for this PR / pick up later"
- explicit user wrap-up: "记一下，下次处理 X" / "remember to do Y next time"

When you fix a deferred item, **must** add `closes_deferred=[N]` to the `mem_save`
call so the carry-forward chain closes properly. `N` is the per-project ordinal
shown in the SessionStart `### Deferred Work` banner (e.g. `closes_deferred=[1]`),
or the raw id as `closes_deferred=["D#42"]`. Mixed array is OK.

If the deferred item turned out to not need fixing (flaky test, scope shift),
use `mem_defer_drop({id: <D#N|ordinal>, reason: '...'})` instead. The reason is
required and forms the audit trail for "why no fix shipped".

**Do not write `lesson_learned: 'none'` just to satisfy the schema.** Either write a lesson
that a future session could actually use, or leave the field NULL and accept a low-importance
observation. The Haiku prompt defaults to "none" far too aggressively; when you save manually,
you override that default.

**When searching memory via CLI/MCP**: default search now excludes low-signal fallback titles
(`Modified X`, `Worked on X`, raw error logs). If you're auditing or specifically hunting a
file-change record, pass `--include-noise` (CLI) or `include_noise=true` (MCP).
