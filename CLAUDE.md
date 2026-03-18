# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.13.0
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
| `schema.mjs` | DB schema definitions and migrations |
| `utils.mjs` | FTS query sanitization, synonym expansion, token estimation, project domain detection |
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
Request: 我们项目现在在实际工作中很少调用，因为claude code对mcp的调用是选择性的，所以不能很好地结合claude code 发挥我们项目的优势提高编程效率。我在网上看到一种方案：“先把 Claude Code 内的“被动 MCP”改成…
Completed: Modified imperative-baking-hamster.md
Remaining: Created imperative-baking-hamster.md (11514 chars)

### Key Context
- [discovery] Worked on README.md, architecture.md, hook-system.md +6 more (#4141)
- [change] Modified docs, README.md, architecture.md +7 more (#4140)
- [bugfix] Error: package.json, plugin.json, marketplace.json +2 more: in_progress		chore:… (#4129)
- [bugfix] Error: dispatch.mjs, dispatch-workflow.mjs: buildQueryFromText(playwright) → pl… (#4118)
- [discovery] Worked on hook.mjs, hook-shared.mjs, schema.mjs (#4117)

### Working State (from /clear)
- Working on: 我们项目现在在实际工作中很少调用，因为claude code对mcp的调用是选择性的，所以不能很好地结合claude code 发挥我们项目的优势提高编程效率。我在网上看到一种方案：“先把 Claude Code 内的“被动 MCP”改成“主动 hook + skill + CLI 注入”。这是最快见效的桥接方案，而且是官方支持的。Claude Code 的 hooks 是确定性的，官方明确说它…
- Unfinished: Created imperative-baking-hamster.md (11514 chars)
- Key files: imperative-baking-hamster.md

</claude-mem-context>
