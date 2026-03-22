# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.20.0
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
Completed: Reviewed 2 files: tool-schemas.mjs, server.mjs; Modified server-internals.mjs, server.mjs; Modified prompt-search-utils…

### Key Context
- [discovery] Reviewed 2 files: tool-schemas.mjs, server.mjs (#4776)
- [discovery] Reviewed 7 files: server.mjs, package.json, vitest.config.mjs, install.mjs +3 m… (#4749)
- [discovery] Reviewed 9 files: server.mjs, hook-update.mjs, hook.mjs, install.mjs +5 more (#4745)
- [bugfix] Fix PRF term extraction alignment with synonym handling (#4712) — PRF term extraction logic must match vocabulary indexing se…
- [discovery] Reviewed 6 files: schema.mjs, server.mjs, hook-llm.mjs, tool-schemas.mjs +2 more (#4694)

### Working State (from /clear)
- Working on: “以使用者的身份模拟测试一下该项目的各个功能包括用户体验,发现问题就修复问题，体验看能有效地提高claude的编程效率不。”使用loop插件循环执行三遍。ultrathink

</claude-mem-context>
