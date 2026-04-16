// Shared Zod schemas for MCP tool inputs
// Single source of truth — used by server.mjs (runtime) and contract.test.mjs (validation tests)

import { z } from 'zod';

export const OBS_TYPE_ENUM = z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

// LLM-friendly coercion: accept string numbers and normalize to proper types
const coerceInt = z.preprocess(
  (v) => (typeof v === 'string' && /^-?\d+$/.test(v.trim())) ? parseInt(v.trim(), 10) : v,
  z.number().int()
);

// LLM-friendly coercion: accept "true"/"false"/"True"/"TRUE" strings as boolean
const coerceBool = z.preprocess(
  (v) => typeof v === 'string' ? ({ true: true, false: false })[v.toLowerCase()] ?? v : v,
  z.boolean()
);

// Coerce ids: accept single number, string "123", comma-separated "1,2,3", or array
const coerceIntArray = z.preprocess(
  (v) => {
    if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? parseInt(x, 10) : x);
    if (typeof v === 'number') return [v];
    if (typeof v === 'string') return v.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    return v;
  },
  z.array(z.number().int())
);

export const memSearchSchema = {
  query: z.string().optional().describe('Search query (FTS5 syntax supported)'),
  type: z.enum(['observations', 'sessions', 'prompts']).optional().describe('Limit to one table'),
  obs_type: OBS_TYPE_ENUM.optional().describe('Filter observation type'),
  project: z.string().optional().describe('Filter by project name'),
  date_from: z.string().optional().describe('Start date (ISO 8601 or YYYY-MM-DD)'),
  date_to: z.string().optional().describe('End date (ISO 8601 or YYYY-MM-DD). Date-only format is inclusive (covers full day)'),
  importance: coerceInt.pipe(z.number().int().min(1).max(3)).optional().describe('Minimum importance (1=routine, 2=notable, 3=critical)'),
  branch: z.string().optional().describe('Filter by git branch name'),
  tier: z.enum(['working', 'active', 'archive']).optional().describe('Filter by memory tier (working=current session, active=within decay window, archive=old/compressed)'),
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max results (default 20)'),
  offset: coerceInt.pipe(z.number().int().min(0)).optional().describe('Offset for pagination'),
  sort: z.enum(['relevance', 'time', 'importance']).optional().describe('Sort order: relevance (default, BM25), time (newest first), importance (highest first)'),
  include_noise: z.boolean().optional().describe('Include hook-llm fallback titles ("Modified X", "Worked on X", raw error logs) — hidden by default as they have ~3% access rate'),
};

export const memRecentSchema = {
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max results (default 10)'),
  project: z.string().optional().describe('Filter by project (default: inferred from CWD)'),
};

export const memTimelineSchema = {
  anchor: coerceInt.pipe(z.number().int()).optional().describe('Observation ID as center point. Takes precedence over query when both are provided.'),
  query: z.string().optional().describe('FTS5 query to auto-find anchor. Ignored when anchor is also given; use one or the other.'),
  before: coerceInt.pipe(z.number().int().min(0).max(50)).optional().describe('Items before anchor (default 5)'),
  after: coerceInt.pipe(z.number().int().min(0).max(50)).optional().describe('Items after anchor (default 5)'),
  project: z.string().optional().describe('Filter by project'),
};

export const memGetSchema = {
  ids: coerceIntArray.pipe(z.array(z.number().int()).min(1).max(20)).describe('Observation IDs to retrieve'),
  source: z.enum(['obs', 'session', 'prompt']).optional().describe('Record type: obs (default), session (S# from search), prompt (P# from search)'),
  fields: z.array(z.string()).optional().describe('Specific fields to return (default: all)'),
};

export const memDeleteSchema = {
  ids: coerceIntArray.pipe(z.array(z.number().int()).min(1).max(50)).describe('Observation IDs to delete'),
  confirm: coerceBool.describe('false=preview what will be deleted, true=execute deletion'),
};

export const memSaveSchema = {
  content: z.string().min(1).max(50000).describe('Memory content to save'),
  title: z.string().optional().describe('Short title'),
  type: OBS_TYPE_ENUM.optional().describe('Observation type (default: discovery)'),
  project: z.string().optional().describe('Project name (default: inferred from CWD)'),
  importance: coerceInt.pipe(z.number().int().min(1).max(3)).optional().describe('Importance level: 1=routine, 2=notable, 3=critical (default: 2 for explicit saves)'),
  files: z.array(z.string()).optional().describe('File paths associated with this observation'),
  lesson_learned: z.string().max(500).optional().describe('Key lesson or takeaway (for bugfix: root cause & fix; for decision: rationale)'),
};

export const memStatsSchema = {
  project: z.string().optional().describe('Filter by project'),
  days: coerceInt.pipe(z.number().int().min(1).max(365)).optional().describe('Look back N days (default 30)'),
};

export const memCompressSchema = {
  preview: coerceBool.optional().describe('true=count candidates, false=execute compression (default: true)'),
  age_days: coerceInt.pipe(z.number().int().min(30).max(365)).optional().describe('Min age in days (default: 30, minimum: 30)'),
  project: z.string().optional().describe('Filter by project'),
};

export const memOptimizeSchema = {
  action: z.enum(['preview', 'run', 'run_all']).optional().default('preview')
    .describe('preview=scan candidates, run=execute with limits, run_all=bypass gates'),
  tasks: z.array(z.enum(['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'])).optional()
    .describe('Which optimization tasks to run (default: all)'),
  max_items: coerceInt.pipe(z.number().int().min(1).max(100)).optional().default(15)
    .describe('Maximum LLM calls across all tasks (default: 15)'),
  scope: z.enum(['narrow', 'wide']).optional().default('narrow')
    .describe("Re-enrich scope: narrow=narrative-only candidates (default); wide=R-7 backfill (bugfix/refactor/feature/decision with narrative but lesson_learned='none'). CLI parity: --scope wide."),
};

export const memMaintainSchema = {
  action: z.enum(['scan', 'execute']).describe('scan=analyze candidates, execute=apply changes'),
  operations: z.array(z.enum(['dedup', 'decay', 'cleanup', 'boost', 'purge_stale', 'rebuild_vectors'])).optional()
    .describe('Operations: dedup=find/merge duplicate observations, decay=reduce importance of old low-value obs, cleanup=remove orphaned records, boost=promote frequently-accessed obs, purge_stale=DELETE pending-purge obs older than retain_days (requires confirm=true; first call previews), rebuild_vectors=rebuild TF-IDF vocabulary and all observation vectors'),
  merge_ids: z.preprocess(
    (v) => Array.isArray(v) ? v.map(g => Array.isArray(g) ? g.map(x => typeof x === 'string' ? parseInt(x, 10) : x) : g) : v,
    z.array(z.array(z.number().int()).min(2))
  ).optional().describe('For dedup: [[keepId, removeId1, removeId2], ...] — first ID in each group is kept'),
  retain_days: coerceInt.pipe(z.number().int().min(7).max(365)).optional()
    .describe('For purge_stale: keep observations newer than N days (default 30)'),
  confirm: coerceBool.optional()
    .describe('Required for destructive ops in `execute` mode (currently: purge_stale). Omit/false → dry-run preview; true → actually delete.'),
  project: z.string().optional().describe('Filter by project'),
};

export const memUpdateSchema = {
  id: coerceInt.pipe(z.number().int().positive()).describe('Observation ID to update'),
  title: z.string().optional().describe('New title'),
  narrative: z.string().optional().describe('New narrative/content'),
  type: OBS_TYPE_ENUM.optional().describe('New observation type'),
  importance: coerceInt.pipe(z.number().int().min(1).max(3)).optional().describe('New importance (1-3)'),
  lesson_learned: z.string().optional().describe('Add or update lesson learned'),
  concepts: z.string().optional().describe('Space-separated concept tags'),
};

export const memExportSchema = {
  project: z.string().optional().describe('Filter by project'),
  type: OBS_TYPE_ENUM.optional().describe('Filter by observation type'),
  format: z.enum(['json', 'jsonl']).optional().describe('Output format (default: json)'),
  date_from: z.string().optional().describe('Start date (ISO 8601 or YYYY-MM-DD)'),
  date_to: z.string().optional().describe('End date (ISO 8601 or YYYY-MM-DD)'),
  include_compressed: coerceBool.optional().describe('Include compressed observations (default: false)'),
  limit: coerceInt.pipe(z.number().int().min(1).max(1000)).optional().describe('Max observations to export (default: 200, max: 1000)'),
};

export const memRecallSchema = {
  file: z.string().min(1).describe('File path or filename to recall observations for'),
  limit: coerceInt.pipe(z.number().int().min(1).max(50)).optional().describe('Max results (default 10)'),
};

export const memFtsCheckSchema = {
  action: z.enum(['check', 'rebuild']).describe('check=verify FTS integrity, rebuild=rebuild FTS indexes'),
};

export const memRegistrySchema = {
  action: z.enum(['list', 'stats', 'search', 'import', 'remove', 'reindex', 'import_url', 'enrich']).describe('Registry operation'),
  query: z.string().optional().describe('Search query — keywords describing what you need (for search)'),
  type: z.enum(['skill', 'agent']).optional().describe('Filter by resource type (for list/search)'),
  name: z.string().optional().describe('Resource name (for import/remove)'),
  resource_type: z.enum(['skill', 'agent']).optional().describe('Resource type (for import/remove)'),
  source: z.enum(['preinstalled', 'user', 'github']).optional().describe('Source (for import, default: user)'),
  repo_url: z.string().optional().describe('GitHub repository URL (for import)'),
  local_path: z.string().optional().describe('Local file path (for import)'),
  invocation_name: z.string().optional().describe('Invocation name like "plugin:skill" (for import)'),
  intent_tags: z.string().optional().describe('Comma-separated intent tags (for import)'),
  domain_tags: z.string().optional().describe('Comma-separated domain/tech tags (for import)'),
  trigger_patterns: z.string().optional().describe('When to recommend this tool (for import)'),
  capability_summary: z.string().optional().describe('What this tool does (for import)'),
  keywords: z.string().optional().describe('Search keywords (for import)'),
  tech_stack: z.string().optional().describe('Technology stack tags (for import)'),
  use_cases: z.string().optional().describe('Usage scenarios (for import)'),
  url: z.string().optional().describe('GitHub repository URL (for import_url action)'),
  enrich: coerceBool.optional().describe('Auto-enrich imported resources (for import_url action)'),
  category: z.string().optional().describe("Filter by category (e.g., 'testing', 'code-quality', 'debugging')"),
  quality: z.enum(['installed', 'verified', 'community']).optional().describe('Filter by quality tier (default: all)'),
};

export const memUseSchema = {
  name: z.string().min(1).describe('Skill or agent name to load (exact name or search query)'),
  type: z.enum(['skill', 'agent']).optional().describe('Resource type (default: skill)'),
};

export const memBrowseSchema = {
  project: z.string().optional().describe('Filter by project (default: inferred from CWD)'),
  tier: z.enum(['working', 'active', 'archive']).optional().describe('Show only this tier'),
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max entries per tier (default 5, or 20 when filtering by tier)'),
};

// ────────────────────────────────────────────────────────────────────────────
// Tool descriptions — discouragement style (Task 5, v2.31)
//
// Every entry follows a fixed template so Claude can skim quickly:
//   <one-line purpose>
//   DO NOT use when: ... (most common misuse / redundant-with-builtin)
//   USE when: ......... (high-value triggers)
//   Equivalent CLI: .... (or "MCP only" if no CLI handler exists)
//
// Research note: discouragement-style descriptions reduce over-invocation by
// 40-60% vs. encouragement-style ("use this to..."). See tests/tool-schemas.test.mjs
// for the invariants this list must satisfy.
//
// Core vs hidden (v2.34.0): only 6 tools are exposed via MCP `tools/list`. The
// remaining 11 stay registered — and are still callable by name at the MCP
// protocol level (`tools/call` by exact name) — but are omitted from the list
// response so they don't bloat every agent's startup context. The core set
// covers the hot paths the invited-memory contract promises (recall before
// Edit, save after bugfix, search/recent/timeline/get for retrieval). Hidden
// tools are either maintenance (compress/maintain/optimize/fts_check),
// admin/infra (stats/export/update/delete), or specialized browsers
// (browse/registry/use) — all of which have CLI equivalents documented in
// `adopt-content.mjs`.
// ────────────────────────────────────────────────────────────────────────────

export const tools = [
  {
    name: 'mem_search',
    description:
      'Full-text search across observations, sessions, and user prompts (FTS5, BM25-ranked).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The SessionStart context or hook-injected memory already shows #NN entries that answer the question\n' +
      '  - You only need recent items (use mem_recent)\n' +
      '  - You want everything about a specific file (use mem_recall — cheaper and file-scoped)\n' +
      '\n' +
      'USE when:\n' +
      '  - Investigating a concrete error keyword with obs_type="bugfix"\n' +
      '  - Looking for prior art on a module/feature before refactoring\n' +
      '  - User asks "have we seen this before" or references something not in visible context\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite search "<query>" [--type bugfix]',
    inputSchema: memSearchSchema,
  },
  {
    name: 'mem_recent',
    description:
      'List the most recent observations for the current project, newest first.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You are searching for a topic (use mem_search — this tool does no filtering)\n' +
      '  - SessionStart already printed a recent-activity block (it is the same data)\n' +
      '  - You need details for a specific ID (use mem_get)\n' +
      '\n' +
      'USE when:\n' +
      '  - Resuming after a long gap and the injected context is stale\n' +
      '  - User asks "what did we do yesterday / last" with no topic keyword\n' +
      '  - Verifying that a just-made change was captured as an observation\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite recent [N]',
    inputSchema: memRecentSchema,
  },
  {
    name: 'mem_timeline',
    description:
      'Show observations before and after an anchor point (by ID or by FTS query).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You only want one record (use mem_get)\n' +
      '  - You have no anchor in mind and are just browsing (use mem_recent or mem_browse)\n' +
      '  - The sequence is obvious from commit history (use git log)\n' +
      '\n' +
      'USE when:\n' +
      '  - Reconstructing what led up to / followed a specific bug or decision\n' +
      '  - A search hit is interesting and you want its chronological neighbours\n' +
      '  - Replaying a session narrative around a known observation ID\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite timeline --anchor <ID> [--before N --after N]',
    inputSchema: memTimelineSchema,
  },
  {
    name: 'mem_get',
    description:
      'Fetch full records (narrative, lesson_learned, files, concepts) by ID.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You have not seen the ID referenced anywhere (use mem_search first)\n' +
      '  - You only need title/type — that is already in the search result line\n' +
      '  - You are speculatively paging through IDs (use mem_recent / mem_browse)\n' +
      '\n' +
      'USE when:\n' +
      '  - Hook-injected context shows #NN and you need the full narrative/lesson\n' +
      '  - A mem_search hit looks relevant and you need the supporting detail\n' +
      '  - For session (S#) or prompt (P#) hits, pass source="session" or "prompt"\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite get <id>[,<id>,...]',
    inputSchema: memGetSchema,
  },
  {
    name: 'mem_delete',
    description:
      'Delete observations by ID. Destructive — always preview with confirm=false first.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The goal is to lower relevance, not erase (use mem_update or let decay handle it)\n' +
      '  - You suspect duplicates (use mem_maintain action="scan" operations=["dedup"])\n' +
      '  - User has not explicitly asked to forget / delete something\n' +
      '\n' +
      'USE when:\n' +
      '  - User says "delete #42" or "remove that note about X"\n' +
      '  - Cleaning up an observation saved from a test run or incorrect save\n' +
      '  - Always run once with confirm=false, then again with confirm=true\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite delete <id>[,<id>,...] [--confirm]',
    inputSchema: memDeleteSchema,
    hidden: true,
  },
  {
    name: 'mem_save',
    description:
      'Persist a memory with optional lesson_learned. Prefer type="bugfix" or "decision" — other types have ~16% retrieval rate.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The content is trivial (renames, style, formatting — hook episode batching handles these)\n' +
      '  - lesson_learned would be "none" or restate the title — save only actionable insight\n' +
      '  - It duplicates an existing observation (search first if unsure)\n' +
      '\n' +
      'USE when:\n' +
      '  - After fixing a non-trivial bug — set type="bugfix", lesson_learned="<root cause + fix>"\n' +
      '  - After a non-obvious architecture/tradeoff decision — set type="decision", lesson_learned="<constraint + why>"\n' +
      '  - User explicitly asks "remember this" or "save a note that ..."\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite save --type bugfix --lesson "..." "<content>"',
    inputSchema: memSaveSchema,
  },
  {
    name: 'mem_stats',
    description:
      'Memory-system statistics: counts, types, projects, daily activity, data health.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - During active coding — stats are for maintenance/diagnosis, not code work\n' +
      '  - You need actual content (use mem_search / mem_recent / mem_browse)\n' +
      '  - Triaging one bad result — run mem_fts_check instead\n' +
      '\n' +
      'USE when:\n' +
      '  - User asks "how much memory do we have" / "is the DB healthy"\n' +
      '  - Diagnosing why search feels sparse or noisy at a macro level\n' +
      '  - Auditing a project before major compression/maintenance\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite stats [--project X] [--days 30]',
    inputSchema: memStatsSchema,
    hidden: true,
  },
  {
    name: 'mem_compress',
    description:
      'Roll up old low-value observations into weekly summaries. Destructive in execute mode.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - DB is small (<1000 observations) — compression overhead outweighs benefit\n' +
      '  - Observations are <30 days old (the tool rejects age_days<30 anyway)\n' +
      '  - Unsure — always run with preview=true first\n' +
      '\n' +
      'USE when:\n' +
      '  - User says "clean up old memories" / "compress history"\n' +
      '  - After a major project phase completes and old per-file observations are noise\n' +
      '  - Stats show thousands of low-importance rows dragging search quality\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite compress [--preview] [--age-days 90]',
    inputSchema: memCompressSchema,
    hidden: true,
  },
  {
    name: 'mem_maintain',
    description:
      'Two-phase maintenance: scan (safe) then execute (mutating). Handles dedup / decay / cleanup / boost / purge_stale / rebuild_vectors.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - Search quality is fine — this is scheduled maintenance, not per-query tuning\n' +
      '  - You want to delete a specific ID (use mem_delete)\n' +
      '  - Calling execute without first running scan and reviewing candidates\n' +
      '\n' +
      'USE when:\n' +
      '  - Search results show obvious duplicates or stale entries\n' +
      '  - After bulk imports or a long offline period\n' +
      '  - User asks for periodic maintenance / cleanup\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite maintain --action scan --operations dedup,decay',
    inputSchema: memMaintainSchema,
    hidden: true,
  },
  {
    name: 'mem_optimize',
    description:
      'LLM-powered deep optimization: re-enrich, normalize, cluster-merge, smart-compress. Costs Haiku tokens per candidate.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You have not run mem_maintain first — optimize is the expensive last resort\n' +
      '  - Cost matters this session (each candidate is one LLM call)\n' +
      '  - action="run_all" without a preview — bypasses safety gates\n' +
      '\n' +
      'USE when:\n' +
      '  - Periodic deep maintenance (weekly/monthly) with budget available\n' +
      '  - stats show many degraded (title-only, no lesson) observations\n' +
      '  - Start with action="preview" to see candidates before spending tokens\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite optimize [--action preview|run|run_all] [--max-items N]',
    inputSchema: memOptimizeSchema,
    hidden: true,
  },
  {
    name: 'mem_registry',
    description:
      'Manage the skill/agent resource registry (list, stats, search, import, remove, reindex, enrich).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - Searching project memory (use mem_search — registry is tool resources, not observations)\n' +
      '  - You already know the skill name and just want to load it (use mem_use)\n' +
      '  - Importing from a random URL user has not explicitly trusted\n' +
      '\n' +
      'USE when:\n' +
      '  - User asks "what skills/agents are installed" → action="list"\n' +
      '  - Looking for a tool by capability → action="search" with keywords\n' +
      '  - User explicitly asks to import a GitHub repo → action="import_url"\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite registry <list|search|import|...> [args]',
    inputSchema: memRegistrySchema,
    hidden: true,
  },
  {
    name: 'mem_use',
    description:
      'Load and activate a skill or agent from the registry by name (exact or fuzzy).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You have not confirmed the skill exists (run mem_registry action="list" first)\n' +
      '  - The user only asked about a skill, not to invoke it\n' +
      '  - A built-in Claude Code Skill is a better fit than a managed one\n' +
      '\n' +
      'USE when:\n' +
      '  - mem_registry search surfaced a promising skill and you want its full content\n' +
      '  - You know the invocation_name (e.g. "plugin:foo") and need its instructions\n' +
      '  - User says "run the <X> skill" where X is a registered resource\n' +
      '\n' +
      'Equivalent CLI: MCP only (no CLI handler — use mem_registry to inspect)',
    inputSchema: memUseSchema,
    hidden: true,
  },
  {
    name: 'mem_update',
    description:
      'Edit an existing observation in place (title, narrative, type, importance, lesson_learned, concepts).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The record should be erased (use mem_delete)\n' +
      '  - You want to save a brand-new insight (use mem_save — preserves audit trail)\n' +
      '  - Bulk-adjusting importance across many rows (use mem_maintain decay/boost)\n' +
      '\n' +
      'USE when:\n' +
      '  - A specific observation has a wrong title/type and user points it out\n' +
      '  - You later discover additional context worth appending to lesson_learned\n' +
      '  - Reclassifying an observation after its true type becomes clear\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite update <id> [--title ...] [--lesson ...]',
    inputSchema: memUpdateSchema,
    hidden: true,
  },
  {
    name: 'mem_export',
    description:
      'Dump observations as JSON or JSONL for backup / sharing / inspection.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - You want to read a few records (use mem_get / mem_recent — export is bulk)\n' +
      '  - Searching — JSON dump is not a substitute for FTS (use mem_search)\n' +
      '  - Size is unbounded — always pass `limit` and optional `date_from`/`date_to`\n' +
      '\n' +
      'USE when:\n' +
      '  - Backing up memory before a migration or reinstall\n' +
      '  - Moving observations between machines or projects\n' +
      '  - User asks for a JSON snapshot of a project\'s memories\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite export [--format jsonl] [--project X] [--limit 500]',
    inputSchema: memExportSchema,
    hidden: true,
  },
  {
    name: 'mem_recall',
    description:
      'Recall past observations tied to a specific file path (fast, file-scoped alternative to mem_search).\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - The PreToolUse hook has already injected #NN lines for this file (reuse them — do not re-fetch)\n' +
      '  - You need current file contents (use Read)\n' +
      '  - The file is new or has never been edited — no memories will match\n' +
      '\n' +
      'USE when:\n' +
      '  - About to Edit/Write a file whose history you do not know\n' +
      '  - User asks "what do we know about <file>"\n' +
      '  - Investigating a recurring issue in a file you have not touched recently\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite recall "<file>" [--limit 10]',
    inputSchema: memRecallSchema,
  },
  {
    name: 'mem_fts_check',
    description:
      'Check FTS5 index integrity or rebuild indexes. Rebuild is expensive and holds the DB lock.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - Search merely returned an unexpected (but valid) result — that is a ranking issue, not corruption\n' +
      '  - The DB is actively being written to by another process\n' +
      '  - Running "rebuild" without first running "check" and seeing real corruption\n' +
      '\n' +
      'USE when:\n' +
      '  - Search throws FTS5 errors or returns impossible empty results for known keywords\n' +
      '  - After a crash, power loss, or manual DB edit\n' +
      '  - doctor / stats flags FTS integrity problems\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite fts-check [--rebuild]',
    inputSchema: memFtsCheckSchema,
    hidden: true,
  },
  {
    name: 'mem_browse',
    description:
      'Tier-grouped dashboard (working / active / archive) of recent observations per project.\n' +
      '\n' +
      'DO NOT use when:\n' +
      '  - SessionStart context already rendered a recent-activity block\n' +
      '  - You have a search query or file in mind (use mem_search / mem_recall)\n' +
      '  - You need detail — browse is an index, not a content view (follow up with mem_get)\n' +
      '\n' +
      'USE when:\n' +
      '  - User asks for an overview / dashboard of project memory\n' +
      '  - Triaging what to compress or clean up before running maintenance\n' +
      '  - Scanning for interesting anchors to follow up with mem_timeline\n' +
      '\n' +
      'Equivalent CLI: claude-mem-lite browse [--tier active] [--project X]',
    inputSchema: memBrowseSchema,
    hidden: true,
  },
];
