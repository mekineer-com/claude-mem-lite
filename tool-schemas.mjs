// Shared Zod schemas for MCP tool inputs
// Used by server.mjs (runtime) and contract.test.mjs (validation tests)

import { z } from 'zod';

export const OBS_TYPE_ENUM = z.enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

export const memSearchSchema = {
  query: z.string().optional(),
  type: z.enum(['observations', 'sessions', 'prompts']).optional(),
  obs_type: OBS_TYPE_ENUM.optional(),
  project: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  importance: z.number().int().min(1).max(3).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};

export const memTimelineSchema = {
  anchor: z.number().int().optional(),
  query: z.string().optional(),
  before: z.number().int().min(0).max(50).optional(),
  after: z.number().int().min(0).max(50).optional(),
  project: z.string().optional(),
};

export const memGetSchema = {
  ids: z.array(z.number().int()).min(1).max(20),
  source: z.enum(['obs', 'session', 'prompt']).optional(),
  fields: z.array(z.string()).optional(),
};

export const memDeleteSchema = {
  ids: z.array(z.number().int()).min(1).max(50),
  confirm: z.boolean(),
};

export const memSaveSchema = {
  content: z.string().min(1).max(50000),
  title: z.string().optional(),
  type: OBS_TYPE_ENUM.optional(),
  project: z.string().optional(),
  importance: z.number().int().min(1).max(3).optional(),
};

export const memStatsSchema = {
  project: z.string().optional(),
  days: z.number().int().min(1).max(365).optional(),
};

export const memCompressSchema = {
  preview: z.boolean().optional(),
  age_days: z.number().int().min(30).max(365).optional(),
  project: z.string().optional(),
};
