# Smart Ingestion Pipeline: Code First + LLM Enrichment

**Date**: 2026-03-28
**Status**: Approved
**Phase**: 1 of 2 (Phase 2: Precision Search — separate spec)
**Goal**: Give a GitHub URL, pure code auto-discovers and imports skills/agents; optional LLM enrichment generates high-quality semantic metadata.

## Problem

Current ingestion has three issues:
1. `/mem:tools <url>` is LLM-in-the-loop — Claude must manually fetch/parse/import each tool. Slow, unreliable, expensive.
2. Regex-based metadata extraction produces low quality: 58% of resources missing domain_tags, 18% missing keywords.
3. No GitHub metadata (stars, recency) as quality signals. No dedup. No quality assessment.

## Architecture

Two-stage pipeline. Stages are decoupled — Stage 1 always runs, Stage 2 is optional/async.

### Stage 1: Code Layer (Structural Extraction)

**Input**: GitHub URL (e.g., `https://github.com/user/repo`)
**Output**: Resources upserted into registry DB with basic metadata
**Speed**: ~3s per repo (no LLM)
**Reliability**: 100% deterministic

**Flow**:
```
1. Parse GitHub URL → owner, repo, branch (default: main)
2. GitHub API: GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
   → Full file tree without cloning
3. Discover skills/agents from tree:
   - Match: **/SKILL.md, **/AGENT.md, **/.claude-plugin/plugin.json
   - Support 3 layouts:
     a) flat: skills/{name}/SKILL.md
     b) plugin: plugins/{name}/skills/{sub}/SKILL.md
     c) root: ./SKILL.md (single-skill repo)
4. Fetch content for each discovered skill:
   - GitHub raw API: GET /repos/{owner}/{repo}/contents/{path}
   - Decode base64 content
5. Parse SKILL.md:
   - YAML frontmatter: name, description, version, allowed-tools
   - Body: full markdown content
6. Extract metadata (pure code):
   - capability_summary: frontmatter description, truncated to 200 chars
   - keywords: high-frequency words from description + body (stop-word filtered)
   - intent_tags: regex keyword mapping (reuse index-managed.mjs patterns)
   - domain_tags: inferred from allowed-tools + body keywords
   - tech_stack: language/framework detection from body
7. GitHub repo metadata:
   - GET /repos/{owner}/{repo} → stars, forks, updated_at, open_issues
   - Store in repo_stars, repo_forks, repo_updated_at
8. Hash dedup:
   - SHA-256(SKILL.md content) → compare with existing file_hash
   - Same hash → skip (already exists)
   - Different hash + same name → update
   - New → insert
9. Download to managed/:
   - Save SKILL.md + sibling files to ~/.claude-mem-lite/managed/skills/{name}/
   - or managed/agents/{name}/ for agents
10. Upsert to registry:
    - status='active', quality_tier='community', source='github'
    - repo_url=<github url>, local_path=<managed path>
    - enrichment_status=NULL (not yet enriched)
```

**GitHub API Auth**:
- Unauthenticated: 60 req/hr (enough for ~5 repos/hr)
- With `GITHUB_TOKEN` env var: 5000 req/hr
- Detect 403/429 → prompt user to set token

**Error handling**:
- Invalid URL → clear error message
- Private repo → "Repository not accessible. Set GITHUB_TOKEN for private repos."
- No skills found → "No skills/agents found in {owner}/{repo}. Expected SKILL.md or .claude-plugin/plugin.json."
- API rate limit → "GitHub API rate limit reached. Set GITHUB_TOKEN env var or wait."

### Stage 2: LLM Enrichment

**Input**: Resources already in DB (from Stage 1 or existing)
**Output**: Enriched metadata fields + quality assessment
**Speed**: ~2s per skill (Haiku)
**Reliability**: Graceful degradation — failure preserves Stage 1 data

**Trigger methods**:
1. `claude-mem-lite import <url> --enrich` — import + enrich in one go
2. `claude-mem-lite enrich [name...]` — enrich specific resources
3. `claude-mem-lite enrich --all --batch` — bulk enrich all un-enriched
4. `mem_registry(action="enrich", name="...")` — MCP tool

**Haiku prompt** (per skill):
```
You are a tool classification expert. Analyze this Claude Code skill and extract structured metadata.

<skill-content>
{SKILL.md content, truncated to 3000 chars}
</skill-content>

<existing-metadata>
name: {name}
current_tags: {intent_tags if any}
</existing-metadata>

Return JSON only:
{
  "capability_summary": "One sentence describing what this tool does (English, <80 chars)",
  "intent_tags": "comma-separated intent tags (what user goals should trigger this tool)",
  "domain_tags": "comma-separated technology/domain tags",
  "trigger_patterns": "natural language description of when to recommend this tool",
  "use_cases": "comma-separated usage scenarios",
  "tech_stack": "comma-separated technology stack tags",
  "quality_assessment": {
    "has_clear_instructions": true/false,
    "has_examples": true/false,
    "specificity": "high|medium|low",
    "estimated_utility": "high|medium|low"
  }
}
```

**Backfill logic**:
- Only fill empty/low-quality fields — never overwrite curated data from install-metadata.mjs
- Curated data priority: install-metadata.mjs > LLM enrichment > regex extraction
- On failure: set enrichment_status='failed', preserve Stage 1 data

**Quality tier upgrade**:
```
community (Stage 1 default)
  → verified: LLM enriched + has_clear_instructions=true + specificity>=medium
  → installed: manually curated via install-metadata.mjs (unchanged)
```

### DB Schema Changes

```sql
-- New columns on resources table
ALTER TABLE resources ADD COLUMN enrichment_status TEXT DEFAULT NULL;
  -- NULL=not enriched, 'pending', 'done', 'failed'
ALTER TABLE resources ADD COLUMN enriched_at INTEGER DEFAULT NULL;
ALTER TABLE resources ADD COLUMN repo_updated_at TEXT DEFAULT NULL;
ALTER TABLE resources ADD COLUMN repo_forks INTEGER DEFAULT 0;
```

### Zombie Treatment

Extend existing `mem_maintain(operations=["decay"])`:
- `recommend_count >= 3 AND adopt_count = 0` → reduce visibility in search (lower composite score)
- `recommend_count >= 10 AND adopt_count = 0` → `status='disabled'`

### CLI Commands

```
claude-mem-lite import <github-url>           # Stage 1 only
claude-mem-lite import <github-url> --enrich  # Stage 1 + 2
claude-mem-lite enrich <name>                 # Enrich one resource
claude-mem-lite enrich --all --batch          # Bulk enrich all un-enriched
```

### MCP Tool Updates

```
mem_registry(action="import_url", url="https://github.com/user/repo")
  → Runs Stage 1, returns list of imported resources

mem_registry(action="enrich", name="humanizer")
  → Runs Stage 2 on specified resource

mem_registry(action="import_url", url="...", enrich=true)
  → Runs Stage 1 + 2
```

## File Changes

| File | Change | Description |
|------|--------|-------------|
| `registry-importer.mjs` | **New** | GitHub URL → tree → discover → download → parse → upsert |
| `registry-enricher.mjs` | **New** | Haiku enrichment prompt + backfill logic |
| `mem-cli.mjs` | Modify | Add `import` and `enrich` subcommands |
| `cli.mjs` | Modify | Route new commands |
| `server.mjs` | Modify | `mem_registry` add `import_url` and `enrich` actions |
| `tool-schemas.mjs` | Modify | Update `memRegistrySchema` with new actions/fields |
| `schema.mjs` | Modify | Add migration for enrichment_status, repo_forks, etc. |
| `registry.mjs` | Modify | `upsertResource` support new fields |
| `commands/tools.md` | Modify | Update /mem:tools to reference new import command |
| Tests | ~4 new files | importer, enricher, CLI, integration |

## What Does NOT Change

- `registry-retriever.mjs` — search engine untouched (Phase 2)
- `install-metadata.mjs` — curated data preserved as top-priority override
- `registry-scanner.mjs` — local scan logic preserved (import=remote, scanner=local)
- `registry-indexer.mjs` — existing indexer preserved for backward compat

## Build Sequence

1. DB migration (schema.mjs) — add new columns
2. `registry-importer.mjs` — Stage 1 core (GitHub API + parse + upsert)
3. CLI integration — `import` command
4. `registry-enricher.mjs` — Stage 2 (Haiku + backfill)
5. CLI integration — `enrich` command
6. MCP tool updates — `import_url` and `enrich` actions
7. Zombie decay in maintain
8. Integration tests
