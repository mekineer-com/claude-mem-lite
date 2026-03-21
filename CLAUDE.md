# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.17.1
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
Request: 以使用者的身份模拟测试claude-mem-lite项目的各个功能（MCP工具、CLI命令、hook系统），检查用户体验，发现问题就修复，评估是否有效提高Claude编程效率。这是第2/3轮或第3/3轮测试（第1轮已在调度时立即执行）。如…
Remaining: npx vitest run tests/hook-context.test.mjs tests/… → RUN  v4.0.18 /mnt/data_ssd/dev/projects/mem   ✓ tests/memor…; npx …

### Key Context
- [bugfix] Error: server.mjs, tool-schemas.mjs: mem 5 results for memory search optimizati… (#4523)
- [discovery] Worked on schema.mjs, hook.mjs (#4521)
- [bugfix] Error: phase1-temporal.test.mjs: in_progress running CI 2026-03-21T11:42:36Z co… (#4515)
- [feature] Add rebuild_vectors operation to mem MCP server (#4512)
- [bugfix] Error: eslint.config.mjs, mem-cli.mjs: Saved working directory and index state … (#4508)

### Working State (from /clear)
- Working on: 以使用者的身份模拟测试claude-mem-lite项目的各个功能（MCP工具、CLI命令、hook系统），检查用户体验，发现问题就修复，评估是否有效提高Claude编程效率。这是第2/3轮或第3/3轮测试（第1轮已在调度时立即执行）。如果这是第3轮，完成后用CronDelete取消此任务。
- Unfinished: npx vitest run tests/hook-context.test.mjs tests/… → RUN  v4.0.18 /mnt/data_ssd/dev/projects/mem   ✓ tests/memor…; npx vitest run tests/user-prompt-search.test.mjs … → RUN  v4.0.18 /mnt/data_ssd/dev/…
- Key files: mem-cli.mjs

</claude-mem-context>
