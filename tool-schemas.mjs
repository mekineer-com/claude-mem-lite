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
};

export const memRecentSchema = {
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max results (default 10)'),
  project: z.string().optional().describe('Filter by project (default: inferred from CWD)'),
};

export const memTimelineSchema = {
  anchor: coerceInt.pipe(z.number().int()).optional().describe('Observation ID as center point'),
  query: z.string().optional().describe('FTS5 query to auto-find anchor'),
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

export const memMaintainSchema = {
  action: z.enum(['scan', 'execute']).describe('scan=analyze candidates, execute=apply changes'),
  operations: z.array(z.enum(['dedup', 'decay', 'cleanup', 'boost', 'purge_stale', 'rebuild_vectors'])).optional()
    .describe('Operations: dedup=find/merge duplicate observations, decay=reduce importance of old low-value obs, cleanup=remove orphaned records, boost=promote frequently-accessed obs, purge_stale=delete decayed obs (needs confirm via scan first), rebuild_vectors=rebuild TF-IDF vocabulary and all observation vectors'),
  merge_ids: z.preprocess(
    (v) => Array.isArray(v) ? v.map(g => Array.isArray(g) ? g.map(x => typeof x === 'string' ? parseInt(x, 10) : x) : g) : v,
    z.array(z.array(z.number().int()).min(2))
  ).optional().describe('For dedup: [[keepId, removeId1, removeId2], ...] — first ID in each group is kept'),
  retain_days: coerceInt.pipe(z.number().int().min(7).max(365)).optional()
    .describe('For purge_stale: keep observations newer than N days (default 30)'),
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
  action: z.enum(['list', 'stats', 'search', 'import', 'remove', 'reindex']).describe('Registry operation'),
  query: z.string().optional().describe('Search query — keywords describing what you need (for search)'),
  type: z.enum(['skill', 'agent']).optional().describe('Filter by resource type (for list/search)'),
  name: z.string().optional().describe('Resource name (for import/remove)'),
  resource_type: z.enum(['skill', 'agent']).optional().describe('Resource type (for import/remove)'),
  source: z.enum(['preinstalled', 'user']).optional().describe('Source (for import, default: user)'),
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
  category: z.string().optional().describe("Filter by category (e.g., 'testing', 'code-quality', 'debugging')"),
  quality: z.enum(['installed', 'verified', 'community']).optional().describe('Filter by quality tier (default: all)'),
};

export const memBrowseSchema = {
  project: z.string().optional().describe('Filter by project (default: inferred from CWD)'),
  tier: z.enum(['working', 'active', 'archive']).optional().describe('Show only this tier'),
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max entries per tier (default 5, or 20 when filtering by tier)'),
};
