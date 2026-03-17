# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.11.3
- **Package manager**: npm
- **Test**: `npx vitest run` (29 test files, vitest)
- **Lint**: `npx eslint .`
- **Benchmark**: `node benchmark/benchmark.mjs`
- **DB**: better-sqlite3 + FTS5 full-text search
- **Node**: >=18, ESM (`"type": "module"`)

## Architecture

| Module | Role |
|--------|------|
| `hook.mjs` | Main hook entry — handles session-start/stop/post-tool-use/pre-tool-use/user-prompt |
| `hook-context.mjs` | CLAUDE.md context injection, adaptive time windows, token budgeting |
| `hook-llm.mjs` | Haiku-based summarization and title generation |
| `hook-memory.mjs` | Type-aware idle session cleanup |
| `hook-episode.mjs` | Episode batching for observations |
| `hook-handoff.mjs` | Cross-session handoff state (/clear, /exit continuity) |
| `hook-shared.mjs` | Shared constants/utilities (RUNTIME_DIR, session mgmt) |
| `hook-semaphore.mjs` | Concurrency control for hook execution |
| `hook-update.mjs` | Auto-update via GitHub Releases (24h check, dev-mode skip) |
| `server.mjs` | MCP server — mem_search/mem_save/mem_get/mem_timeline etc. |
| `dispatch.mjs` | 3-tier resource dispatch: Tier0 fast filter → Tier1 context signals → Tier2 FTS5; phase-transition gating |
| `dispatch-inject.mjs` | Tiered recommendation rendering (full injection / one-line hint / silent) |
| `dispatch-patterns.mjs` | Sliding-window failure pattern detection (repeated-test-fail, repeated-bash-error, blind-editing) |
| `dispatch-feedback.mjs` | Adoption detection + result feedback |
| `dispatch-workflow.mjs` | Workflow-aware dispatch patterns |
| `registry.mjs` | Resource registry DB schema + CRUD |
| `registry-retriever.mjs` | FTS5 search + BM25 composite scoring + domain filtering |
| `registry-indexer.mjs` | Resource indexing pipeline |
| `schema.mjs` | DB schema definitions and migrations |
| `utils.mjs` | FTS query sanitization, synonym expansion, token estimation |
| `scripts/post-tool-use.sh` | Bash fast pre-filter (~5ms, skips low-value tools) |

## Key Patterns

- Tool name mapping: Claude Code Agent tool = `'Agent'` (not `'Task'`); Skill via `event.tool_input?.skill`
- Tests use `:memory:` DB with independent `createRegistryDb()` — schema changes must sync to test files
- `filterByProjectDomain()` only filters resources with tech tags; pure functional tags always pass
- FTS5 search: sanitizeFtsQuery (synonym expansion) → BM25 scoring → OR fallback → concept co-occurrence
- CLAUDE.md persistence: `updateClaudeMd()` replaces context block between start/end tags atomically

<claude-mem-context>
### Last Session
Request: 这下有了，需要发版本不，其它用户安装插件不会遇到这问题吧

### Key Context
- [change] Bump plugin version from 2.11.0 to 2.11.1 (#4036)
- [bugfix] Error: hook-llm.mjs, server.mjs, utils.mjs +1 more: When ID 1055 was saved (202… (#4033)
- [bugfix] Error: hook-shared.mjs: === FIRST 5 in chronological order === 1. ID 1039… (#4032)
- [bugfix] Error: mem: === Error while working on daagu (IDs, titles, ti… (#4031)
- [discovery] 44 duplicate episode title prefixes found in observation summaries (#4030)

</claude-mem-context>
