// Tests for v3 dispatch system: registry, retriever, dispatch, inject, feedback
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { upsertResource, getActiveResources, getResourceByName,
  updateResourceStats, recordInvocation, getSessionInvocations,
  updateInvocation, getResourceSuccessRates } from './registry.mjs';
import { buildEnhancedQuery, buildQueryFromText, retrieveResources } from './registry-retriever.mjs';
import { shouldSkipDispatch, extractContextSignals, needsHaikuDispatch,
  isRecentlyRecommended,
  _resetCircuitBreaker, _recordHaikuFailure, _recordHaikuSuccess,
  _isHaikuCircuitOpen, _NEGATION_EN, _NEGATION_CJK } from './dispatch.mjs';
import { renderInjection } from './dispatch-inject.mjs';
import { collectFeedback } from './dispatch-feedback.mjs';

// ─── Registry DB Helper ─────────────────────────────────────────────────────

function createRegistryDb() {
  // Use ensureRegistryDb with an in-memory path workaround
  // ensureRegistryDb expects a file path, so we create one inline
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = ON');

  // Apply schemas directly (same as ensureRegistryDb)
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

  // Canonical 8-column FTS5 schema — must match registry.mjs column order
  // BM25 weights: trigger_patterns(5), keywords(3), capability_summary(3),
  //   intent_tags(2), use_cases(2), domain_tags(1), tech_stack(1), name(1)
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

function seedResource(db, overrides = {}) {
  const { recommend_count, adopt_count, success_count, ...rest } = overrides;
  const defaults = {
    name: 'test-skill',
    type: 'skill',
    status: 'active',
    source: 'preinstalled',
    local_path: '/tmp/test-skill',
    intent_tags: 'test,testing,tdd,qa',
    domain_tags: 'javascript,typescript',
    trigger_patterns: 'when user needs to write tests or run test suites',
    capability_summary: 'Automated test writing and execution',
  };
  const id = upsertResource(db, { ...defaults, ...rest });
  // Set counter fields directly (upsertResource doesn't set these)
  if (recommend_count !== undefined || adopt_count !== undefined || success_count !== undefined) {
    db.prepare(`UPDATE resources SET
      recommend_count = COALESCE(?, recommend_count),
      adopt_count = COALESCE(?, adopt_count),
      success_count = COALESCE(?, success_count)
      WHERE id = ?`
    ).run(recommend_count ?? null, adopt_count ?? null, success_count ?? null, id);
  }
  return id;
}

// ─── Registry Tests ─────────────────────────────────────────────────────────

describe('registry.mjs', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });

  describe('upsertResource', () => {
    it('inserts new resource and returns id', () => {
      const id = seedResource(db);
      expect(id).toBeGreaterThan(0);
      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
      expect(row.name).toBe('test-skill');
      expect(row.type).toBe('skill');
      expect(row.status).toBe('active');
    });

    it('upserts on conflict (same type+name)', () => {
      seedResource(db, { capability_summary: 'v1' });
      seedResource(db, { capability_summary: 'v2' });
      // Same row updated
      const rows = db.prepare('SELECT * FROM resources').all();
      expect(rows.length).toBe(1);
      expect(rows[0].capability_summary).toBe('v2');
    });

    it('handles agent type', () => {
      const id = seedResource(db, { name: 'code-review', type: 'agent' });
      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
      expect(row.type).toBe('agent');
    });
  });

  describe('getActiveResources', () => {
    it('returns only active resources', () => {
      seedResource(db, { name: 'active-one' });
      seedResource(db, { name: 'disabled-one', status: 'disabled' });
      const active = getActiveResources(db);
      expect(active.length).toBe(1);
      expect(active[0].name).toBe('active-one');
    });
  });

  describe('getResourceByName', () => {
    it('finds resource by type and name', () => {
      seedResource(db, { name: 'my-skill', type: 'skill' });
      const found = getResourceByName(db, 'skill', 'my-skill');
      expect(found).toBeTruthy();
      expect(found.name).toBe('my-skill');
    });

    it('returns null for nonexistent resource', () => {
      const found = getResourceByName(db, 'skill', 'nonexistent');
      expect(found).toBeUndefined();
    });
  });

  describe('updateResourceStats', () => {
    it('increments recommend_count', () => {
      const id = seedResource(db);
      updateResourceStats(db, id, 'recommend_count');
      updateResourceStats(db, id, 'recommend_count');
      const row = db.prepare('SELECT recommend_count FROM resources WHERE id = ?').get(id);
      expect(row.recommend_count).toBe(2);
    });

    it('increments adopt_count', () => {
      const id = seedResource(db);
      updateResourceStats(db, id, 'adopt_count');
      const row = db.prepare('SELECT adopt_count FROM resources WHERE id = ?').get(id);
      expect(row.adopt_count).toBe(1);
    });
  });

  describe('invocations', () => {
    it('records invocation and retrieves by session', () => {
      const id = seedResource(db);
      recordInvocation(db, {
        resource_id: id,
        session_id: 'sess-1',
        trigger: 'session_start',
        tier: 2,
        recommended: 1,
      });
      const invs = getSessionInvocations(db, 'sess-1');
      expect(invs.length).toBe(1);
      expect(invs[0].resource_id).toBe(id);
      expect(invs[0].trigger).toBe('session_start');
    });

    it('updates invocation with adoption and outcome', () => {
      const id = seedResource(db);
      recordInvocation(db, { resource_id: id, session_id: 'sess-1', trigger: 'pre_tool_use', tier: 2 });
      const invs = getSessionInvocations(db, 'sess-1');
      updateInvocation(db, invs[0].id, { adopted: 1, outcome: 'success', score: 1.0 });
      const updated = db.prepare('SELECT * FROM invocations WHERE id = ?').get(invs[0].id);
      expect(updated.adopted).toBe(1);
      expect(updated.outcome).toBe('success');
      expect(updated.score).toBe(1.0);
    });
  });

  describe('getResourceSuccessRates', () => {
    it('computes success rates from invocations', () => {
      const id = seedResource(db);
      // getResourceSuccessRates aggregates from invocations table, not resources
      recordInvocation(db, { resource_id: id, session_id: 's1', trigger: 'session_start', tier: 2, adopted: 1, score: 1.0 });
      recordInvocation(db, { resource_id: id, session_id: 's2', trigger: 'session_start', tier: 2, adopted: 0, score: 0 });
      const rates = getResourceSuccessRates(db);
      expect(rates.length).toBe(1);
      expect(rates[0].total).toBe(2);
      expect(rates[0].adopted).toBe(1);
    });
  });
});

// ─── Retriever Tests ─────────────────────────────────────────────────────────

describe('registry-retriever.mjs', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });

  describe('buildQueryFromText', () => {
    it('builds FTS5 query from text', () => {
      const q = buildQueryFromText('help me write tests for my React app');
      expect(q).toBeTruthy();
      expect(q).toContain('OR');
    });

    it('expands synonyms for known domains', () => {
      const q = buildQueryFromText('test coverage');
      expect(q).toBeTruthy();
      // 'test' should expand to include 'testing', 'tdd', etc.
      expect(q).toContain('testing');
    });

    it('filters stop words', () => {
      const q = buildQueryFromText('the a is are for with');
      // All stop words → null
      expect(q).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(buildQueryFromText('')).toBeNull();
      expect(buildQueryFromText(null)).toBeNull();
    });

    it('handles Chinese text', () => {
      const q = buildQueryFromText('帮我测试代码');
      expect(q).toBeTruthy();
    });
  });

  describe('buildEnhancedQuery', () => {
    it('builds query from context signals', () => {
      const q = buildEnhancedQuery({
        intent: 'test',
        primaryIntent: 'test',
        techStack: 'javascript,react',
        action: 'edit',
        errorDomain: '',
      });
      expect(q).toBeTruthy();
      expect(q).toContain('OR');
    });

    it('returns null for empty signals', () => {
      expect(buildEnhancedQuery({ intent: '', primaryIntent: '', techStack: '', action: '', errorDomain: '' })).toBeNull();
    });

    it('routes primary intent to intent_tags column', () => {
      const q = buildEnhancedQuery({
        intent: 'test,fix',
        primaryIntent: 'test',
        techStack: '',
        action: '',
        errorDomain: '',
      });
      expect(q).toContain('intent_tags:');
    });

    it('routes tech stack to domain_tags column', () => {
      const q = buildEnhancedQuery({
        intent: 'test',
        primaryIntent: 'test',
        techStack: 'typescript',
        action: '',
        errorDomain: '',
      });
      expect(q).toContain('domain_tags:');
    });

    it('excludes action (tool type) from FTS query — prevents noise', () => {
      const q = buildEnhancedQuery({
        intent: 'test',
        primaryIntent: 'test',
        techStack: '',
        action: 'edit',
        errorDomain: '',
      });
      // 'edit' should NOT appear in query — it's tool metadata, not user intent
      expect(q).not.toMatch(/\bedit\b/);
    });

    it('secondary intents go as general tokens (not column-targeted)', () => {
      const q = buildEnhancedQuery({
        intent: 'test,fix',
        primaryIntent: 'test',
        techStack: '',
        action: '',
        errorDomain: '',
      });
      // 'fix' should be expanded as general token, not column-targeted
      expect(q).toContain('intent_tags:');  // primary
      expect(q).toMatch(/\b(fix|debug|bugfix)\b/);  // secondary expanded
    });
  });

  describe('retrieveResources', () => {
    it('finds resources by FTS5 query', () => {
      seedResource(db, {
        name: 'tdd-workflow',
        intent_tags: 'test,testing,tdd',
        trigger_patterns: 'when writing tests or doing TDD',
        capability_summary: 'Test-driven development workflow',
      });
      const results = retrieveResources(db, 'test OR testing OR tdd');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('tdd-workflow');
    });

    it('returns empty for no match', () => {
      seedResource(db);
      const results = retrieveResources(db, 'kubernetes deployment helm');
      expect(results.length).toBe(0);
    });

    it('filters by type', () => {
      seedResource(db, { name: 'test-skill', type: 'skill', intent_tags: 'test' });
      seedResource(db, { name: 'test-agent', type: 'agent', intent_tags: 'test' });
      const skills = retrieveResources(db, 'test', { type: 'skill' });
      expect(skills.every(r => r.type === 'skill')).toBe(true);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        seedResource(db, { name: `skill-${i}`, intent_tags: 'test' });
      }
      const results = retrieveResources(db, 'test', { limit: 2 });
      expect(results.length).toBe(2);
    });

    it('handles malformed FTS5 query gracefully', () => {
      seedResource(db);
      // Unbalanced parentheses should not throw
      const results = retrieveResources(db, '((test OR');
      expect(Array.isArray(results)).toBe(true);
    });
  });
});

// ─── Dispatch Filter Tests ──────────────────────────────────────────────────

describe('dispatch.mjs', () => {
  describe('shouldSkipDispatch', () => {
    it('skips Skill tool', () => {
      const result = shouldSkipDispatch({ tool_name: 'Skill', tool_input: {} });
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('claude_chose_skill');
    });

    it('skips Task with subagent_type', () => {
      const result = shouldSkipDispatch({ tool_name: 'Task', tool_input: { subagent_type: 'Bash' } });
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('claude_chose_agent');
    });

    it('skips read-only tools', () => {
      for (const tool of ['Read', 'Glob', 'Grep', 'LSP', 'WebSearch']) {
        const result = shouldSkipDispatch({ tool_name: tool, tool_input: {} });
        expect(result.skip).toBe(true);
        expect(result.reason).toBe('read_only');
      }
    });

    it('skips MCP tools', () => {
      const result = shouldSkipDispatch({ tool_name: 'mcp__claude-in-chrome__screenshot', tool_input: {} });
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('mcp_tool');
    });

    it('skips simple bash queries like git status', () => {
      const result = shouldSkipDispatch({ tool_name: 'Bash', tool_input: { command: 'git status' } });
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('simple_bash');
    });

    it('does not skip git diff (meaningful review signal)', () => {
      const result = shouldSkipDispatch({ tool_name: 'Bash', tool_input: { command: 'git diff' } });
      expect(result.skip).toBe(false);
    });

    it('does not skip Edit tool', () => {
      const result = shouldSkipDispatch({ tool_name: 'Edit', tool_input: {} });
      expect(result.skip).toBe(false);
    });

    it('does not skip complex Bash commands', () => {
      const result = shouldSkipDispatch({ tool_name: 'Bash', tool_input: { command: 'npm run build' } });
      expect(result.skip).toBe(false);
    });

    it('does not skip Write tool', () => {
      const result = shouldSkipDispatch({ tool_name: 'Write', tool_input: {} });
      expect(result.skip).toBe(false);
    });
  });

  describe('extractContextSignals', () => {
    it('extracts intent from user prompt', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'help me write tests for this component' }
      );
      expect(signals.intent).toContain('test');
    });

    it('infers tech stack from recent files', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { recentFiles: ['src/App.tsx', 'src/utils.ts'] }
      );
      expect(signals.techStack).toContain('typescript');
    });

    it('infers action from tool name', () => {
      const signals = extractContextSignals({ tool_name: 'Edit', tool_input: {} });
      expect(signals.action).toBe('edit');
    });

    it('infers action from Bash test command', () => {
      const signals = extractContextSignals({ tool_name: 'Bash', tool_input: { command: 'vitest run' } });
      expect(signals.action).toBe('test');
    });

    it('extracts error domain from bash output', () => {
      const signals = extractContextSignals({
        tool_name: 'Bash',
        tool_input: { command: 'tsc --noEmit' },
        tool_response: 'error TS2345: Argument of type error blah blah',
      });
      expect(signals.errorDomain).toBe('type-error');
    });

    it('handles Chinese prompts', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: '帮我修复这个bug' }
      );
      expect(signals.intent).toContain('fix');
    });

    it('extracts primaryIntent as first detected intent', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'write tests for the auth module' }
      );
      expect(signals.primaryIntent).toBe('test');
    });

    it('excludes negated intents (English)', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: "don't run the tests yet, just fix the bug" }
      );
      expect(signals.intent).not.toContain('test');
      expect(signals.intent).toContain('fix');
    });

    it('excludes negated intents (Chinese)', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: '不要部署，先修复这个bug' }
      );
      expect(signals.intent).not.toContain('deploy');
      expect(signals.intent).toContain('fix');
    });

    it('handles "skip" as negation', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'skip the build step, just deploy' }
      );
      expect(signals.intent).not.toContain('build');
      expect(signals.intent).toContain('deploy');
    });

    it('handles "not" before intent keyword', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'do not deploy this yet, review first' }
      );
      expect(signals.intent).not.toContain('deploy');
      expect(signals.intent).toContain('review');
    });

    it('handles 别 as CJK negation', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: '别测试了，直接提交吧' }
      );
      expect(signals.intent).not.toContain('test');
      expect(signals.intent).toContain('commit');
    });

    it('extracts review intent from "审核" (Chinese review synonym)', () => {
      const signals = extractContextSignals(
        { tool_name: 'Bash', tool_input: { command: 'git diff' } },
        { userPrompt: '审核一下新开发功能的代码' }
      );
      expect(signals.intent).toContain('review');
      expect(signals.primaryIntent).toBe('review');
    });

    it('cross-variant: CJK negated but EN affirmative keeps the tag', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: '不要测试了，but write the tests for auth' }
      );
      // Chinese variant negated, English variant affirmed → tag should survive
      expect(signals.intent).toContain('test');
    });
  });

  describe('needsHaikuDispatch', () => {
    beforeEach(() => { _resetCircuitBreaker(); });

    it('returns true for empty results', () => {
      expect(needsHaikuDispatch([])).toBe(true);
    });

    it('returns true for single low-confidence result (below absolute minimum)', () => {
      expect(needsHaikuDispatch([{ relevance: -1.0 }])).toBe(true);
    });

    it('returns false for single high-confidence result', () => {
      expect(needsHaikuDispatch([{ relevance: -5.0 }])).toBe(false);
    });

    it('returns true when top results are close (gap < 10% of top score)', () => {
      expect(needsHaikuDispatch([
        { relevance: -5.0 },
        { relevance: -4.8 },
      ])).toBe(true);
    });

    it('returns false when top result has decisive lead', () => {
      expect(needsHaikuDispatch([
        { relevance: -8.0 },
        { relevance: -3.0 },
      ])).toBe(false);
    });

    it('uses relative threshold: top must be 1.5x mean or above 3.0', () => {
      // All results similar and low → needs Haiku
      expect(needsHaikuDispatch([
        { relevance: -1.5 },
        { relevance: -1.2 },
        { relevance: -1.0 },
      ])).toBe(true);
    });
  });
});

// ─── Injection Tests ─────────────────────────────────────────────────────────

describe('dispatch-inject.mjs', () => {
  describe('renderInjection', () => {
    it('renders skill injection with name and capability', () => {
      const text = renderInjection({
        name: 'tdd-workflow',
        type: 'skill',
        capability_summary: 'Test-driven development workflow',
        local_path: '/tmp/nonexistent-skill',
      });
      expect(text).toContain('tdd-workflow');
      expect(text).toContain('Test-driven development');
      expect(text).toContain('[Auto-suggestion]');
    });

    it('renders agent injection with Task tool guidance', () => {
      const text = renderInjection({
        name: 'code-review-ai',
        type: 'agent',
        capability_summary: 'AI-powered code review',
        local_path: '/tmp/nonexistent-agent',
      });
      expect(text).toContain('code-review-ai');
      expect(text).toContain('Task tool');
    });

    it('enforces max length', () => {
      const text = renderInjection({
        name: 'test-skill',
        type: 'skill',
        capability_summary: 'A'.repeat(5000),
        local_path: '/tmp/test-skill',
      });
      expect(text.length).toBeLessThanOrEqual(3000);
    });
  });
});

// ─── Feedback Tests ──────────────────────────────────────────────────────────

describe('dispatch-feedback.mjs', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });

  it('collects feedback for session invocations', async () => {
    const id = seedResource(db);
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-test',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    // No session events → outcome = skipped
    await collectFeedback(db, 'sess-test', []);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-test');
    expect(inv.outcome).toBe('skipped');
    expect(inv.adopted).toBe(0);
  });

  it('detects skill adoption from session events', async () => {
    const id = seedResource(db, { name: 'my-skill', type: 'skill' });
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-adopt',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'my-skill' } },
      { tool_name: 'Edit', tool_input: { file_path: '/test.js' } },
    ];

    await collectFeedback(db, 'sess-adopt', events);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-adopt');
    expect(inv.adopted).toBe(1);
    expect(inv.outcome).toBe('success');
    expect(inv.score).toBe(1.0);
  });

  it('detects agent adoption from Task tool usage', async () => {
    const id = seedResource(db, { name: 'code-review', type: 'agent' });
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-agent',
      trigger: 'pre_tool_use',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Task', tool_input: { description: 'code review analysis', prompt: 'review this code' } },
    ];

    await collectFeedback(db, 'sess-agent', events);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-agent');
    expect(inv.adopted).toBe(1);
  });

  it('detects failure outcome from error events', async () => {
    const id = seedResource(db);
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-fail',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'Error: test failed with exception' },
    ];

    await collectFeedback(db, 'sess-fail', events);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-fail');
    expect(inv.outcome).toBe('failure');
  });

  it('handles partial outcome (error then fix)', async () => {
    const id = seedResource(db);
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-partial',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'Error: test failed with exception blah' },
      { tool_name: 'Edit', tool_input: { file_path: '/fix.js' } },
    ];

    await collectFeedback(db, 'sess-partial', events);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-partial');
    expect(inv.outcome).toBe('partial');
  });

  it('updates resource stats on adoption + success', async () => {
    const id = seedResource(db, { name: 'adopted-skill', type: 'skill' });
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-stats',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'adopted-skill' } },
      { tool_name: 'Edit', tool_input: { file_path: '/test.js' } },
    ];

    await collectFeedback(db, 'sess-stats', events);
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
    expect(resource.adopt_count).toBe(1);
    expect(resource.success_count).toBe(1);
  });

  it('handles null db gracefully', async () => {
    // Should not throw
    await collectFeedback(null, 'sess-1', []);
  });

  it('handles null sessionId gracefully', async () => {
    await collectFeedback(db, null, []);
  });
});

// ─── Integration: FTS5 End-to-End ───────────────────────────────────────────

describe('FTS5 end-to-end dispatch', () => {
  let db;
  beforeEach(() => {
    db = createRegistryDb();
    // Seed a variety of resources
    seedResource(db, {
      name: 'superpowers-tdd',
      type: 'skill',
      intent_tags: 'test,testing,tdd,qa,spec',
      domain_tags: 'javascript,typescript',
      trigger_patterns: 'when user needs to write tests or do test-driven development',
      capability_summary: 'Test-driven development workflow with quality checks',
      repo_stars: 500,
    });
    seedResource(db, {
      name: 'code-review-ai',
      type: 'agent',
      intent_tags: 'review,code-review,quality,audit',
      domain_tags: 'javascript,python',
      trigger_patterns: 'when user wants code review or quality analysis',
      capability_summary: 'AI-powered comprehensive code review',
      repo_stars: 300,
    });
    seedResource(db, {
      name: 'superpowers-debugging',
      type: 'skill',
      intent_tags: 'debug,troubleshoot,fix,error,systematic',
      trigger_patterns: 'when user encounters bugs or errors to debug',
      capability_summary: 'Systematic debugging approach for complex issues',
      repo_stars: 400,
    });
    seedResource(db, {
      name: 'frontend-design',
      type: 'skill',
      intent_tags: 'design,ui,ux,frontend,css,component',
      domain_tags: 'css,react,frontend',
      trigger_patterns: 'when user needs to build or design UI components',
      capability_summary: 'Production-grade frontend interface design',
      repo_stars: 200,
    });
  });

  it('finds test skill for test-related query', () => {
    const query = buildQueryFromText('write unit tests for my React components');
    const results = retrieveResources(db, query, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    // tdd skill should rank highly
    const names = results.map(r => r.name);
    expect(names).toContain('superpowers-tdd');
  });

  it('finds debug skill for error-related query', () => {
    const query = buildQueryFromText('fix this bug in my code');
    const results = retrieveResources(db, query, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    const names = results.map(r => r.name);
    expect(names).toContain('superpowers-debugging');
  });

  it('finds review agent for review-related query', () => {
    const query = buildQueryFromText('review my code for quality');
    const results = retrieveResources(db, query, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    const names = results.map(r => r.name);
    expect(names).toContain('code-review-ai');
  });

  it('finds frontend skill for design query', () => {
    const query = buildQueryFromText('design a new React component');
    const results = retrieveResources(db, query, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    const names = results.map(r => r.name);
    expect(names).toContain('frontend-design');
  });

  it('uses enhanced query from context signals', () => {
    const query = buildEnhancedQuery({
      intent: 'test',
      primaryIntent: 'test',
      techStack: 'typescript,react',
      action: 'edit',
      errorDomain: '',
    });
    const results = retrieveResources(db, query, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── Ranking Formula Tests ──────────────────────────────────────────────────

describe('Composite ranking formula', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });

  it('new resource with 0 history is not buried (exploration bonus)', () => {
    // Established resource with moderate stats
    seedResource(db, {
      name: 'established-skill',
      intent_tags: 'test,testing',
      trigger_patterns: 'test runner',
      capability_summary: 'Run tests',
      recommend_count: 20,
      adopt_count: 10,
      success_count: 8,
      repo_stars: 500,
    });
    // Brand new resource with perfect intent match but 0 history
    seedResource(db, {
      name: 'new-skill',
      intent_tags: 'test,testing,tdd,qa,spec,coverage',
      trigger_patterns: 'when user needs to write and run comprehensive tests',
      capability_summary: 'Comprehensive test-driven development',
      recommend_count: 0,
      adopt_count: 0,
      success_count: 0,
      repo_stars: 0,
    });
    const results = retrieveResources(db, 'test OR testing OR tdd', { limit: 5 });
    expect(results.length).toBe(2);
    // New resource should still appear (not buried)
    const names = results.map(r => r.name);
    expect(names).toContain('new-skill');
  });

  it('zombie resource is penalized (high recommend, 0 adopt)', () => {
    // Zombie: recommended 20 times, never adopted
    seedResource(db, {
      name: 'zombie-skill',
      intent_tags: 'test,testing,tdd',
      trigger_patterns: 'when user needs to run tests and write test suites',
      capability_summary: 'Automated test runner and suite executor',
      recommend_count: 20,
      adopt_count: 0,
      success_count: 0,
      repo_stars: 100,
    });
    // Normal: recommended 10 times, adopted 5 times — same text signals
    seedResource(db, {
      name: 'healthy-skill',
      intent_tags: 'test,testing,tdd',
      trigger_patterns: 'when user needs to run tests and write test suites',
      capability_summary: 'Automated test runner and suite executor',
      recommend_count: 10,
      adopt_count: 5,
      success_count: 4,
      repo_stars: 100,
    });
    const results = retrieveResources(db, 'test OR testing OR tdd', { limit: 5 });
    expect(results.length).toBe(2);
    // Healthy should rank above zombie (zombie gets -0.10 penalty + worse Laplace rates)
    expect(results[0].name).toBe('healthy-skill');
  });

  it('star saturation prevents head-crushing', () => {
    // Mega-popular repo
    seedResource(db, {
      name: 'mega-star-skill',
      intent_tags: 'deploy',
      trigger_patterns: 'deployment automation',
      capability_summary: 'Deploy tool',
      repo_stars: 50000,
    });
    // Normal repo with better intent match
    seedResource(db, {
      name: 'normal-skill',
      intent_tags: 'deploy,release,publish,ci,cd',
      trigger_patterns: 'when user needs to deploy release publish ship',
      capability_summary: 'Deployment and release automation',
      repo_stars: 200,
    });
    const results = retrieveResources(db, 'deploy OR release OR publish', { limit: 5 });
    expect(results.length).toBe(2);
    // Normal skill with better text match should still rank well despite fewer stars
    const names = results.map(r => r.name);
    expect(names).toContain('normal-skill');
  });

  it('Laplace smoothing: small sample does not beat large sample', () => {
    // Resource with 10 successes out of 10 (naive: 100%, Laplace: 11/12 = 0.917)
    // Both past exploration bonus threshold (recommend_count >= 10)
    seedResource(db, {
      name: 'small-sample',
      intent_tags: 'review',
      trigger_patterns: 'code review quality analysis',
      capability_summary: 'Code review tool for quality',
      recommend_count: 10,
      adopt_count: 10,
      success_count: 10,
    });
    // Resource with 99 successes out of 100 (naive: 99%, Laplace: 100/102 = 0.980)
    seedResource(db, {
      name: 'proven-reliable',
      intent_tags: 'review',
      trigger_patterns: 'code review quality analysis',
      capability_summary: 'Code review tool for quality',
      recommend_count: 100,
      adopt_count: 95,
      success_count: 99,
    });
    const results = retrieveResources(db, 'review', { limit: 5 });
    // Laplace smoothing: proven-reliable (0.980) > small-sample (0.917)
    // With identical BM25 and both past exploration threshold, proven should rank higher
    expect(results.length).toBe(2);
    expect(results[0].name).toBe('proven-reliable');
  });
});

// ─── Circuit Breaker Tests ──────────────────────────────────────────────────

describe('Haiku circuit breaker', () => {
  beforeEach(() => { _resetCircuitBreaker(); });

  it('fresh breaker allows Haiku dispatch', () => {
    expect(_isHaikuCircuitOpen()).toBe(false);
    expect(needsHaikuDispatch([])).toBe(true);
  });

  it('opens after 3 consecutive failures', () => {
    _recordHaikuFailure();
    _recordHaikuFailure();
    expect(_isHaikuCircuitOpen()).toBe(false); // 2 failures: still closed
    _recordHaikuFailure();
    expect(_isHaikuCircuitOpen()).toBe(true); // 3 failures: open
  });

  it('blocks Haiku dispatch when circuit is open', () => {
    _recordHaikuFailure();
    _recordHaikuFailure();
    _recordHaikuFailure();
    // Circuit open → needsHaikuDispatch should return false (don't escalate)
    expect(needsHaikuDispatch([])).toBe(false);
    expect(needsHaikuDispatch([{ relevance: -0.5 }])).toBe(false);
  });

  it('resets on success', () => {
    _recordHaikuFailure();
    _recordHaikuFailure();
    _recordHaikuSuccess(); // reset
    _recordHaikuFailure(); // only 1 failure now
    expect(_isHaikuCircuitOpen()).toBe(false);
  });

  it('success after open resets breaker', () => {
    _recordHaikuFailure();
    _recordHaikuFailure();
    _recordHaikuFailure();
    expect(_isHaikuCircuitOpen()).toBe(true);
    _recordHaikuSuccess();
    expect(_isHaikuCircuitOpen()).toBe(false);
  });

  it('persists state to file across separate read/write cycles', () => {
    // Simulate cross-process: write failures, then read in separate calls
    _resetCircuitBreaker();
    _recordHaikuFailure();
    _recordHaikuFailure();
    // State should survive — each call reads from disk
    expect(_isHaikuCircuitOpen()).toBe(false); // 2 failures: still closed
    _recordHaikuFailure();
    // Now at threshold — breaker opens (persisted to file)
    expect(_isHaikuCircuitOpen()).toBe(true);
    // Reset and verify persisted reset
    _resetCircuitBreaker();
    expect(_isHaikuCircuitOpen()).toBe(false);
  });
});

// ─── Cooldown & Dedup Tests ─────────────────────────────────────────────────

describe('isRecentlyRecommended', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });

  it('returns false when no invocations exist', () => {
    const id = seedResource(db);
    expect(isRecentlyRecommended(db, id, 'sess-1')).toBe(false);
  });

  it('returns true for same session (session dedup)', () => {
    const id = seedResource(db);
    recordInvocation(db, { resource_id: id, session_id: 'sess-dup', trigger: 'session_start', tier: 2 });
    expect(isRecentlyRecommended(db, id, 'sess-dup')).toBe(true);
  });

  it('returns true within cooldown window (cross-session)', () => {
    const id = seedResource(db);
    recordInvocation(db, { resource_id: id, session_id: 'sess-old', trigger: 'session_start', tier: 2 });
    // Different session, but within cooldown
    expect(isRecentlyRecommended(db, id, 'sess-new')).toBe(true);
  });

  it('returns false for different resource in same session', () => {
    const id1 = seedResource(db, { name: 'skill-a' });
    const id2 = seedResource(db, { name: 'skill-b' });
    recordInvocation(db, { resource_id: id1, session_id: 'sess-1', trigger: 'session_start', tier: 2 });
    expect(isRecentlyRecommended(db, id2, 'sess-1')).toBe(false);
  });
});
