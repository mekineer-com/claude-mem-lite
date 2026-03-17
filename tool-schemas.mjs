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
  limit: coerceInt.pipe(z.number().int().min(1).max(100)).optional().describe('Max results (default 20)'),
  offset: coerceInt.pipe(z.number().int().min(0)).optional().describe('Offset for pagination'),
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
  importance: coerceInt.pipe(z.number().int().min(1).max(3)).optional().describe('Importance level: 1=routine, 2=notable, 3=critical (default: 1)'),
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
  operations: z.array(z.enum(['dedup', 'decay', 'cleanup', 'boost', 'purge_stale'])).optional()
    .describe('Operations to execute (for action=execute). purge_stale deletes idle-marked observations after user confirmation.'),
  merge_ids: z.preprocess(
    (v) => Array.isArray(v) ? v.map(g => Array.isArray(g) ? g.map(x => typeof x === 'string' ? parseInt(x, 10) : x) : g) : v,
    z.array(z.array(z.number().int()).min(2))
  ).optional().describe('For dedup: [[keepId, removeId1, removeId2], ...] — first ID in each group is kept'),
  retain_days: coerceInt.pipe(z.number().int().min(7).max(365)).optional()
    .describe('For purge_stale: keep observations newer than N days (default 30)'),
  project: z.string().optional().describe('Filter by project'),
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
