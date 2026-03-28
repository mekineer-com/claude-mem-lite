import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { createRegistryTestDb } from './test-helpers.mjs';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-skill-bridge.js');

function runScript(inputStr, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.on('error', reject);
    child.stdin.write(inputStr);
    child.stdin.end();
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 5000);
  });
}

describe('pre-skill-bridge', () => {
  describe('input parsing', () => {
    it('exits silently on invalid JSON', async () => {
      const { stdout } = await runScript('not json');
      expect(stdout).toBe('');
    });

    it('exits silently when tool_input.skill is missing', async () => {
      const { stdout } = await runScript(JSON.stringify({ tool_name: 'Skill', tool_input: {} }));
      expect(stdout).toBe('');
    });

    it('exits silently when CLAUDE_MEM_HOOK_RUNNING is set', async () => {
      const { stdout } = await runScript(
        JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'humanizer' } }),
        { CLAUDE_MEM_HOOK_RUNNING: '1' },
      );
      expect(stdout).toBe('');
    });
  });

  describe('managed skill resolution (DB-level)', () => {
    it('matches managed paths only', () => {
      const db = createRegistryTestDb();
      db.prepare(`
        INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name, capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack)
        VALUES ('humanizer', 'skill', 'preinstalled', 'hash', 'active', '/home/.claude-mem-lite/managed/skills/humanizer/SKILL.md', 'humanizer', 'Remove AI writing', '', '', '', '', '', '')
      `).run();
      db.prepare(`
        INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name, capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack)
        VALUES ('brainstorming', 'skill', 'preinstalled', 'hash', 'active', '/home/.claude/plugins/cache/superpowers/skills/brainstorming/SKILL.md', 'superpowers:brainstorming', '', '', '', '', '', '', '')
      `).run();

      const managed = db.prepare(`SELECT name FROM resources WHERE (name = ? OR invocation_name = ?) AND local_path LIKE '%managed%' AND status = 'active'`).get('humanizer', 'humanizer');
      const native = db.prepare(`SELECT name FROM resources WHERE (name = ? OR invocation_name = ?) AND local_path LIKE '%managed%' AND status = 'active'`).get('brainstorming', 'brainstorming');

      expect(managed).toBeTruthy();
      expect(native).toBeUndefined();
      db.close();
    });

    it('matches by invocation_name', () => {
      const db = createRegistryTestDb();
      db.prepare(`
        INSERT INTO resources (name, type, source, file_hash, status, local_path, invocation_name, capability_summary, trigger_patterns, keywords, intent_tags, use_cases, domain_tags, tech_stack)
        VALUES ('my-humanizer', 'skill', 'user', 'hash', 'active', '/home/.claude-mem-lite/managed/skills/humanizer/SKILL.md', 'humanizer', '', '', '', '', '', '', '')
      `).run();

      const row = db.prepare(`SELECT name FROM resources WHERE (name = ? OR invocation_name = ?) AND local_path LIKE '%managed%' AND status = 'active'`).get('humanizer', 'humanizer');
      expect(row).toBeTruthy();
      expect(row.name).toBe('my-humanizer');
      db.close();
    });
  });
});
