# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.28.2
- **Package manager**: npm
- **Test**: `npx vitest run` (44 test files, vitest)
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
| `hook-optimize.mjs` | LLM-powered optimization: re-enrich, normalize, cluster-merge, smart-compress |
| `server.mjs` | MCP server — mem_search/mem_recent/mem_save/mem_get/mem_recall/mem_timeline/mem_delete/mem_update/mem_export/mem_compress/mem_maintain/mem_optimize/mem_fts_check/mem_stats/mem_registry/mem_browse |
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
- CLAUDE.md persistence: `updateClaudeMd()` replaces context block between start/end tags atomically
- Skill commands (`/search`, `/recall`, `/recent`, `/timeline`) use `!` preprocessing for CLI injection

<claude-mem-context>
### Last Session
Request: No user request has been made yet
Remaining: Awaiting user instruction for this session
Next: User to provide task or request

### Key Context
- [discovery] Worked on server.mjs, schema.mjs (#5801)
- [change] Modified schema.mjs, hook-memory.mjs, tool-schemas.mjs +1 more (#5793)
- [discovery] Reviewed 15 files: server.mjs, tool-schemas.mjs, post-tool-use.sh, user-prompt-… (#5782)
- [discovery] Reviewed 2 files: server.mjs, tool-schemas.mjs (#5780)
- [change] Modified cli-e2e.test.mjs, cli.test.mjs (#5731)

</claude-mem-context>
