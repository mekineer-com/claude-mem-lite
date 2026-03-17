# claude-mem-lite

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

## Quick Reference

- **Version**: 2.11.1
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
Request: Commit code and release a new version
Completed: Version bump from 2.10.7 to 2.11.0; commit created via commit-commands:commit skill
Remaining: Push to remote; create/merge PR; actual release creation (tag/publish); verify marketplace.json presence if needed
Next: Push the commit to remote branch; create PR if needed for review; tag release and publish to distribution channels
Lessons: Marketplace.json may not exist in all project variants — conditional presence should be documented
Decisions: Minor version bump (2.10.7 → 2.11.0) selected for release, indicating new feature(s) rather than patch

### Key Context
- [bugfix] Address code review findings in dispatch module (#4004)
- [discovery] Reviewed 9 files: mem, hook.mjs, dispatch.mjs, utils.mjs +5 more (#3997)
- [bugfix] Error: dispatch.mjs: 92341f7 feat(registry): add quality_tier, categor… (#3994)
- [bugfix] Error: contract.test.mjs, dispatch.test.mjs: ✓ accumulates multiple scores 1ms … (#3989)
- [bugfix] Error: server.mjs: main 00ce865 feat(dispatch): simplify to explicit… (#3984)

</claude-mem-context>
