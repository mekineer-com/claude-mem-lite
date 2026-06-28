# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 3.23.0
- **Package manager**: npm
- **Test**: `npx vitest run` (171 test files / 3372 tests, vitest)
- **Lint**: `npx eslint .`
- **Benchmark**: `node benchmark/benchmark.mjs` (local micro-bench) · `node benchmark/longmemeval.mjs <dataset>` (standard LongMemEval recall, lexical baseline — see `benchmark/datasets/README.md`)
- **Denoising A/B** (evaluate any precision/recall lever BEFORE shipping): `node benchmark/denoise-ab.mjs --save before.json` (control) → apply the change → `node benchmark/denoise-ab.mjs --compare before.json` (verdict). Runs BOTH the precision hard-negative AND vocab-mismatch paraphrase suites so a lever's precision gain and recall cost are weighed on one screen — the split that let an OR-BM25 floor ship-then-revert (2026-06-29). Verdict: REJECT / TRADEOFF / NET-POSITIVE / NEUTRAL.
- **DB**: better-sqlite3 + FTS5 full-text search
- **Node**: >=20, ESM (`"type": "module"`)

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
| `registry-recommend.mjs` | Intent-based skill recommendation (shadow-first): 4-gate precision filter over installed skills, append-only shadow log, `Skill`-adoption probe. Funnel reports session-keyed matched precision + per-skill **lift** (P(adopt\|gate PASS) ÷ organic base rate); `computeSweep`/`replayGate` re-run the gate offline at swept (floor,margin) from each reco's logged replay vector (ROC calibration). Mode via `CLAUDE_MEM_RECOMMEND_MODE` (shadow\|live\|off, default shadow) |
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
- Skill recommendation (shadow-first): `CLAUDE_MEM_RECOMMEND_MODE=shadow|live|off` (default `shadow`). Phase 1 logs would-be recommendations to `RUNTIME_DIR/recommendations/*.jsonl` (zero injection); reco rows carry a CC `session` id + a replay vector (relevance/rel2/intentTop/cooldownTop), adopt rows carry the same `session` so PostToolUse adoptions pair to the reco in-session. Inspect with `claude-mem-lite registry recommend-stats [--days N] [--sweep]`: funnel = session-keyed matched precision + per-skill lift; `--sweep` = offline ROC over (floor,margin). Calibration caveat: shadow adoption is a biased-LOW proxy for live `P(adopt|inject)`, so the flip metric is **lift > 1** (gate beats organic base rate) + per-session PASS density, NOT a raw-precision threshold (single-dev volume never reaches significance). Live injection (UserPromptSubmit, sibling to the T4 explicit-name pointer) is Phase 2. Adoption = `Skill` tool only (`mem_use` is pre-filtered in PostToolUse).

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
| grep + AST context | `code-graph-mcp grep "pat" [paths]` |

Still use Grep for literal strings/regex in non-code files; still Read files you'll edit.
Full command + MCP-tool table: `.claude/plugin_code_graph_mcp.md`
<!-- code-graph-mcp:end -->
