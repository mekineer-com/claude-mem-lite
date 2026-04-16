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
| **Data directory** | `~/.claude-mem/` | `~/.claude-mem-lite/` (hidden, auto-migrates) |

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
- **Hybrid search** -- FTS5 BM25 + TF-IDF vector cosine similarity, merged via Reciprocal Rank Fusion (RRF). FTS5 handles keyword matching; 512-dim TF-IDF vectors capture semantic similarity for recall beyond exact terms
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
- **Synonym expansion** -- Abbreviations like `K8s`, `DB`, `auth` automatically expand to full forms in FTS5 search (100+ pairs including CJK↔EN cross-language mappings)
- **CJK synonym extraction** -- Unsegmented Chinese text is scanned for known vocabulary words (数据库→database, 搜索→search, etc.) enabling cross-language memory recall
- **Stop-word filtering** -- English stop words filtered from both TF-IDF vocabulary (reclaiming ~18% of vector dimensions) and FTS queries (preventing false negatives from noise terms like "how", "the", "does")
- **Persisted vocabulary** -- TF-IDF vocabulary persisted to `vocab_state` table, preventing vector staleness when document frequencies shift. Vectors stay valid until explicit rebuild
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
- **Resource registry** -- Indexes installed skills and agents with FTS5 search, composite scoring, and invocation tracking; searchable via `mem_registry` MCP tool
- **Unified resource discovery** -- Shared filesystem traversal layer (`resource-discovery.mjs`) used by both runtime scanner and offline indexer, supporting flat directories, plugin nesting, and loose `.md` files
- **Domain synonym expansion** -- Registry search queries expand to domain synonyms (e.g., "fix" → debug, bugfix, troubleshoot, diagnose, repair)
- **Dual LLM mode** -- Auto-detects `ANTHROPIC_API_KEY` for direct API calls; falls back to `claude -p` CLI when no key is available
- **Lesson-learned indexing** -- `lesson_learned` field indexed in FTS5 with weight 8, making past debugging insights directly searchable
- **Cross-source normalization** -- `mem_search` normalizes scores across observations, sessions, and prompts before merging, preventing any source from dominating results
- **Exponential recency decay** -- Type-differentiated half-lives (decisions: 90d, discoveries: 60d, bugfixes: 14d, changes: 7d) consistently applied in all ranking paths
- **Prompt-time memory injection** -- UserPromptSubmit hook automatically searches and injects relevant past observations with recency and importance weighting
- **Smart skill invocation** -- Auto-loaded and searched managed skills/agents include portable `~` paths with `Read()` guidance; native plugin skills recommend `Skill("full:name")`; prevents `Skill()` misuse for managed resources that aren't registered with Claude Code's native handler
- **Dual injection dedup** -- `user-prompt-search.js` and `handleUserPrompt` coordinate via temp file to prevent duplicate memory injection
- **Plugin cache hook self-heal** -- Claude Code runtime reads plugin hooks from `~/.claude/plugins/cache/<mp>/<plugin>/<ver>/hooks/hooks.json`, not from the marketplace source. When `install.mjs`-managed `settings.json` hooks coexist with a stale cache `hooks.json` (e.g. from a previous marketplace install or a plugin auto-update), the runtime registers hooks twice → every session start / user prompt fires twice. `install.mjs` and `hook-update.mjs` now clear cache `hooks.json` in every version dir, and `hook.mjs session-start` self-heals on every session (gated by `hasInstallManagedHooks` so plugin-only users are not affected). `install.mjs status` reports cache pollution state (since v2.31.1/2.31.2).
- **Result-dedup cooldown** -- User-prompt memory injection uses result-overlap detection (>80% ID overlap → skip) instead of time-based cooldown, allowing topic switches within seconds while preventing redundant injections
- **OR query fallback** -- When AND-joined FTS5 queries return zero results, automatically relaxes to OR-joined queries for broader recall (applied in both user-prompt-search and hook-memory paths)
- **Configurable LLM model** -- Switch between Haiku (fast/cheap) and Sonnet (deeper analysis) via `CLAUDE_MEM_MODEL` env var
- **DB auto-recovery** -- Detects and cleans corrupted WAL/SHM files on startup; periodic WAL checkpoints prevent unbounded growth
- **Schema auto-migration** -- Idempotent `ALTER TABLE` migrations run on every startup, safely adding new columns and indexes without data loss
- **Exploration bonus** -- New resources in the registry get a fair chance in composite ranking; zombie resources (high recommend, zero adopt) are penalized in scoring
- **LLM concurrency control** -- File-based semaphore limits background workers to 2 concurrent LLM calls, preventing resource contention
- **stdin overflow protection** -- Hook input truncated at 256KB with regex-based action salvage for oversized tool outputs
- **Cross-session handoff** -- Captures session state (request, completed work, next steps, key files) on `/clear` or `/exit`, then injects context when the next session detects continuation intent via explicit keywords or FTS5 term overlap
- **Git-SHA continuation anchor** (v2.31.0) -- Handoff rows include `git_sha_at_handoff`; any handoff matching the current `HEAD` counts as continuation regardless of TTL. Code state is a stronger continuation signal than wall-clock time
- **Startup dashboard** (v2.31.0) -- SessionStart hook aggregates `git status` + `~/.claude/tasks/*.json` + `~/.claude/plans/*.md` + most-recent exit handoff + recent event count into a single structured block injected via `hookSpecificOutput.additionalContext`
- **Activity namespace** (v2.31.0) -- Dedicated `events` table + FTS5 for non-memdir types (`bugfix`, `lesson`, `bug`, `discovery`, `refactor`, `feature`, `observation`, `decision`) that don't compete with `WHAT_NOT_TO_SAVE` semantics on the observations table. CLI: `claude-mem-lite activity save|search|recent|show`. Slash commands: `/lesson`, `/bug`. `hook-llm` routes non-memdir summary types through `persistHaikuSummary` so upgrades from observations→events are atomic
- **In-place observation updates** -- `mem_update` tool modifies existing observations atomically (field update + FTS text rebuild + vector re-computation in one transaction), preserving original IDs and references
- **Bulk export** -- `mem_export` tool exports observations as JSON or JSONL, with project/type/date filtering and 1000-row pagination cap with batch guidance
- **FTS integrity management** -- `mem_fts_check` tool verifies FTS5 index health or rebuilds indexes on demand, useful after database recovery or when search results seem wrong
- **Atomic multi-table writes** -- `saveObservation` wraps observations + observation_files + observation_vectors INSERTs in a single `db.transaction()`, preventing orphaned rows on crash
- **Modular NLP pipeline** -- Synonym maps, stop words, scoring constants, and query building extracted into focused modules (`synonyms.mjs`, `stop-words.mjs`, `scoring-sql.mjs`, `nlp.mjs`) for independent testing and maintenance
- **Porter-aligned PRF** -- Pseudo-relevance feedback terms are now stemmed with the same Porter algorithm used by FTS5, ensuring PRF expansion terms match the search index

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **Linux** | Supported | Primary development and testing platform |
| **macOS** | Supported | Fully compatible (Intel and Apple Silicon) |
| **Windows** | Not supported | Uses POSIX shell scripts (`post-tool-use.sh`, `setup.sh`) and Unix file locking; WSL2 may work but is untested |

## Requirements

- **Node.js** >= 18
- **Claude Code** CLI installed and configured (`claude` command available)
- **SQLite3** support (provided by `better-sqlite3`, compiled on install)
- **Platform**: Linux or macOS (see [Platform Support](#platform-support))

## Installation

### Method 1: Plugin Marketplace (recommended)

```bash
/plugin marketplace add sdsrss/claude-mem-lite
/plugin install claude-mem-lite
```

Plugin mode manages its own hooks/runtime. On session start it only **checks and reports** new claude-mem-lite versions; it does **not** self-overwrite plugin files in place. Update plugin-mode installs through Claude's plugin workflow.

### Method 2: npx (one-liner)

```bash
npx github:sdsrss/claude-mem-lite
```

Source files are automatically copied to `~/.claude-mem-lite/` for persistence.

### Method 3: git clone

```bash
git clone https://github.com/sdsrss/claude-mem-lite.git
cd claude-mem-lite
node install.mjs install
```

Source files stay in the cloned repo. Update via `git pull && node install.mjs install`.

### What happens during installation

1. **Install dependencies** -- `npm install --omit=dev` (compiles native `better-sqlite3`)
2. **Register MCP server** -- `mem` server with 16 tools (search, recent, recall, timeline, get, save, update, stats, delete, compress, maintain, export, fts_check, browse, registry, use)
3. **Configure hooks** -- `PostToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit` lifecycle hooks
4. **Create data directory** -- `~/.claude-mem-lite/` (hidden) for database, runtime, and managed resource files
5. **Auto-migrate** -- If `~/.claude-mem/` (original claude-mem) or `~/claude-mem-lite/` (pre-v0.5 unhidden) exists, migrates database and runtime files to `~/.claude-mem-lite/`, preserving the original untouched
6. **Initialize database** -- SQLite with WAL mode, FTS5 indexes created on first server start

Restart Claude Code after installation to activate.

### Migration

All installation methods auto-detect and migrate from previous versions:

**From claude-mem (original `~/.claude-mem/`):**
- Copy `claude-mem.db` → `~/.claude-mem-lite/claude-mem-lite.db` (renamed)
- Copy the `runtime/` directory
- **Original `~/.claude-mem/` is preserved** (no deletion, no overwrite)

**From pre-v0.5 unhidden directory (`~/claude-mem-lite/`):**
- Entire directory is moved to `~/.claude-mem-lite/` (hidden)

**In-place rename:**
- Existing `claude-mem.db` in `~/.claude-mem-lite/` is automatically renamed to `claude-mem-lite.db`

Remove old directories manually after confirming:
```bash
rm -rf ~/.claude-mem/       # original claude-mem
rm -rf ~/claude-mem-lite/   # pre-v0.5 unhidden (if not auto-moved)
```

### Directory Structure

```
~/.claude-mem-lite/
  claude-mem-lite.db       # SQLite database — memory (WAL mode)
  resource-registry.db     # SQLite database — skill/agent registry
  runtime/
    session-<project>    # Active session state
    ep-<project>.json    # Episode buffer
    ep-flush-*.json      # Flushed episodes awaiting processing
    reads-<project>.txt  # Read file paths (collected on flush)
  managed/
    skills/              # Standalone skills: {name}/SKILL.md
    agents/              # Agent plugins: {group}/agents/{name}.md + skills/*/SKILL.md
    repos/               # Shallow-cloned source repos
```

## Usage

### MCP Tools (used automatically by Claude)

| Tool | Description |
|------|-------------|
| `mem_search` | FTS5 full-text search with BM25 ranking. Filters by type, project, date range, importance level. |
| `mem_recent` | Show most recent observations, ordered by time. Quick snapshot of latest activity. |
| `mem_recall` | Recall observations related to a file. Use before editing to surface past bugfixes and context. |
| `mem_timeline` | Browse observations chronologically around an anchor point. |
| `mem_get` | Retrieve full details for specific observation IDs (includes importance and related_ids). |
| `mem_save` | Manually save a memory/observation. |
| `mem_update` | Update an existing observation in-place. Preserves original ID and references. |
| `mem_stats` | View statistics: counts, type distribution, top projects, daily activity. |
| `mem_delete` | Delete observations by ID with preview/confirm workflow. FTS5 cleanup is automatic. |
| `mem_compress` | Compress old low-value observations into weekly summaries to reduce noise. |
| `mem_maintain` | Memory maintenance: scan for duplicates/stale/broken items, then execute cleanup/dedup/rebuild_vectors operations. |
| `mem_export` | Export observations as JSON or JSONL for backup or migration. Filters by project, type, date range. |
| `mem_fts_check` | Check FTS5 index integrity or rebuild indexes. Use when search results seem wrong or after DB recovery. |
| `mem_browse` | Tier-grouped memory dashboard. Shows observations organized by memory tier (working/active/archive). |
| `mem_registry` | Manage resource registry: search for skills/agents by need, list resources, view stats, import/remove tools, reindex. Search results differentiate managed (Read path) vs native (Skill full name) invocation. |
| `mem_use` | Load a skill or agent from the managed registry by name. Returns full content with portable `~` path for reload via `Read()`. |

### Skill Commands (in Claude Code chat)

```
/mem search <query>        # Full-text search across all memories
/mem recent [n]            # Show recent N observations (default 10)
/mem recall <file>         # Show past observations for a file
/mem save <text>           # Save a manual memory/note
/mem stats                 # Show memory statistics
/mem timeline <query>      # Browse timeline around a match
/mem browse                # Tier-grouped memory dashboard
/mem <query>               # Shorthand for search
/lesson <text>             # Save a non-obvious lesson to the events table (v2.31.0)
/bug <text>                # Log a known bug + repro steps to the events table (v2.31.0)
```

### Efficient Search Workflow

```
1. mem_search(query="auth bug")     -> compact ID index
2. mem_timeline(anchor=12345)       -> surrounding context
3. mem_get(ids=[12345, 12346])      -> full details
```

### Invited Memory (v2.32+)

Opt-in mechanism that installs a single sentinel-wrapped line into the project's
memdir (`~/.claude/projects/<encoded>/memory/MEMORY.md`) so Claude Code loads
the plugin's MCP-tool triggers as **user-memory** — a higher instruction-following
authority than MCP server instructions (which are framed as tool metadata).

```bash
claude-mem-lite adopt              # install for current project
claude-mem-lite adopt --all        # install for every project under ~/.claude/projects/
claude-mem-lite adopt --status     # list adopted projects + sentinel versions
claude-mem-lite adopt --dry-run    # preview without writing
claude-mem-lite unadopt            # remove cleanly
```

Slash commands `/adopt` and `/unadopt` wrap the same CLI.

**What adoption changes:**
- A `<!-- claude-mem-lite:begin v1 -->…<!-- claude-mem-lite:end -->` block is
  added to `MEMORY.md` under a `## 插件契约` header, containing one ≤150-char
  line pointing at `mem_recall` / `mem_save` with their key arguments.
- A `plugin_claude_mem_lite.md` detail file is written (not auto-loaded; read
  on demand when the MEMORY.md pointer surfaces in context).
- Post-adopt the conservative hook layer auto-trims: MCP server instructions
  drop the `WHEN TO USE` section, SessionStart injection drops the `File Lessons`
  / `Key Context` sections. `#ID` references and the `Recent` table still fire
  so `mem_get` remains reachable.

**When does it take effect?**
- The MEMORY.md sentinel and the hook-layer trim (`File Lessons` / `Key Context` /
  lesson suffix) apply on the **next SessionStart** (any new Claude Code session
  in the adopted project).
- The MCP server instructions are built once at server boot and MCP has no
  "push" protocol — the `WHEN TO USE` / `Decision rules` trim only applies
  after Claude Code restarts and re-spawns the mem MCP server. A single
  `/exit` + fresh session is enough. Same caveat applies to `unadopt`.

**Safety:**
- Hash-guarded: editing the sentinel body yourself blocks automatic rewrites
  unless you pass `--force`.
- Budget-gated: refuses to insert when MEMORY.md is already >180 lines, so
  Claude Code's 200-line MEMORY.md cap won't truncate the block.
- `install` only auto-adopts when run from the claude-mem-lite source repo
  itself (detected via git remote match); other users must opt in explicitly.
- The fallback hook layer is never removed from source — conditional trim is
  runtime-gated on sentinel presence, so projects without adoption get the
  full verbose output.

See `docs/plans/2026-04-16-invited-memory-pattern.md` for the full design
(including the reusable template other plugins can follow).

## Database Schema

Five core tables with FTS5 virtual tables for search:

**observations** -- Individual coding observations (decisions, bugfixes, features, etc.)
```
id, memory_session_id, project, type, title, subtitle,
text, narrative, concepts, facts, files_read, files_modified,
importance, related_ids, created_at, created_at_epoch,
lesson_learned, minhash_sig, access_count, compressed_into, search_aliases,
branch, superseded_at, superseded_by, last_accessed_at
```

**session_summaries** -- LLM-generated session summaries
```
id, memory_session_id, project, request, investigated,
learned, completed, next_steps, files_read, files_edited, notes,
remaining_items, lessons, key_decisions
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

**session_handoffs** -- Cross-session handoff snapshots (UPSERT, max 2 per project)
```
project, type, session_id, working_on, completed, unfinished,
key_files, key_decisions, match_keywords, created_at_epoch
```

**observation_files** -- Normalized file membership for efficient file-based recall
```
obs_id, filename
```

**observation_vectors** -- TF-IDF vector embeddings for hybrid search
```
observation_id, vector (BLOB Float32Array), vocab_version, created_at_epoch
```

**vocab_state** -- Persisted TF-IDF vocabulary for stable vector indexing
```
term, term_index, idf, version, created_at_epoch
```

FTS5 indexes: `observations_fts` (title, subtitle, narrative, text, facts, concepts, lesson_learned), `session_summaries_fts`, `user_prompts_fts`

## How It Works

### Hook Pipeline

```
SessionStart
  -> Generate session ID (or save handoff snapshot on /clear)
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

UserPromptSubmit (two parallel paths)
  -> [user-prompt-search.js] Auto-search memory via FTS5 + active file context
  -> [user-prompt-search.js] Inject relevant past observations with recency/importance weighting
  -> [user-prompt-search.js] Write injected IDs to temp file for dedup
  -> [user-prompt-search.js] L1 skill auto-load: match managed skill names in prompt
     -> Load content with portable ~ path + Read() guidance
     -> source="managed-skill|managed-agent", path="~/.claude-mem-lite/managed/..."
  -> [hook.mjs handleUserPrompt] Capture user prompt text to user_prompts table
  -> [hook.mjs handleUserPrompt] Increment session prompt counter
  -> [hook.mjs handleUserPrompt] Handoff: detect continuation intent → inject previous session context
  -> [hook.mjs handleUserPrompt] Semantic memory injection (hook-memory.mjs), deduped via temp file

Stop
  -> Flush final episode buffer
  -> Save handoff snapshot (on /exit)
  -> Mark session completed
  -> Spawn LLM summary worker (poll-based wait)
```

### Resource Registry

The resource registry (`registry.mjs`, `registry-retriever.mjs`) indexes installed skills and agents into a searchable FTS5 database. Unlike the previous proactive dispatch system, the registry is now on-demand — Claude searches it via the `mem_registry` MCP tool when it needs to discover relevant skills or agents.

```
Registry pipeline:
  -> registry-scanner.mjs discovers skills/agents on filesystem
  -> resource-discovery.mjs handles flat dirs, plugin nesting, loose .md files
  -> registry-indexer.mjs indexes content into FTS5 with metadata
  -> registry-retriever.mjs provides BM25-ranked search with synonym expansion
  -> mem_registry MCP tool exposes search/list/stats/import/remove/reindex actions

Smart invocation (three layers):
  L1 auto-load: UserPromptSubmit matches managed skill name in prompt
     -> Loads content with path="~/.claude-mem-lite/managed/.../SKILL.md"
     -> Guides: Read("path") or mem_use(name="..."), never Skill()
  L2 bridge: PreToolUse hook intercepts Skill("name") for managed resources
     -> Outputs content, prevents native handler failure
  L3 explicit: mem_use(name="...") loads full content with reload path
  Search: managed resources → Read(path), native plugins → Skill("full:name")
```

Composite scoring for search results: BM25 relevance (40%) + repo stars (15%) + success rate (15%) + adoption rate (10%) + freshness (10%) + exploration bonus (10%). Domain filtering ensures platform-specific resources (iOS, Go, Rust) only surface for matching projects.

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
node install.mjs cleanup-hooks        # Remove only stale claude-mem-lite hooks from settings.json
node install.mjs update               # Force-check for updates and install them (direct install / npx mode)

# npx install:
npx claude-mem-lite                   # Install / reinstall
npx claude-mem-lite uninstall         # Remove (keep data)
npx claude-mem-lite doctor            # Diagnose issues
```

Notes:
- Plugin mode only reports available updates; it does not self-update plugin files.
  To upgrade an installed plugin to the latest published version, run **inside Claude Code**:
  ```
  /plugin marketplace update sdsrss
  /plugin install claude-mem-lite@sdsrss
  ```
  (The first command refreshes the local marketplace clone; the second reinstalls from it. Without the first command, `/plugin install` reuses the stale local clone and you stay on whichever version you originally pulled.)
- Direct install / npx mode keeps auto-update enabled and uses staged replacement with rollback on install failure.
- If you disabled the plugin but still have old mem hooks in `~/.claude/settings.json`, run `node install.mjs cleanup-hooks`.

### doctor

Checks Node.js version, dependencies, server/hook files, database integrity, FTS5 indexes, and stale processes.

### status

Shows MCP registration, hook configuration, plugin disabled state, and database stats (observation/session counts).

## Uninstall

```bash
# Plugin:
/plugin uninstall claude-mem-lite

# git clone:
cd claude-mem-lite
node install.mjs uninstall            # Keeps ~/.claude-mem-lite/ data
node install.mjs uninstall --purge    # Deletes ~/.claude-mem-lite/ and all data

# npx:
npx claude-mem-lite uninstall
npx claude-mem-lite uninstall --purge
```

Data in `~/.claude-mem-lite/` is preserved by default. Delete manually if needed:
```bash
rm -rf ~/.claude-mem-lite/
```

## Project Structure

```
claude-mem-lite/
  .claude-plugin/
    plugin.json      # Plugin manifest
    marketplace.json # Marketplace catalog
  .mcp.json          # MCP server definition (plugin root)
  hooks/
    hooks.json       # Hook definitions (plugin mode)
  commands/
    mem.md           # /mem command definition
  server.mjs           # MCP server: tool definitions, FTS5 search, database init
  server-internals.mjs # Extracted search helpers: re-ranking, PRF, concept expansion
  hook.mjs             # Claude Code hooks: episode capture, error recall, session management
  hook-llm.mjs         # Background LLM workers: episode extraction, session summaries
  hook-shared.mjs      # Shared hook infrastructure: session management, DB access, LLM calls
  hook-handoff.mjs     # Cross-session handoff: state extraction, intent detection, injection
  hook-context.mjs     # CLAUDE.md context injection and token budgeting
  hook-episode.mjs     # Episode buffer management: atomic writes, pending entry merging
  hook-memory.mjs      # Semantic memory injection on user prompt
  hook-semaphore.mjs   # LLM concurrency control: file-based semaphore for background workers
  schema.mjs           # Database schema: single source of truth for tables, migrations, FTS5
  tool-schemas.mjs     # Shared Zod schemas for MCP tool validation
  tfidf.mjs            # TF-IDF vector engine: tokenization, vocabulary building, vector computation, cosine similarity, RRF merge
  tier.mjs             # Temporal tier system: activity-based time window classification
  utils.mjs            # Re-export hub: backward-compatible surface for all utility modules
  nlp.mjs              # FTS5 query building: synonym expansion, CJK bigrams, sanitization
  scoring-sql.mjs      # BM25 weight constants and type-differentiated decay half-lives
  stop-words.mjs       # Shared base stop-word set for all NLP/search modules
  synonyms.mjs         # Unified synonym source: SYNONYM_MAP (bidirectional) + DISPATCH_SYNONYMS
  project-utils.mjs    # Shared project name resolution with in-process cache
  secret-scrub.mjs     # API key, token, PEM, and credential pattern redaction
  format-utils.mjs     # String formatting: truncate, typeIcon, date/time/week formatting
  hash-utils.mjs       # MinHash signatures, Jaccard similarity for dedup
  bash-utils.mjs       # Bash output significance detection: errors, tests, builds, deploys
  # Resource registry
  registry.mjs         # Resource registry DB: schema, CRUD, FTS5, invocation tracking
  registry-retriever.mjs # FTS5 retrieval with synonym expansion and composite scoring
  registry-indexer.mjs # Resource indexing pipeline
  registry-scanner.mjs # Filesystem scanner: reads content + hashes, delegates discovery
  resource-discovery.mjs # Shared discovery layer: flat dirs, plugin nesting, loose .md files
  haiku-client.mjs     # Unified Haiku LLM wrapper: direct API or CLI fallback
  # Install & config
  install.mjs          # CLI installer: setup, uninstall, status, doctor (npx/git clone mode)
  skill.md             # MCP skill definition (npx/git clone mode)
  package.json         # Dependencies and metadata
  scripts/
    setup.sh           # Setup hook: npm install + migration (hidden dir + old dir)
    post-tool-use.sh   # Bash pre-filter: skips noise in ~5ms, tracks Read paths
    user-prompt-search.js # UserPromptSubmit hook: auto-search memory + L1 skill auto-load
    pre-skill-bridge.js  # PreToolUse hook: L2 skill bridge for managed resources
    pre-tool-recall.js   # PreToolUse hook: file lesson recall before Edit/Write
    prompt-search-utils.mjs # Shared logic: skip patterns, intent detection, name matching
    convert-commands.mjs # Converts command .md → SKILL.md in managed plugins
    index-managed.mjs  # Offline indexer for managed resources
  # Test & benchmark (dev only)
  tests/               # Unit, property, integration, contract, E2E, pipeline tests
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
npm test                  # Run full test suite (vitest)
npm run test:smoke        # Run 5 core smoke tests
npm run test:coverage     # Run tests with V8 coverage (≥75% lines/functions, ≥65% branches)
npm run benchmark         # Run full search quality benchmark
npm run benchmark:gate    # CI gate: fails if metrics regress beyond 5% tolerance
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_DIR` | Custom data directory. All databases, runtime files, and managed resources are stored here. | `~/.claude-mem-lite/` |
| `CLAUDE_MEM_MODEL` | LLM model for background calls (episode extraction, session summaries). Accepts `haiku` or `sonnet`. | `haiku` |
| `CLAUDE_MEM_DEBUG` | Enable debug logging (`1` to enable). | _(disabled)_ |
| `MEM_QUIET_HOOKS` | Low-noise hooks. `1` drops the `File Lessons` / `Key Context` sections from SessionStart injection, the lesson suffix from `[mem] Related memories`, and the `WHEN TO USE` / `Decision rules` blocks from MCP server instructions. IDs and the `Recent` table still surface so `mem_get(ids=[…])` remains reachable. Intended for users running the invited-memory adopt path or who otherwise want minimal auto-injection. | _(disabled)_ |
| `MEM_NO_ADOPT_HINT` | Silences the one-line "Invited-memory 未启用：`claude-mem-lite adopt`…" hint that SessionStart appends when the current project hasn't been adopted. The hint self-clears once `adopt` runs; set this env to suppress it without adopting. | _(disabled)_ |

## License

MIT
