# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.18.0
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
Request: Check current project's existing functionality, update README.md documentation, merge and clean branches, commit code a…
Completed: Updated memory system documentation with TF-IDF vector encoding module for semantic search (tfidf.mjs module, observati…
Remaining: README.md alignment with TF-IDF feature, branch cleanup, git commit and push, version release creation, GitHub CI/CD ve…
Next: 1. Update README.md documenting TF-IDF vector encoding feature 2. Clean and merge feature branches 3. Commit changes wi…
Lessons: TF-IDF vector encoding provides semantic search capability beyond keyword matching - converts observations into comparable vectors for relevance ranking
Decisions: Dedicated tfidf.mjs module for vector encoding instead of inline utilities - improves modularity and testability; Replaced utils.mjs with dedicated TFIDF module - cleaner separation of concerns for semantic search operations

### Key Context
- [feature] TF-IDF vector encoding for semantic memory search (#4571) — TF-IDF vector encoding layers semantic similarity search on…
- [change] Modified schema.mjs, tfidf.mjs, server.mjs +1 more (#4550)
- [discovery] Reviewed 1 files: 2026-03-21-hybrid-search-and-search-quality.md (#4542)
- [discovery] Reviewed 4 files: server.mjs, utils.mjs, schema.mjs, hook.mjs (#4533)
- [bugfix] Error: utils.mjs: CJK sentence: (数据库 OR database OR db) CJK questio… (#4531)

</claude-mem-context>
