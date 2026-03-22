# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.24.0
- **Package manager**: npm
- **Test**: `npx vitest run` (35 test files, vitest)
- **Lint**: `npx eslint .`
- **Benchmark**: `node benchmark/benchmark.mjs`
- **DB**: better-sqlite3 + FTS5 full-text search
- **Node**: >=18, ESM (`"type": "module"`)

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
| `server.mjs` | MCP server — mem_search/mem_recent/mem_save/mem_get/mem_recall/mem_timeline/mem_delete/mem_update/mem_export/mem_compress/mem_maintain/mem_fts_check/mem_stats/mem_registry/mem_browse |
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

- CLI commands: `claude-mem-lite search|recent|recall|get|timeline|save|delete|update|export|compress|maintain|fts-check|stats|context|browse|registry`
- Tool name mapping: Claude Code Agent tool = `'Agent'` (not `'Task'`); Skill via `event.tool_input?.skill`
- Tests use `:memory:` DB — schema changes must sync to test files
- FTS5 search: sanitizeFtsQuery (synonym expansion) → BM25 scoring → OR fallback → concept co-occurrence
- CLAUDE.md persistence: `updateClaudeMd()` replaces context block between start/end tags atomically
- Skill commands (`/search`, `/recall`, `/recent`, `/timeline`) use `!` preprocessing for CLI injection

<claude-mem-context>
### Last Session
Request: Simulate comprehensive CLI feature and user experience testing for claude-mem-lite project (all commands), identify and…
Completed: Added --version command support to CLI; modified install.mjs, cli.mjs, mem-cli.mjs to enhance search and install comman…
Remaining: Complete comprehensive CLI testing of all commands (mem_search, mem_recent, mem_get, mem_timeline, mem_save, mem_update…
Next: Continue loop-driven testing iterations 2-3; systematically test each CLI command with various arguments; validate user…
Lessons: CLI tool registration patterns require explicit command case matching in both cli.mjs and downstream command handlers; Version flag support is standard user expectation and should be added early in CLI development
Decisions: Added --version command to improve CLI standard compliance and user experience

### Key Context
- [feature] Add --version command support to claude-mem-lite CLI (#4992)
- [bugfix] Error: mem-cli.mjs: mem 5 results for error: #4957 🔍 2026-03-22 Work… (#4979)
- [bugfix] Error: install.mjs, cli.mjs: mem 3 results for fix test failure: #4717 🟢 2026… (#4974)
- [bugfix] Error: CLAUDE.md: title:	v2.23.1 tag:	v2.23.1 draft:	false prerelea… (#4971)
- [discovery] Worked on hook.mjs, registry-scanner.test.mjs, test-helpers.mjs +3 more (#4957)

</claude-mem-context>
