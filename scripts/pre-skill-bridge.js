#!/usr/bin/env node
// claude-mem-lite: PreToolUse Skill bridge — loads managed skills from registry
// Intercepts Skill("name") calls for skills in ~/.claude-mem-lite/managed/
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const REGISTRY_DB_PATH = join(homedir(), '.claude-mem-lite', 'resource-registry.db');
const MANAGED_MARKER = '/.claude-mem-lite/managed/';

try {
  // Skip if recursive hook
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) process.exit(0);

  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  // Parse event
  let skillName;
  try {
    const event = JSON.parse(input);
    skillName = event.tool_input?.skill;
  } catch { process.exit(0); }

  if (!skillName || typeof skillName !== 'string') process.exit(0);

  // Skip if registry DB doesn't exist
  if (!existsSync(REGISTRY_DB_PATH)) process.exit(0);

  // Open DB readonly
  const Database = (await import('better-sqlite3')).default;
  let db;
  try {
    db = new Database(REGISTRY_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
  } catch { process.exit(0); }

  try {
    // Query: find by name or invocation_name, ONLY if managed path
    const row = db.prepare(`
      SELECT name, local_path FROM resources
      WHERE status = 'active'
        AND (name = ? OR invocation_name = ?)
        AND local_path LIKE ?
      LIMIT 1
    `).get(skillName, skillName, `%${MANAGED_MARKER}%`);

    if (!row || !row.local_path) process.exit(0);

    // Resolve path: directory skills → SKILL.md (agents always have full .md paths)
    let skillPath = row.local_path;
    if (!skillPath.endsWith('.md')) {
      const candidate = join(skillPath, 'SKILL.md');
      if (existsSync(candidate)) skillPath = candidate;
    }

    if (!existsSync(skillPath)) process.exit(0);

    // Read and output
    const content = readFileSync(skillPath, 'utf8');
    // Token budget: ~4 chars per token, 4000 token limit = 16000 chars
    if (content.length > 16000) {
      const summary = content.slice(0, 800);
      console.log(`<skill-bridge name="${row.name}" source="managed" truncated="true">\n${summary}\n...\n</skill-bridge>\n\nSkill content truncated. Use mem_use(name="${row.name}") to load full content.`);
    } else {
      console.log(`<skill-bridge name="${row.name}" source="managed">\n${content}\n</skill-bridge>\n\nThis skill was loaded from the managed registry. Follow the instructions above.`);
    }
  } catch {
    // Silent failure — never block Skill tool
  } finally {
    try { db.close(); } catch {}
  }
} catch {
  // Top-level catch — exit 0 no matter what
}
