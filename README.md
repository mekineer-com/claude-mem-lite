[English](README.md) | [中文](README.zh-CN.md)

# claude-mem-lite

Lightweight persistent memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Automatically captures coding observations, decisions, and bug fixes during sessions, then provides full-text search to recall them later.

Built as an [MCP server](https://modelcontextprotocol.io/) + Claude Code hooks. Zero external services, single SQLite database, minimal overhead.

## Why claude-mem-lite?

A ground-up redesign of [claude-mem](https://github.com/thedotmack/claude-mem), replacing its heavyweight architecture with a smarter, leaner approach.

### Architecture comparison

| | claude-mem (original) | claude-mem-lite |
|---|---|---|
| **LLM calls** | Every tool use triggers a Sonnet call | Only on episode flush (5-10 ops batched) |
| **LLM input** | Raw `tool_input` + `tool_output` JSON | Pre-processed action summaries |
| **Conversation** | Multi-turn, accumulates full history | Stateless single-turn extraction |
| **Noise filtering** | LLM decides via "WHEN TO SKIP" prompt | Deterministic code-level Tier 1 filter |
| **Runtime** | Long-running worker process (1.8MB .cjs) | On-demand spawn, exits immediately |
| **Dependencies** | Bun + Python/uv + Chroma vector DB | Node.js only (3 npm packages) |
| **Source size** | ~2.3MB compiled bundles | ~50KB readable source |
| **Data directory** | `~/.claude-mem/` | `~/claude-mem-lite/` (auto-migrates) |

### Token & cost efficiency

For a typical 50-tool-call session:

| | claude-mem | claude-mem-lite | Ratio |
|---|---|---|---|
| LLM calls | ~50 (every tool use) | ~5-8 (per episode) | **7-10x fewer** |
| Tokens per call | 1,000-5,000 (raw JSON + history) | 200-500 (summaries only) | **5-10x smaller** |
| Total tokens | ~100K-250K | ~1K-4K | **50-100x less** |
| Model cost | Sonnet ($3/$15 per M) | Haiku ($0.25/$1.25 per M) | **12x cheaper** |
| Combined savings | | | **600x+ lower cost** |

### Quality comparison

| Dimension | Winner | Why |
|---|---|---|
| **Classification accuracy** | Tie | Both produce correct type/title/narrative |
| **Noise filtering** | **lite** | Code-level filtering is deterministic; LLM "WHEN TO SKIP" is unreliable |
| **Observation coherence** | **lite** | Episode batching groups related edits into one coherent observation |
| **Code-level detail** | original | Sees full diffs, but rarely useful for memory search |
| **Search recall** | Tie | Users search semantic concepts ("auth bug"), not code lines |
| **Hook latency** | **lite** | Async background workers; original blocks 2-5s per hook |

### Design philosophy

The original sends **everything to the LLM and hopes it filters well**. claude-mem-lite **filters first with code, then sends only what matters** to a smaller model. This is not a downgrade; it's a smarter architecture that produces equivalent search quality at a fraction of the cost.

## Features

- **Automatic capture** -- Hooks into Claude Code lifecycle (PostToolUse, SessionStart, Stop, UserPromptSubmit) to record observations without manual effort
- **FTS5 search** -- BM25-ranked full-text search across observations, session summaries, and user prompts with importance weighting
- **Timeline browsing** -- Navigate observations chronologically with anchor-based context windows
- **Episode batching** -- Groups related file operations into coherent episodes before LLM encoding
- **Error-triggered recall** -- Automatically searches memory when Bash errors occur, surfacing relevant past fixes
- **Proactive file history** -- When editing a file, automatically shows relevant past observations for that file
- **Session summaries** -- LLM-generated summaries at session end (via background workers using `claude -p`)
- **Project-scoped context** -- Injects recent memory into `CLAUDE.md` and session startup for immediate context
- **Observation types** -- Categorized as `decision`, `bugfix`, `feature`, `refactor`, `discovery`, or `change`
- **Importance grading** -- LLM assigns 1-3 importance levels (routine / notable / critical) to each observation
- **Observation relations** -- Bidirectional links between related observations based on file overlap
- **User prompt capture** -- Records user prompts via UserPromptSubmit hook for intent tracking
- **Read file tracking** -- Tracks files read during sessions for richer episode context
- **Zero data loss** -- If LLM fails, observations are saved with degraded (inferred) metadata instead of being discarded
- **Two-tier dedup** -- Jaccard similarity (5-minute window) + MinHash signatures (7-day cross-session window) prevent duplicates
- **Synonym expansion** -- Abbreviations like `K8s`, `DB`, `auth` automatically expand to full forms in FTS5 search (48+ pairs)
- **Pseudo-relevance feedback (PRF)** -- Top results seed expansion queries for broader recall
- **Concept co-occurrence** -- Shared concepts across observations expand search to related topics
- **Context-aware re-ranking** -- Active file overlap boosts relevance (exact match + directory-level half-weight)
- **Superseded detection** -- Marks older observations as outdated when newer ones cover the same files with higher importance
- **Adaptive time windows** -- Session startup recall uses velocity-based time windows (high/medium/low activity tiers)
- **Token-budgeted context** -- Greedy knapsack algorithm selects session-start context within a 2,000-token budget, prioritizing by recency and importance
- **Observation compression** -- Old low-value observations can be compressed into weekly summaries to reduce noise
- **Secret scrubbing** -- Automatic redaction of API keys, tokens, PEM blocks, connection strings, and 15+ credential patterns
- **Atomic writes** -- All file writes (episodes, CLAUDE.md) use write-to-tmp + rename to prevent corruption on crash
- **Robust locking** -- PID-aware lock files with automatic stale/orphan cleanup (>30s timeout or dead PID)
- **Stale session cleanup** -- Sessions active for >24h are automatically marked as abandoned on next start

## Requirements

- **Node.js** >= 18
- **Claude Code** CLI installed and configured (`claude` command available)
- **SQLite3** support (provided by `better-sqlite3`, compiled on install)

## Installation

### Method 1: Plugin Marketplace (recommended)

```bash
/plugin marketplace add sdsrss/claude-mem-lite
/plugin install claude-mem-lite
```

The plugin system handles everything: hooks, MCP server, and dependency installation (via Setup hook). Dependencies are installed automatically on first run.

### Method 2: npx (one-liner)

```bash
npx github:sdsrss/claude-mem-lite
```

Source files are automatically copied to `~/claude-mem-lite/` for persistence.

### Method 3: git clone

```bash
git clone https://github.com/sdsrss/claude-mem-lite.git
cd claude-mem-lite
node install.mjs install
```

Source files stay in the cloned repo. Update via `git pull && node install.mjs install`.

### What happens during installation

1. **Install dependencies** -- `npm install --omit=dev` (compiles native `better-sqlite3`)
2. **Register MCP server** -- `mem` server with 7 tools (search, timeline, get, save, stats, delete, compress)
3. **Configure hooks** -- `PostToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit` lifecycle hooks
4. **Create data directory** -- `~/claude-mem-lite/` for database and runtime files
5. **Auto-migrate** -- If `~/.claude-mem/` (original claude-mem) exists, copies database and runtime files to `~/claude-mem-lite/`, preserving the original untouched
6. **Initialize database** -- SQLite with WAL mode, FTS5 indexes created on first server start

Restart Claude Code after installation to activate.

### Migration from claude-mem (original)

All installation methods auto-detect `~/.claude-mem/` and migrate:
- Copy `claude-mem.db` → `~/claude-mem-lite/claude-mem-lite.db` (renamed)
- Copy the `runtime/` directory
- **Original `~/.claude-mem/` is preserved** (no deletion, no overwrite)
- Existing `claude-mem.db` in `~/claude-mem-lite/` is automatically renamed to `claude-mem-lite.db` on first run

Remove the old directory manually after confirming:
```bash
rm -rf ~/.claude-mem/
```

### Directory Structure

```
~/claude-mem-lite/
  claude-mem-lite.db       # SQLite database (WAL mode)
  runtime/
    session-<project>    # Active session state
    ep-<project>.json    # Episode buffer
    ep-flush-*.json      # Flushed episodes awaiting processing
    reads-<project>.txt  # Read file paths (collected on flush)
```

## Usage

### MCP Tools (used automatically by Claude)

| Tool | Description |
|------|-------------|
| `mem_search` | FTS5 full-text search with BM25 ranking. Filters by type, project, date range, importance level. |
| `mem_timeline` | Browse observations chronologically around an anchor point. |
| `mem_get` | Retrieve full details for specific observation IDs (includes importance and related_ids). |
| `mem_save` | Manually save a memory/observation. |
| `mem_stats` | View statistics: counts, type distribution, top projects, daily activity. |
| `mem_delete` | Delete observations by ID with preview/confirm workflow. FTS5 cleanup is automatic. |
| `mem_compress` | Compress old low-value observations into weekly summaries to reduce noise. |

### Skill Commands (in Claude Code chat)

```
/mem search <query>        # Full-text search across all memories
/mem recent [n]            # Show recent N observations (default 10)
/mem save <text>           # Save a manual memory/note
/mem stats                 # Show memory statistics
/mem timeline <query>      # Browse timeline around a match
/mem <query>               # Shorthand for search
```

### Efficient Search Workflow

```
1. mem_search(query="auth bug")     -> compact ID index
2. mem_timeline(anchor=12345)       -> surrounding context
3. mem_get(ids=[12345, 12346])      -> full details
```

## Database Schema

Four core tables with FTS5 virtual tables for search:

**observations** -- Individual coding observations (decisions, bugfixes, features, etc.)
```
id, memory_session_id, project, type, title, subtitle,
text, narrative, concepts, facts, files_read, files_modified,
importance, related_ids, created_at, created_at_epoch
```

**session_summaries** -- LLM-generated session summaries
```
id, memory_session_id, project, request, investigated,
learned, completed, next_steps, files_read, files_edited, notes
```

**sdk_sessions** -- Session tracking
```
id, content_session_id, memory_session_id, project,
started_at, completed_at, status, prompt_counter
```

**user_prompts** -- User prompts captured via UserPromptSubmit hook
```
id, content_session_id, prompt_text, prompt_number
```

FTS5 indexes: `observations_fts`, `session_summaries_fts`, `user_prompts_fts`

## How It Works

### Hook Pipeline

```
SessionStart
  -> Generate session ID
  -> Mark stale sessions (>24h active) as abandoned
  -> Clean orphaned/stale lock files
  -> Query recent observations (24h)
  -> Inject context into CLAUDE.md + stdout

PostToolUse (every tool execution)
  -> Bash pre-filter skips noise in ~5ms (Read paths tracked to reads file)
  -> Detect Bash significance (errors, tests, builds, git, deploys)
  -> Accumulate into episode buffer
  -> Proactive file history: show past observations for edited files
  -> Flush when: buffer full (10 entries) | 5min gap | context change
  -> Collect Read file paths into episode on flush
  -> Spawn LLM episode worker for significant episodes
  -> Error-triggered recall: search memory for related past fixes

UserPromptSubmit
  -> Capture user prompt text to user_prompts table
  -> Increment session prompt counter
  -> Pure DB operation, <100ms

Stop
  -> Flush final episode buffer
  -> Mark session completed
  -> Spawn LLM summary worker (poll-based wait)
```

### Episode Encoding

Episodes are batched related operations (edits to the same file group) that get processed by a background LLM worker:

```
Episode buffer -> Flush to JSON -> claude -p --model haiku -> Structured observation -> SQLite
```

Each observation includes type, title, narrative, concepts, facts, importance (1-3), and is automatically deduplicated via two tiers: Jaccard similarity (>70% within 5 minutes) and MinHash signatures (>80% within 7 days across sessions). If the LLM call fails, a degraded observation is saved with inferred metadata (zero data loss). Related observations are linked via `related_ids` based on FTS5 title similarity and file overlap.

## Management Commands

```bash
# Plugin install:
/plugin install claude-mem-lite       # Install / update
/plugin uninstall claude-mem-lite     # Uninstall

# git clone install:
node install.mjs install              # Install and configure
node install.mjs uninstall            # Remove (keep data)
node install.mjs uninstall --purge    # Remove and delete all data
node install.mjs status               # Show current status
node install.mjs doctor               # Diagnose issues

# npx install:
npx claude-mem-lite                   # Install / reinstall
npx claude-mem-lite uninstall         # Remove (keep data)
npx claude-mem-lite doctor            # Diagnose issues
```

### doctor

Checks Node.js version, dependencies, server/hook files, database integrity, FTS5 indexes, and stale processes.

### status

Shows MCP registration, hook configuration, and database stats (observation/session counts).

## Uninstall

```bash
# Plugin:
/plugin uninstall claude-mem-lite

# git clone:
cd claude-mem-lite
node install.mjs uninstall            # Keeps ~/claude-mem-lite/ data
node install.mjs uninstall --purge    # Deletes ~/claude-mem-lite/ and all data

# npx:
npx claude-mem-lite uninstall
npx claude-mem-lite uninstall --purge
```

Data in `~/claude-mem-lite/` is preserved by default. Delete manually if needed:
```bash
rm -rf ~/claude-mem-lite/
```

## Project Structure

```
claude-mem-lite/
  .claude-plugin/
    plugin.json      # Plugin manifest
    marketplace.json # Marketplace catalog
  .mcp.json          # MCP server definition (plugin mode)
  hooks/
    hooks.json       # Hook definitions (plugin mode)
  commands/
    mem.md           # /mem command definition
  scripts/
    setup.sh         # Setup hook: npm install + migration
  server.mjs           # MCP server: tool definitions, FTS5 search, database init
  server-internals.mjs # Extracted search helpers: re-ranking, PRF, concept expansion
  hook.mjs             # Claude Code hooks: episode capture, error recall, session management
  schema.mjs           # Database schema: single source of truth for tables, migrations, FTS5
  tool-schemas.mjs     # Shared Zod schemas for MCP tool validation
  utils.mjs            # Shared utilities: FTS5 query building, MinHash dedup, secret scrubbing
  install.mjs          # CLI installer: setup, uninstall, status, doctor (npx/git clone mode)
  skill.md             # MCP skill definition (npx/git clone mode)
  package.json         # Dependencies and metadata
  # Test & benchmark (dev only)
  *.test.mjs           # Unit, property, integration, contract, E2E tests (323 tests)
  test-helpers.mjs     # Shared test utilities
  benchmark/           # BM25 search quality benchmarks + CI gate
```

## Search Quality

Benchmarked on 200 observations across 30 queries (standard + hard-negative categories):

| Metric | Score |
|--------|-------|
| Recall@10 | 0.88 |
| Precision@10 | 0.96 |
| nDCG@10 | 0.95 |
| MRR@10 | 0.95 |
| P95 search latency | 0.15ms |

The benchmark suite runs as a CI gate (`npm run benchmark:gate`) to prevent search quality regressions.

## Development

```bash
npm run lint              # ESLint static analysis
npm test                  # Run all 323 tests (vitest)
npm run test:smoke        # Run 5 core smoke tests
npm run test:coverage     # Run tests with V8 coverage (≥70% lines/functions, ≥60% branches)
npm run benchmark         # Run full search quality benchmark
npm run benchmark:gate    # CI gate: fails if metrics regress beyond 5% tolerance
```

## License

MIT
