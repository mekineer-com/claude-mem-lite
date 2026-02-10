// Tests for v3 dispatch system: registry, retriever, dispatch, inject, feedback
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { upsertResource, getActiveResources, getResourceByName,
  updateResourceStats, recordInvocation, getSessionInvocations,
  updateInvocation, getResourceSuccessRates } from './registry.mjs';
import { buildEnhancedQuery, buildQueryFromText, retrieveResources } from './registry-retriever.mjs';
import { shouldSkipDispatch, extractContextSignals, needsHaikuDispatch } from './dispatch.mjs';
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
      trigger_patterns, capability_summary, intent_tags, domain_tags, name,
      content=resources, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS res_fts_insert AFTER INSERT ON resources BEGIN
      INSERT INTO resources_fts(rowid, trigger_patterns, capability_summary, intent_tags, domain_tags, name)
      VALUES (NEW.id, NEW.trigger_patterns, NEW.capability_summary, NEW.intent_tags, NEW.domain_tags, NEW.name);
    END;
    CREATE TRIGGER IF NOT EXISTS res_fts_update AFTER UPDATE ON resources BEGIN
      INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, capability_summary, intent_tags, domain_tags, name)
      VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.capability_summary, OLD.intent_tags, OLD.domain_tags, OLD.name);
      INSERT INTO resources_fts(rowid, trigger_patterns, capability_summary, intent_tags, domain_tags, name)
      VALUES (NEW.id, NEW.trigger_patterns, NEW.capability_summary, NEW.intent_tags, NEW.domain_tags, NEW.name);
    END;
    CREATE TRIGGER IF NOT EXISTS res_fts_delete AFTER DELETE ON resources BEGIN
      INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, capability_summary, intent_tags, domain_tags, name)
      VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.capability_summary, OLD.intent_tags, OLD.domain_tags, OLD.name);
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS invocations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id   INTEGER NOT NULL REFERENCES resources(id),
      session_id    TEXT,
      trigger       TEXT CHECK(trigger IN ('session_start','pre_tool_use','user_explicit')),
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
  return upsertResource(db, { ...defaults, ...overrides });
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
        techStack: 'javascript,react',
        action: 'edit',
        errorDomain: '',
      });
      expect(q).toBeTruthy();
      expect(q).toContain('OR');
    });

    it('returns null for empty signals', () => {
      expect(buildEnhancedQuery({ intent: '', techStack: '', action: '', errorDomain: '' })).toBeNull();
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

    it('skips simple bash queries', () => {
      const result = shouldSkipDispatch({ tool_name: 'Bash', tool_input: { command: 'git status' } });
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('simple_bash');
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
  });

  describe('needsHaikuDispatch', () => {
    it('returns true for empty results', () => {
      expect(needsHaikuDispatch([])).toBe(true);
    });

    it('returns true for low confidence results', () => {
      expect(needsHaikuDispatch([{ relevance: -1.0 }])).toBe(true);
    });

    it('returns false for high confidence results', () => {
      expect(needsHaikuDispatch([{ relevance: -5.0 }])).toBe(false);
    });

    it('returns true when top results are close', () => {
      expect(needsHaikuDispatch([
        { relevance: -5.0 },
        { relevance: -4.8 },
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
      techStack: 'typescript,react',
      action: 'edit',
      errorDomain: '',
    });
    const results = retrieveResources(db, query, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
  });
});
