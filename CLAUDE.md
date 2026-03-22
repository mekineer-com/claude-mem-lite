# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.19.0
- **Package manager**: npm
- **Test**: `npx vitest run` (24 test files, vitest)
- **Lint**: `npx eslint .`
- **Benchmark**: `node benchmark/benchmark.mjs`
- **DB**: better-sqlite3 + FTS5 full-text search
- **Node**: >=18, ESM (`"type": "module"`)

## Architecture

| Module | Role |
|--------|------|
| `cli.mjs` | CLI entry point — routes subcommands to mem-cli.mjs or install.mjs |
| `mem-cli.mjs` | CLI commands: search, recent, recall, get, timeline, save, stats, context |
| `hook.mjs` | Main hook entry — handles session-start/stop/post-tool-use/user-prompt |
| `hook-context.mjs` | CLAUDE.md context injection, adaptive time windows, token budgeting |
| `hook-llm.mjs` | Haiku-based summarization and title generation |
| `hook-memory.mjs` | Semantic memory injection on user prompt |
| `hook-episode.mjs` | Episode batching for observations |
| `hook-handoff.mjs` | Cross-session handoff state (/clear, /exit continuity) |
| `hook-shared.mjs` | Shared constants/utilities (RUNTIME_DIR, session mgmt) |
| `hook-semaphore.mjs` | Concurrency control for hook execution |
| `hook-update.mjs` | Auto-update via GitHub Releases (24h check, dev-mode skip) |
| `server.mjs` | MCP server — mem_search/mem_save/mem_get/mem_timeline etc. |
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

- CLI commands: `claude-mem-lite search|recent|recall|get|timeline|save|stats|context`
- Tool name mapping: Claude Code Agent tool = `'Agent'` (not `'Task'`); Skill via `event.tool_input?.skill`
- Tests use `:memory:` DB — schema changes must sync to test files
- FTS5 search: sanitizeFtsQuery (synonym expansion) → BM25 scoring → OR fallback → concept co-occurrence
- CLAUDE.md persistence: `updateClaudeMd()` replaces context block between start/end tags atomically
- Skill commands (`/search`, `/recall`, `/recent`, `/timeline`) use `!` preprocessing for CLI injection

<claude-mem-context>
### Last Session
Request: Implement atomic TF-IDF indexing and searchable storage for user prompts in the memory system, refactor shared utilitie…
Completed: Created user-prompt-search.js (7554 bytes) with atomic search implementation; created prompt-search-utils.mjs (2805 byt…
Remaining: Fix test suite failures: tests/user-prompt-search.test.mjs (unspecified failures); tests/registry-retriever.test.mjs (S…
Next: 1) Investigate schema.mjs to verify resources table column definition matches test expectations; 2) Run full vitest sui…
Lessons: Schema changes require coordinated updates in both database creation code and test fixtures—column mismatches (stars column absence) break tests across multiple files; Extracting utilities to separate modules improves reusability but creates hidden dependencies between test files and refactored modules; import paths become fragile; Atomic transactions (saveTx) for observation insertion add complexity—must ensure all observation types (decision, bugfix, feature, etc.) maintain referential integrity across observations and observation_files tables
Decisions: Implemented atomic TF-IDF indexing using saveTx transactions—ensures observations and file vectors are inserted atomically, preventing partial state on failure; Extracted utilities to dedicated prompt-search-utils.mjs module—centralized shared functions (jaccardSimilarity, truncate, typeIcon) reduces duplication and improves maintainability across server-internals.mjs, registry-retriever.mjs, and nlp.mjs; Modified scoring-sql.mjs as separate module rather than inline—enables reuse and testability of SQL-based scoring logic but introduces module dependency chain that caused hook-llm test failures

### Key Context
- [feature] Atomic TF-IDF indexing for user prompt search (#4662) — Full-text search consistency requires atomic transactions —…
- [refactor] Export expandToken + add scoring-sql module causes hook-llm test failure (#4653) — Exporting internal utilities without updating test setup/mo…
- [refactor] Normalize error handling comment in schema.mjs catch block (#4642)
- [change] Modified server-internals.mjs, tests, schema.mjs +1 more (#4639)
- [discovery] Reviewed 4 files: mem, test-helpers.mjs, schema.mjs, registry-retriever.mjs (#4638)

</claude-mem-context>
