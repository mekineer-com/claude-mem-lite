// Shared Zod schemas for MCP tool inputs
// Single source of truth — used by server.mjs (runtime) and contract.test.mjs (validation tests)

import { z } from 'zod';

export const OBS_TYPE_ENUM = z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

export const memSearchSchema = {
  query: z.string().optional().describe('Search query (FTS5 syntax supported)'),
  type: z.enum(['observations', 'sessions', 'prompts']).optional().describe('Limit to one table'),
  obs_type: OBS_TYPE_ENUM.optional().describe('Filter observation type'),
  project: z.string().optional().describe('Filter by project name'),
  date_from: z.string().optional().describe('Start date (ISO 8601 or YYYY-MM-DD)'),
  date_to: z.string().optional().describe('End date (ISO 8601 or YYYY-MM-DD). Date-only format is inclusive (covers full day)'),
  importance: z.number().int().min(1).max(3).optional().describe('Minimum importance (1=routine, 2=notable, 3=critical)'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
  offset: z.number().int().min(0).optional().describe('Offset for pagination'),
};

export const memTimelineSchema = {
  anchor: z.number().int().optional().describe('Observation ID as center point'),
  query: z.string().optional().describe('FTS5 query to auto-find anchor'),
  before: z.number().int().min(0).max(50).optional().describe('Items before anchor (default 5)'),
  after: z.number().int().min(0).max(50).optional().describe('Items after anchor (default 5)'),
  project: z.string().optional().describe('Filter by project'),
};

export const memGetSchema = {
  ids: z.array(z.number().int()).min(1).max(20).describe('Observation IDs to retrieve'),
  source: z.enum(['obs', 'session', 'prompt']).optional().describe('Record type: obs (default), session (S# from search), prompt (P# from search)'),
  fields: z.array(z.string()).optional().describe('Specific fields to return (default: all)'),
};

export const memDeleteSchema = {
  ids: z.array(z.number().int()).min(1).max(50).describe('Observation IDs to delete'),
  confirm: z.boolean().describe('false=preview what will be deleted, true=execute deletion'),
};

export const memSaveSchema = {
  content: z.string().min(1).max(50000).describe('Memory content to save'),
  title: z.string().optional().describe('Short title'),
  type: OBS_TYPE_ENUM.optional().describe('Observation type (default: discovery)'),
  project: z.string().optional().describe('Project name (default: inferred from CWD)'),
  importance: z.number().int().min(1).max(3).optional().describe('Importance level: 1=routine, 2=notable, 3=critical (default: 1)'),
};

export const memStatsSchema = {
  project: z.string().optional().describe('Filter by project'),
  days: z.number().int().min(1).max(365).optional().describe('Look back N days (default 30)'),
};

export const memCompressSchema = {
  preview: z.boolean().optional().describe('true=count candidates, false=execute compression (default: true)'),
  age_days: z.number().int().min(30).max(365).optional().describe('Min age in days (default: 60)'),
  project: z.string().optional().describe('Filter by project'),
};
