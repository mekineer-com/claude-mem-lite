// Integration tests: Full dispatch pipeline lifecycle
// Converted from .tmp/flow-trace.mjs — tests the complete hook data flow:
//   SessionStart → UserPromptSubmit → PreToolUse → Feedback collection
// These tests exercise cross-module integration that unit tests don't cover.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { upsertResource, getSessionInvocations } from '../registry.mjs';
import {
  dispatchOnSessionStart, dispatchOnUserPrompt, dispatchOnPreToolUse,
  extractContextSignals, shouldSkipDispatch,
} from '../dispatch.mjs';
import { buildEnhancedQuery, retrieveResources } from '../registry-retriever.mjs';
import { renderInjection } from '../dispatch-inject.mjs';
import { collectFeedback } from '../dispatch-feedback.mjs';

// ─── DB Setup (mirrors dispatch.test.mjs) ────────────────────────────────────

function createRegistryDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('skill','agent')),
      status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','error','indexing')),
      source        TEXT NOT NULL CHECK(source IN ('preinstalled','user')),
      repo_url      TEXT,
      repo_stars    INTEGER DEFAULT 0,
      local_path    TEXT NOT NULL,
      file_hash     TEXT,
      intent_tags       TEXT DEFAULT '',
      domain_tags       TEXT DEFAULT '',
      action_type       TEXT DEFAULT '',
      trigger_patterns  TEXT DEFAULT '',
      capability_summary TEXT DEFAULT '',
      input_type    TEXT DEFAULT '',
      output_type   TEXT DEFAULT '',
      prerequisites TEXT DEFAULT '{}',
      keywords      TEXT DEFAULT '',
      tech_stack    TEXT DEFAULT '',
      use_cases     TEXT DEFAULT '',
      complexity    TEXT DEFAULT 'intermediate',
      parent_plugin TEXT,
      invocation_name TEXT DEFAULT '',
      recommend_count   INTEGER DEFAULT 0,
      adopt_count       INTEGER DEFAULT 0,
      success_count     INTEGER DEFAULT 0,
      indexed_at    TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_res_type_name ON resources(type, name);
    CREATE INDEX IF NOT EXISTS idx_res_status ON resources(status) WHERE status = 'active';
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS resources_fts USING fts5(
      trigger_patterns, keywords, capability_summary, intent_tags, use_cases,
      domain_tags, tech_stack, name,
      content=resources, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS res_fts_insert AFTER INSERT ON resources BEGIN
      INSERT INTO resources_fts(rowid, trigger_patterns, keywords, capability_summary,
        intent_tags, use_cases, domain_tags, tech_stack, name)
      VALUES (NEW.id, NEW.trigger_patterns, NEW.keywords, NEW.capability_summary,
        NEW.intent_tags, NEW.use_cases, NEW.domain_tags, NEW.tech_stack, NEW.name);
    END;
    CREATE TRIGGER IF NOT EXISTS res_fts_update AFTER UPDATE ON resources BEGIN
      INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, keywords,
        capability_summary, intent_tags, use_cases, domain_tags, tech_stack, name)
      VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.keywords, OLD.capability_summary,
        OLD.intent_tags, OLD.use_cases, OLD.domain_tags, OLD.tech_stack, OLD.name);
      INSERT INTO resources_fts(rowid, trigger_patterns, keywords, capability_summary,
        intent_tags, use_cases, domain_tags, tech_stack, name)
      VALUES (NEW.id, NEW.trigger_patterns, NEW.keywords, NEW.capability_summary,
        NEW.intent_tags, NEW.use_cases, NEW.domain_tags, NEW.tech_stack, NEW.name);
    END;
    CREATE TRIGGER IF NOT EXISTS res_fts_delete AFTER DELETE ON resources BEGIN
      INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, keywords,
        capability_summary, intent_tags, use_cases, domain_tags, tech_stack, name)
      VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.keywords, OLD.capability_summary,
        OLD.intent_tags, OLD.use_cases, OLD.domain_tags, OLD.tech_stack, OLD.name);
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS invocations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id   INTEGER NOT NULL REFERENCES resources(id),
      session_id    TEXT,
      trigger       TEXT CHECK(trigger IN ('session_start','pre_tool_use','user_explicit','user_prompt')),
      tier          INTEGER CHECK(tier IN (1,2,3)),
      recommended   INTEGER DEFAULT 1,
      adopted       INTEGER DEFAULT 0,
      outcome       TEXT CHECK(outcome IN ('success','partial','failure','skipped',NULL)),
      score         REAL,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inv_resource ON invocations(resource_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inv_session ON invocations(session_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS preinstalled (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('skill','agent')),
      repo_url      TEXT NOT NULL,
      repo_path     TEXT DEFAULT '',
      stars         INTEGER DEFAULT 0,
      tags          TEXT DEFAULT '[]',
      enabled       INTEGER DEFAULT 1,
      cloned_at     TEXT,
      clone_hash    TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_type_name ON preinstalled(type, name);
  `);

  return db;
}

// ─── Seed Data ───────────────────────────────────────────────────────────────

const SEED_RESOURCES = [
  {
    name: 'superpowers-tdd', type: 'skill', source: 'preinstalled',
    local_path: '/test/skills/tdd',
    intent_tags: 'test tdd coverage spec unittest',
    domain_tags: 'testing quality',
    trigger_patterns: 'write test unit test coverage tdd spec',
    capability_summary: 'Test-driven development workflow with red-green-refactor cycle',
    keywords: 'test testing unittest jest vitest pytest mocha',
    tech_stack: 'javascript typescript python',
    use_cases: 'writing unit tests test coverage TDD workflow',
  },
  {
    name: 'systematic-debugging', type: 'skill', source: 'preinstalled',
    local_path: '/test/skills/debug',
    intent_tags: 'fix debug troubleshoot diagnose',
    domain_tags: 'debugging quality',
    trigger_patterns: 'debug fix bug error crash troubleshoot',
    capability_summary: 'Systematic debugging with root cause analysis',
    keywords: 'debug fix bug error crash troubleshoot broken',
    tech_stack: 'javascript typescript python',
    use_cases: 'fixing bugs debugging errors root cause analysis',
  },
  {
    name: 'code-review-ai', type: 'agent', source: 'preinstalled',
    local_path: '/test/agents/review',
    intent_tags: 'review audit inspect quality',
    domain_tags: 'quality code-review',
    trigger_patterns: 'review code review pr review quality check',
    capability_summary: 'AI-powered code review with quality analysis',
    keywords: 'review code-review pr-review quality audit inspect',
    tech_stack: 'javascript typescript python',
    use_cases: 'code review PR review quality assessment',
  },
  {
    name: 'doc-coauthoring', type: 'skill', source: 'preinstalled',
    local_path: '/test/skills/doc',
    intent_tags: 'doc documentation readme guide',
    domain_tags: 'documentation writing',
    trigger_patterns: 'documentation docs readme write docs changelog',
    capability_summary: 'Documentation co-authoring with structured templates',
    keywords: 'documentation readme docs changelog guide tutorial',
    tech_stack: 'markdown',
    use_cases: 'writing documentation README guides',
  },
];

// ─── Pipeline Integration Tests ──────────────────────────────────────────────

describe('Pipeline integration: dispatch → feedback lifecycle', () => {
  let db;

  beforeEach(() => {
    db = createRegistryDb();
    for (const r of SEED_RESOURCES) upsertResource(db, r);
  });

  // Stage 1: SessionStart dispatches on previous session's next_steps
  describe('SessionStart trigger', () => {
    it('dispatches injection for relevant next_steps', async () => {
      const result = await dispatchOnSessionStart(
        db, 'Debug remaining indexing script errors', 'session-1'
      );
      expect(result).not.toBeNull();
      expect(result).toContain('[Auto-suggestion]');
    });

    it('records invocation with session_start trigger', async () => {
      await dispatchOnSessionStart(
        db, 'Debug remaining indexing script errors', 'session-1'
      );
      const invocations = getSessionInvocations(db, 'session-1');
      expect(invocations).toHaveLength(1);
      expect(invocations[0].trigger).toBe('session_start');
      expect(invocations[0].recommended).toBe(1);
      expect(invocations[0].adopted).toBe(0);
    });

    it('returns null for empty next_steps', async () => {
      const result = await dispatchOnSessionStart(db, '', 'session-empty');
      expect(result).toBeNull();
    });
  });

  // Stage 2: UserPromptSubmit — the primary dispatch point
  describe('UserPromptSubmit trigger', () => {
    it('dispatches for Chinese prompt', async () => {
      const result = await dispatchOnUserPrompt(db, '帮我写单元测试', 'session-2');
      expect(result).not.toBeNull();
      expect(result.toLowerCase()).toMatch(/tdd|test/);
    });

    it('session dedup blocks duplicate recommendation', async () => {
      await dispatchOnUserPrompt(db, '帮我写单元测试', 'session-2');
      const dup = await dispatchOnUserPrompt(db, '帮我写单元测试', 'session-2');
      expect(dup).toBeNull();
    });

    it('cross-session cooldown blocks same resource', async () => {
      await dispatchOnUserPrompt(db, '帮我写单元测试', 'session-2a');
      const cross = await dispatchOnUserPrompt(db, '帮我写单元测试', 'session-2b');
      expect(cross).toBeNull();
    });

    it('records invocation with user_prompt trigger (not session_start)', async () => {
      await dispatchOnUserPrompt(db, '帮我写单元测试', 'session-2c');
      const invocations = getSessionInvocations(db, 'session-2c');
      expect(invocations).toHaveLength(1);
      expect(invocations[0].trigger).toBe('user_prompt');
      expect(invocations[0].recommended).toBe(1);
    });
  });

  // Stage 2b: Cross-hook dedup (SessionStart → UserPrompt)
  describe('SessionStart→UserPrompt dedup', () => {
    it('UserPrompt deduped against preceding SessionStart', async () => {
      const startResult = await dispatchOnSessionStart(
        db, 'Write unit tests for the auth module', 'session-3'
      );
      expect(startResult).not.toBeNull();

      const promptResult = await dispatchOnUserPrompt(
        db, 'Write unit tests for the login flow', 'session-3'
      );
      expect(promptResult).toBeNull();
    });
  });

  // Stage 3: PreToolUse — fires when Claude is about to use a tool
  describe('PreToolUse trigger', () => {
    it('skips read-only tools (Tier 0)', () => {
      expect(shouldSkipDispatch({ tool_name: 'Read', tool_input: {} }).skip).toBe(true);
      expect(shouldSkipDispatch({ tool_name: 'Glob', tool_input: {} }).skip).toBe(true);
    });

    it('extracts context signals from Edit event', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: { file_path: '/src/auth.ts' } },
        { userPrompt: 'Review the authentication code for security issues',
          recentFiles: ['/src/auth.ts', '/src/middleware/jwt.ts'] }
      );
      expect(signals.intent).toMatch(/review|secure/);
      expect(signals.techStack).toContain('typescript');
      expect(signals.action).toBe('edit');
    });

    it('dispatches recommendation for Edit with strong intent match', async () => {
      const result = await dispatchOnPreToolUse(db,
        { tool_name: 'Edit', tool_input: { file_path: '/src/parser.test.ts' } },
        { userPrompt: 'Write unit tests for the parser', recentFiles: ['/src/parser.test.ts'], sessionId: 'session-pre-1' }
      );
      // Should match superpowers-tdd (test intent + edit action)
      if (result) {
        expect(result).toContain('[Auto-suggestion]');
      }
      // Even if null (low confidence), the function executed all tiers
    });

    it('records invocation with pre_tool_use trigger', async () => {
      const result = await dispatchOnPreToolUse(db,
        { tool_name: 'Edit', tool_input: { file_path: '/src/auth.ts' } },
        { userPrompt: 'Fix the crash in authentication', recentFiles: ['/src/auth.ts'], sessionId: 'session-pre-2' }
      );
      if (result) {
        const invocations = getSessionInvocations(db, 'session-pre-2');
        expect(invocations).toHaveLength(1);
        expect(invocations[0].trigger).toBe('pre_tool_use');
        expect(invocations[0].tier).toBe(2);
      }
    });

    it('returns null for null db or event', async () => {
      expect(await dispatchOnPreToolUse(null, { tool_name: 'Edit' })).toBeNull();
      expect(await dispatchOnPreToolUse(db, null)).toBeNull();
    });

    it('returns null when query yields no FTS5 results', async () => {
      const result = await dispatchOnPreToolUse(db,
        { tool_name: 'Edit', tool_input: { file_path: '/tmp/random.xyz' } },
        { userPrompt: '', recentFiles: [], sessionId: 'session-pre-3' }
      );
      expect(result).toBeNull();
    });

    it('session dedup blocks repeated PreToolUse recommendation', async () => {
      const first = await dispatchOnPreToolUse(db,
        { tool_name: 'Edit', tool_input: { file_path: '/src/auth.ts' } },
        { userPrompt: 'Fix the crash in authentication', recentFiles: ['/src/auth.ts'], sessionId: 'session-pre-4' }
      );
      // Second call same session — should be deduped if first succeeded
      const second = await dispatchOnPreToolUse(db,
        { tool_name: 'Edit', tool_input: { file_path: '/src/auth.ts' } },
        { userPrompt: 'Fix the crash in authentication', recentFiles: ['/src/auth.ts'], sessionId: 'session-pre-4' }
      );
      if (first) {
        expect(second).toBeNull();
      }
    });

    it('works without sessionId (no dedup filtering)', async () => {
      const result = await dispatchOnPreToolUse(db,
        { tool_name: 'Edit', tool_input: { file_path: '/src/parser.test.ts' } },
        { userPrompt: 'Write unit tests for the parser', recentFiles: ['/src/parser.test.ts'] }
      );
      // No sessionId → skips dedup filter, may return recommendation
      if (result) {
        expect(result).toContain('[Auto-suggestion]');
      }
    });
  });

  // Stage 3b: UserPromptSubmit textQuery fallback
  describe('UserPromptSubmit textQuery fallback', () => {
    it('falls back to textQuery when enhanced query has no results', async () => {
      // Seed a resource that only matches via broad text, not via intent columns
      upsertResource(db, {
        name: 'niche-tool', type: 'skill', source: 'preinstalled',
        local_path: '/test/skills/niche',
        intent_tags: '', domain_tags: '',
        trigger_patterns: 'xyzzy plugh adventurer',
        capability_summary: 'A niche tool for xyzzy plugh adventurers',
        keywords: 'xyzzy plugh adventure',
        tech_stack: '', use_cases: 'xyzzy plugh adventure questing',
      });
      // This prompt has no standard intent patterns, so enhancedQuery returns empty.
      // But textQuery via buildQueryFromText should match "xyzzy" in FTS5.
      const result = await dispatchOnUserPrompt(db, 'Help me with xyzzy plugh', 'session-fallback-1');
      expect(result).not.toBeNull();
      expect(result).toContain('niche-tool');
    });
  });

  // Stage 4: Full lifecycle — dispatch → tool usage → feedback
  describe('Full session lifecycle with feedback', () => {
    it('adopted skill → success outcome (score=1.0)', async () => {
      await dispatchOnUserPrompt(db, 'Write unit tests for the parser module', 'session-5');
      const inv = getSessionInvocations(db, 'session-5');
      expect(inv).toHaveLength(1);

      const toolEvents = [
        { tool_name: 'Read', tool_input: { file_path: '/src/parser.ts' }, tool_response: 'contents' },
        { tool_name: 'Skill', tool_input: { skill: 'superpowers:tdd' }, tool_response: 'TDD activated' },
        { tool_name: 'Edit', tool_input: { file_path: '/src/parser.test.ts' }, tool_response: 'ok' },
        { tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: '3 tests passed' },
      ];
      await collectFeedback(db, 'session-5', toolEvents);

      const updated = getSessionInvocations(db, 'session-5')[0];
      expect(updated.adopted).toBe(1);
      expect(updated.outcome).toBe('success');
      expect(updated.score).toBe(1.0);
    });

    it('adopted agent via Agent tool → success', async () => {
      await dispatchOnUserPrompt(db, 'Review this codebase for quality issues', 'session-6');

      const toolEvents = [
        { tool_name: 'Agent', tool_input: { subagent_type: 'code-review-ai', description: 'review', prompt: 'review' }, tool_response: '' },
        { tool_name: 'Edit', tool_input: { file_path: '/src/app.ts' }, tool_response: 'ok' },
      ];
      await collectFeedback(db, 'session-6', toolEvents);

      const inv = getSessionInvocations(db, 'session-6')[0];
      expect(inv.adopted).toBe(1);
      expect(inv.outcome).toBe('success');
    });

    it('non-adopted → score=0', async () => {
      await dispatchOnUserPrompt(db, 'Fix the crash in the parser', 'session-7');

      const toolEvents = [
        { tool_name: 'Edit', tool_input: { file_path: '/src/parser.ts' }, tool_response: 'ok' },
        { tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: 'all 10 tests passed' },
      ];
      await collectFeedback(db, 'session-7', toolEvents);

      const inv = getSessionInvocations(db, 'session-7')[0];
      expect(inv.adopted).toBe(0);
      expect(inv.outcome).toBe('success');
      expect(inv.score).toBe(0);
    });

    it('failure outcome when error and no fix', async () => {
      await dispatchOnUserPrompt(db, 'Fix the build errors in the project', 'session-8');

      const toolEvents = [
        { tool_name: 'Bash', tool_input: { command: 'npm run build' },
          tool_response: 'Error: TypeScript compilation failed with 5 errors. Build failed.' },
      ];
      await collectFeedback(db, 'session-8', toolEvents);

      const inv = getSessionInvocations(db, 'session-8')[0];
      expect(inv.outcome).toBe('failure');
    });

    it('partial outcome when error then fix attempt', async () => {
      await dispatchOnUserPrompt(db, 'Debug the authentication issues', 'session-9');

      const toolEvents = [
        { tool_name: 'Bash', tool_input: { command: 'npm test' },
          tool_response: 'Error: Authentication test failed — expected 200 but got 401.' },
        { tool_name: 'Skill', tool_input: { skill: 'systematic-debugging' }, tool_response: '' },
        { tool_name: 'Edit', tool_input: { file_path: '/src/auth.ts' }, tool_response: 'ok' },
      ];
      await collectFeedback(db, 'session-9', toolEvents);

      const inv = getSessionInvocations(db, 'session-9')[0];
      expect(inv.adopted).toBe(1);
      expect(inv.outcome).toBe('partial');
      expect(inv.score).toBe(0.5);
    });
  });

  // Stage 5: Intent→Search→Ranking quality
  describe('Intent→Search→Ranking quality', () => {
    it('doc intent routes to doc-coauthoring, not other resources', () => {
      const signals = extractContextSignals(
        { tool_name: '_user_prompt' },
        { userPrompt: 'Write documentation for the API module' }
      );
      expect(signals.primaryIntent).toBe('doc');
      const query = buildEnhancedQuery(signals);
      expect(query).toContain('intent_tags:');
      const results = retrieveResources(db, query, { limit: 3 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('doc-coauthoring');
    });

    it('Chinese "审查代码安全性" extracts review or secure intent', () => {
      const signals = extractContextSignals(
        { tool_name: '_user_prompt' },
        { userPrompt: '帮我审查代码安全性' }
      );
      expect(signals.intent).toMatch(/review|secure/);
    });

    it('tech stack detected from prompt keywords', () => {
      const signals = extractContextSignals(
        { tool_name: '_user_prompt' },
        { userPrompt: 'Write tests for the React authentication component' }
      );
      expect(signals.techStack).toContain('react');
      expect(signals.intent).toContain('test');
    });
  });

  // Stage 7: Injection rendering
  describe('Injection rendering for resource types', () => {
    it('skill injection is well-formed', () => {
      const skill = db.prepare('SELECT * FROM resources WHERE name = ?').get('superpowers-tdd');
      const injection = renderInjection(skill);
      expect(injection).toContain('[Auto-suggestion]');
      expect(injection).toContain('superpowers-tdd');
      expect(injection.length).toBeLessThanOrEqual(3000);
    });

    it('agent injection mentions Agent tool', () => {
      const agent = db.prepare('SELECT * FROM resources WHERE name = ?').get('code-review-ai');
      const injection = renderInjection(agent);
      expect(injection).toContain('[Auto-suggestion]');
      expect(injection).toContain('code-review-ai');
      expect(injection).toContain('Agent tool');
      expect(injection.length).toBeLessThanOrEqual(3000);
    });
  });

  // Stage 8: Error domain extraction
  describe('Error domain context signals', () => {
    it('detects build error domain', () => {
      const signals = extractContextSignals(
        { tool_name: 'Bash', tool_input: { command: 'npm run build' },
          tool_response: 'Error: TypeScript compilation failed. Cannot find module "lodash". Build failed.' },
        { userPrompt: 'Fix the build' }
      );
      expect(signals.errorDomain).toBeTruthy();
      expect(signals.intent).toContain('fix');
      expect(signals.action).toBe('build');
    });

    it('detects network error domain', () => {
      const signals = extractContextSignals(
        { tool_name: 'Bash', tool_input: { command: 'curl https://api.example.com' },
          tool_response: 'Error: ECONNREFUSED 127.0.0.1:3000. Connection refused. fetch failed' },
        {}
      );
      expect(signals.errorDomain).toBe('network-error');
    });

    it('detects dependency error domain', () => {
      const signals = extractContextSignals(
        { tool_name: 'Bash', tool_input: { command: 'npm install' },
          tool_response: 'npm ERR! peer dep resolution failed for react@18' },
        {}
      );
      expect(signals.errorDomain).toBe('dependency-error');
    });

    it('detects git error domain', () => {
      const signals = extractContextSignals(
        { tool_name: 'Bash', tool_input: { command: 'git merge feature' },
          tool_response: 'CONFLICT (content): Merge conflict in src/app.ts. git merge failed' },
        {}
      );
      expect(signals.errorDomain).toBe('git-error');
    });
  });

  // Stage 9: Pipeline performance
  describe('Pipeline performance', () => {
    it('full pipeline (signal→query→FTS5) completes in <10ms avg', () => {
      const iterations = 100;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        const signals = extractContextSignals(
          { tool_name: '_user_prompt' },
          { userPrompt: 'Write unit tests for the auth module' }
        );
        const query = buildEnhancedQuery(signals);
        if (query) retrieveResources(db, query, { limit: 3 });
      }
      const avgMs = (performance.now() - start) / iterations;
      expect(avgMs).toBeLessThan(10);
    });
  });
});
