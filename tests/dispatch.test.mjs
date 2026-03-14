// Tests for v3 dispatch system: registry, retriever, dispatch, inject, feedback
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { upsertResource, getActiveResources, getResourceByName,
  updateResourceStats, recordInvocation, getSessionInvocations,
  updateInvocation, getResourceSuccessRates } from '../registry.mjs';
import { buildEnhancedQuery, buildQueryFromText, retrieveResources } from '../registry-retriever.mjs';
import { shouldSkipDispatch, extractContextSignals,
  isRecentlyRecommended, SESSION_RECOMMEND_CAP, dispatchOnSessionStart,
  _NEGATION_EN, _NEGATION_CJK,
  _applyAdoptionDecay, _passesConfidenceGate as passesConfidenceGate,
  _filterAutoLoadedSkills, _filterGarbageMetadata } from '../dispatch.mjs';
import { renderInjection } from '../dispatch-inject.mjs';
import { collectFeedback, _detectAdoption as detectAdoption } from '../dispatch-feedback.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';

// ─── Registry DB Helper ─────────────────────────────────────────────────────

const createRegistryDb = createRegistryTestDb;

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
  afterEach(() => { db.close(); });

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
  afterEach(() => { db.close(); });

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

    it('skips Agent with subagent_type', () => {
      const result = shouldSkipDispatch({ tool_name: 'Agent', tool_input: { subagent_type: 'Bash' } });
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
    it('handles empty userPrompt without crash (I-1 regression guard)', () => {
      // extractIntent must return {intent, suppressed} even for empty input
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: '' }
      );
      expect(signals.intent).toBe('');
      expect(signals.suppressedIntents).toEqual([]);
    });

    it('handles null userPrompt without crash', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: null }
      );
      expect(signals.intent).toBe('');
    });

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

    it('excludes test intent for test-running prompts (run tests)', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'run the tests' }
      );
      expect(signals.intent).not.toContain('test');
    });

    it('excludes test intent for test-running prompts (npm test)', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'npm test' }
      );
      expect(signals.intent).not.toContain('test');
    });

    it('excludes test intent for test-running prompts (npx vitest)', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'npx vitest' }
      );
      expect(signals.intent).not.toContain('test');
    });

    it('excludes test intent for CJK test-running prompts', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: '运行测试看看结果' }
      );
      expect(signals.intent).not.toContain('test');
    });

    it('excludes test intent for CJK "跑单测"', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: '跑单测看看通过没' }
      );
      expect(signals.intent).not.toContain('test');
    });

    it('excludes test intent for "execute the tests"', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'execute the tests before deploying' }
      );
      expect(signals.intent).not.toContain('test');
    });

    it('keeps test intent for test-writing prompts', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'write tests for the auth module' }
      );
      expect(signals.intent).toContain('test');
    });

    it('keeps test intent for TDD prompts', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'use TDD to implement the new feature' }
      );
      expect(signals.intent).toContain('test');
    });

    it('keeps test intent when both running and writing are mentioned', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'run the tests and write tests for the missing cases' }
      );
      expect(signals.intent).toContain('test');
    });

    it('populates suppressedIntents when test-run suppresses test', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'npm test' }
      );
      expect(signals.intent).not.toContain('test');
      expect(signals.suppressedIntents).toContain('test');
    });

    it('suppressedIntents is empty when test intent is kept', () => {
      const signals = extractContextSignals(
        { tool_name: '_session_start' },
        { userPrompt: 'write tests for auth' }
      );
      expect(signals.intent).toContain('test');
      expect(signals.suppressedIntents).toEqual([]);
    });

    // ── Intent priority ordering tests (v2.0.12) ──
    // These verify that pattern array ordering produces correct primary intent.

    it('prioritizes review over commit: "review code before push"', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'review code before I push' }
      );
      expect(signals.primaryIntent).toBe('review');
      expect(signals.intent).toContain('commit');
    });

    it('prioritizes db over design: "design database schema"', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'design database schema' }
      );
      expect(signals.primaryIntent).toBe('db');
      expect(signals.intent).not.toContain('design');
    });

    it('maps spec to plan (not test)', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'I have a spec for the new module' }
      );
      expect(signals.primaryIntent).toBe('plan');
      expect(signals.intent).not.toContain('test');
    });

    it('bare "design" does not trigger design intent (ambiguous)', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'design the homepage' }
      );
      // "design" alone is too ambiguous — only UI-specific keywords trigger design
      expect(signals.intent).not.toContain('design');
    });

    it('UI keywords trigger design intent', () => {
      const signals = extractContextSignals(
        { tool_name: 'Edit', tool_input: {} },
        { userPrompt: 'create a responsive layout with tailwind' }
      );
      expect(signals.primaryIntent).toBe('design');
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
      expect(text).toContain('[Recommended]');
    });

    it('renders agent injection with Agent tool guidance', () => {
      const text = renderInjection({
        name: 'code-review-ai',
        type: 'agent',
        capability_summary: 'AI-powered code review',
        local_path: '/tmp/nonexistent-agent',
      });
      expect(text).toContain('code-review-ai');
      expect(text).toContain('Agent tool');
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
  afterEach(() => { db.close(); });

  it('collects feedback for session invocations', async () => {
    const id = seedResource(db);
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-test',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    // No session events → not adopted → outcome = ignored
    await collectFeedback(db, 'sess-test', []);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-test');
    expect(inv.outcome).toBe('ignored');
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

  it('detects agent adoption from Agent tool usage', async () => {
    const id = seedResource(db, { name: 'code-review', type: 'agent' });
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-agent',
      trigger: 'pre_tool_use',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Agent', tool_input: { description: 'code review analysis', prompt: 'review this code' } },
    ];

    await collectFeedback(db, 'sess-agent', events);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-agent');
    expect(inv.adopted).toBe(1);
  });

  it('detects failure outcome from error events', async () => {
    const id = seedResource(db, { name: 'fail-skill', type: 'skill' });
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-fail',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'fail-skill' } },
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'Error: test failed with exception' },
    ];

    await collectFeedback(db, 'sess-fail', events);
    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-fail');
    expect(inv.outcome).toBe('failure');
  });

  it('handles partial outcome (error then fix)', async () => {
    const id = seedResource(db, { name: 'partial-skill', type: 'skill' });
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-partial',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'partial-skill' } },
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

  it('double collectFeedback does not overwrite previous outcome', async () => {
    const id = seedResource(db, { name: 'double-skill', type: 'skill' });
    recordInvocation(db, {
      resource_id: id,
      session_id: 'sess-double',
      trigger: 'session_start',
      tier: 2,
      recommended: 1,
    });

    // First collection: skill adopted, edits made → success
    const events = [
      { tool_name: 'Skill', tool_input: { skill: 'double-skill' } },
      { tool_name: 'Edit', tool_input: { file_path: '/test.js' } },
    ];
    await collectFeedback(db, 'sess-double', events);
    const first = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-double');
    expect(first.outcome).toBe('success');
    expect(first.adopted).toBe(1);
    expect(first.score).toBe(1.0);

    // Second collection with empty events should NOT overwrite
    await collectFeedback(db, 'sess-double', []);
    const second = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-double');
    expect(second.outcome).toBe('success');
    expect(second.adopted).toBe(1);
    expect(second.score).toBe(1.0);
  });

  it('non-adopted recommendations get outcome=ignored and score=0', async () => {
    const resId = seedResource(db, { name: 'unused-skill', intent_tags: 'deploy' });
    recordInvocation(db, { resource_id: resId, session_id: 'sess-ignored', trigger: 'user_prompt', tier: 2 });

    const events = [
      { tool_name: 'Edit', tool_input: { file_path: 'foo.js' }, tool_response: '' },
    ];
    await collectFeedback(db, 'sess-ignored', events);

    const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-ignored');
    expect(inv.adopted).toBe(0);
    expect(inv.outcome).toBe('ignored');
    expect(inv.score).toBe(0);
  });

  describe('behavioral adoption detection', () => {
    it('detects debugging pattern (Read→Bash→Edit cycle) after debugging recommendation', () => {
      const inv = { resource_name: 'superpowers-debugging', resource_type: 'skill', invocation_name: 'superpowers:systematic-debugging' };
      const events = [
        { tool_name: 'Read', tool_input: { file_path: '/src/bug.js' } },
        { tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: 'FAIL: expected 1, got 2' },
        { tool_name: 'Read', tool_input: { file_path: '/src/bug.js' } },
        { tool_name: 'Edit', tool_input: { file_path: '/src/bug.js' } },
        { tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: 'PASS' },
      ];
      expect(detectAdoption(inv, events).adopted).toBe(true);
    });

    it('detects code-review pattern (Agent with review in prompt) after review recommendation', () => {
      const inv = { resource_name: 'superpowers-code-review', resource_type: 'skill', invocation_name: 'superpowers:requesting-code-review' };
      const events = [
        { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'review the code changes for quality issues', description: 'Code quality review' } },
      ];
      expect(detectAdoption(inv, events).adopted).toBe(true);
    });

    it('does NOT detect debugging pattern for unrelated resources', () => {
      const inv = { resource_name: 'frontend-design', resource_type: 'skill', invocation_name: 'frontend-design:frontend-design' };
      const events = [
        { tool_name: 'Read', tool_input: {} },
        { tool_name: 'Bash', tool_input: { command: 'test' }, tool_response: 'FAIL' },
        { tool_name: 'Edit', tool_input: {} },
      ];
      expect(detectAdoption(inv, events).adopted).toBe(false);
    });

    it('behavioral adoption requires activity within 10min of recommendation', () => {
      const inv = {
        resource_name: 'superpowers-debugging',
        resource_type: 'skill',
        invocation_name: 'superpowers:systematic-debugging',
        created_at: '2026-03-14T10:00:00Z',
      };

      // Activity 30s after recommendation → adopted
      const nearEvents = [
        { tool_name: 'Read', tool_input: { file_path: '/src/bug.js' }, timestamp: new Date('2026-03-14T10:00:10Z').getTime() },
        { tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: 'Error: expected 1, got 2', timestamp: new Date('2026-03-14T10:00:20Z').getTime() },
        { tool_name: 'Edit', tool_input: { file_path: '/src/bug.js' }, timestamp: new Date('2026-03-14T10:00:30Z').getTime() },
      ];
      expect(detectAdoption(inv, nearEvents).adopted).toBe(true);

      // Activity 15 minutes after recommendation → not adopted (outside 10min window)
      const farEvents = [
        { tool_name: 'Read', tool_input: { file_path: '/src/bug.js' }, timestamp: new Date('2026-03-14T10:15:10Z').getTime() },
        { tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: 'Error: expected 1, got 2', timestamp: new Date('2026-03-14T10:15:20Z').getTime() },
        { tool_name: 'Edit', tool_input: { file_path: '/src/bug.js' }, timestamp: new Date('2026-03-14T10:15:30Z').getTime() },
      ];
      expect(detectAdoption(inv, farEvents).adopted).toBe(false);
    });

    it('behavioral code-review adoption requires activity within 10min of recommendation', () => {
      const inv = {
        resource_name: 'superpowers-code-review',
        resource_type: 'skill',
        invocation_name: 'superpowers:requesting-code-review',
        created_at: '2026-03-14T10:00:00Z',
      };

      // Agent review 30s after recommendation → adopted
      const nearEvents = [
        { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'review the code', description: 'Code review' }, timestamp: new Date('2026-03-14T10:00:30Z').getTime() },
      ];
      expect(detectAdoption(inv, nearEvents).adopted).toBe(true);

      // Agent review 15 minutes after recommendation → not adopted
      const farEvents = [
        { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'review the code', description: 'Code review' }, timestamp: new Date('2026-03-14T10:15:30Z').getTime() },
      ];
      expect(detectAdoption(inv, farEvents).adopted).toBe(false);
    });
  });

  describe('rejection_reason classification', () => {
    it('sets rejection_reason to "no_events" when session events are empty', async () => {
      const id = seedResource(db, { name: 'noreason-skill', type: 'skill' });
      recordInvocation(db, {
        resource_id: id,
        session_id: 'sess-no-events',
        trigger: 'user_prompt',
        tier: 2,
        recommended: 1,
      });

      await collectFeedback(db, 'sess-no-events', []);
      const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-no-events');
      expect(inv.adopted).toBe(0);
      expect(inv.rejection_reason).toBe('no_events');
    });

    it('non-adopted with no matching pattern gets "unclassified" or specific reason, never empty', async () => {
      const id = seedResource(db, { name: 'fallback-skill', type: 'skill' });
      recordInvocation(db, {
        resource_id: id,
        session_id: 'sess-unclassified',
        trigger: 'user_prompt',
        tier: 2,
        recommended: 1,
        created_at: '2026-03-14T10:00:00Z',
      });

      // Provide events that don't match any known rejection pattern
      const events = [
        { tool_name: 'Read', tool_input: { file_path: '/a.js' }, timestamp: new Date('2026-03-14T10:00:05Z').getTime() },
      ];
      await collectFeedback(db, 'sess-unclassified', events);
      const inv = db.prepare('SELECT * FROM invocations WHERE session_id = ?').get('sess-unclassified');
      expect(inv.adopted).toBe(0);
      expect(inv.rejection_reason).toBeTruthy();
      // Should never be empty string or null for non-adopted
      expect(inv.rejection_reason).not.toBe('');
      expect(inv.rejection_reason).not.toBeNull();
    });
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
  afterEach(() => { db.close(); });

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

// ─── Cooldown & Dedup Tests ─────────────────────────────────────────────────

describe('isRecentlyRecommended', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });
  afterEach(() => { db.close(); });

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

  it('returns true when session reaches recommendation cap', () => {
    const ids = [];
    for (let i = 0; i < SESSION_RECOMMEND_CAP; i++) {
      ids.push(seedResource(db, { name: `skill-cap-${i}` }));
    }
    const newId = seedResource(db, { name: 'skill-over-cap' });
    // Fill up to cap with recommended invocations
    for (const id of ids) {
      recordInvocation(db, { resource_id: id, session_id: 'sess-cap', trigger: 'session_start', tier: 2, recommended: 1 });
    }
    // New resource should be blocked by session cap
    expect(isRecentlyRecommended(db, newId, 'sess-cap')).toBe(true);
  });

  it('allows recommendations below session cap', () => {
    const id1 = seedResource(db, { name: 'skill-under-1' });
    const id2 = seedResource(db, { name: 'skill-under-2' });
    recordInvocation(db, { resource_id: id1, session_id: 'sess-under', trigger: 'session_start', tier: 2, recommended: 1 });
    // Only 1 recommendation, cap is 3 — should be allowed
    expect(isRecentlyRecommended(db, id2, 'sess-under')).toBe(false);
  });
});

// ─── dispatchOnSessionStart handoff gate ─────────────────────────────────────

describe('dispatchOnSessionStart handoff gate', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });
  afterEach(() => { db.close(); });

  it('returns null when hasHandoff=false', async () => {
    seedResource(db, { name: 'some-skill', intent_tags: 'plan' });
    const result = await dispatchOnSessionStart(db, 'plan the feature', 'sess-1', { hasHandoff: false });
    expect(result).toBeNull();
  });

  it('returns null when hasHandoff is omitted (default false)', async () => {
    seedResource(db, { name: 'some-skill', intent_tags: 'plan' });
    const result = await dispatchOnSessionStart(db, 'plan the feature', 'sess-1');
    expect(result).toBeNull();
  });

  // DISABLED: dispatchOnSessionStart always returns null (0/119 adoption rate).
  it('returns null even with hasHandoff=true (dispatch disabled)', async () => {
    seedResource(db, {
      name: 'planning-skill', type: 'skill', intent_tags: 'plan,design,architecture',
      trigger_patterns: 'when user needs to plan features, design architecture, create implementation plans',
      capability_summary: 'Feature planning and architecture design workflow with structured output',
      keywords: 'plan,feature,architecture,design,roadmap',
      invocation_name: 'planning-skill',
    });
    seedResource(db, {
      name: 'test-runner', type: 'skill', intent_tags: 'test,tdd',
      trigger_patterns: 'when running unit tests and validating coverage',
      capability_summary: 'Automated test execution with coverage reporting and failure analysis',
    });
    seedResource(db, {
      name: 'debug-helper', type: 'skill', intent_tags: 'debug,fix',
      trigger_patterns: 'when debugging issues and analyzing stack traces',
      capability_summary: 'Interactive debugging workflow with root cause analysis and fix suggestions',
    });
    const result = await dispatchOnSessionStart(db, 'plan the feature', 'sess-2', { hasHandoff: true });
    expect(result).toBeNull();
  });
});

// ─── applyAdoptionDecay with db rejection dampening ──────────────────────────

describe('applyAdoptionDecay with db rejection dampening', () => {
  let db;
  beforeEach(() => { db = createRegistryDb(); });
  afterEach(() => { db.close(); });

  it('applies extra dampening for resources with many recent rejections', () => {
    const resId = seedResource(db, { name: 'over-recommended', recommend_count: 60, adopt_count: 1 });
    // Seed 10 recent rejections
    for (let i = 0; i < 10; i++) {
      recordInvocation(db, { resource_id: resId, session_id: `sess-${i}`, adopted: 0, outcome: 'ignored' });
    }

    const results = [{ id: resId, recommend_count: 60, adopt_count: 1, composite_score: -10.0, name: 'over-recommended' }];
    const decayed = _applyAdoptionDecay(results, db);
    expect(decayed.length).toBeGreaterThan(0);
    // Base multiplier: rate=(1+1)/(60+2)≈0.032 < 0.05 at 60 recs → 0.4
    // Recent rejection: 10 rejects → 0.4 * 0.3 = 0.12
    // composite_score: -10.0 * 0.12 = -1.2
    expect(Math.abs(decayed[0].composite_score)).toBeLessThan(2.0);
    expect(decayed[0]._decayed).toBe(true);
  });

  it('no extra dampening without db', () => {
    const results = [{ id: 1, recommend_count: 60, adopt_count: 1, composite_score: -10.0 }];
    const decayed = _applyAdoptionDecay(results, null);
    expect(decayed.length).toBe(1);
    // Only base multiplier 0.4 applies → -10 * 0.4 = -4
    expect(Math.abs(decayed[0].composite_score)).toBeCloseTo(4.0, 0);
  });
});

// ─── passesConfidenceGate BM25 floor ────────────────────────────────────────

describe('passesConfidenceGate BM25 floor', () => {
  it('filters weak single result below floor', () => {
    const results = [
      { composite_score: -0.3, intent_tags: 'test,tdd' },
    ];
    const signals = { intent: 'test', rawKeywords: [] };
    const filtered = passesConfidenceGate(results, signals);
    expect(filtered.length).toBe(0);
  });

  it('keeps strong single result above floor', () => {
    const results = [
      { composite_score: -2.5, intent_tags: 'test,tdd' },
    ];
    const signals = { intent: 'test', rawKeywords: [] };
    const filtered = passesConfidenceGate(results, signals);
    expect(filtered.length).toBe(1);
  });
});

// ─── passesConfidenceGate gap-ratio check ────────────────────────────────────

describe('passesConfidenceGate gap-ratio check', () => {
  it('filters when top-2 results are too close (ambiguous query)', () => {
    const results = [
      { intent_tags: 'test,tdd', composite_score: -3.0 },
      { intent_tags: 'test,coverage', composite_score: -2.8 },
      { intent_tags: 'test', composite_score: -1.0 },
    ];
    const signals = { intent: 'test', primaryIntent: 'test' };
    const filtered = passesConfidenceGate(results, signals);
    // Gap between 3.0 and 2.8 = 0.2, ratio = 0.2/3.0 = 0.067 < 0.2 → filtered
    expect(filtered.length).toBe(0);
  });

  it('keeps results when top-1 has clear lead over top-2', () => {
    const results = [
      { intent_tags: 'test,tdd', composite_score: -10.0 },
      { intent_tags: 'test', composite_score: -3.0 },
    ];
    const signals = { intent: 'test', primaryIntent: 'test' };
    const filtered = passesConfidenceGate(results, signals);
    // Gap = 7.0, ratio = 7.0/10.0 = 0.7 > 0.2 → keeps
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('passes single result through without gap check', () => {
    const results = [
      { intent_tags: 'test', composite_score: -5.0 },
    ];
    const signals = { intent: 'test', primaryIntent: 'test' };
    const filtered = passesConfidenceGate(results, signals);
    expect(filtered.length).toBe(1);
  });

  it('skips gap check when top1 score is zero', () => {
    const results = [
      { intent_tags: 'test', composite_score: 0 },
      { intent_tags: 'test', composite_score: 0 },
    ];
    const signals = { intent: 'test', primaryIntent: 'test' };
    // top1 = 0, skip gap check (division by zero guard)
    // But composite_score=0 means abs(0) = 0 < 0.5 minimum → filtered by BM25 floor
    const filtered = passesConfidenceGate(results, signals);
    expect(filtered.length).toBe(0);
  });
});

// ─── upsertResource repo_stars protection ───────────────────────────────────

describe('upsertResource repo_stars protection', () => {
  it('preserves existing repo_stars when new value is 0', () => {
    const db = createRegistryDb();
    upsertResource(db, {
      name: 'starred-skill', type: 'skill', source: 'preinstalled',
      local_path: '/tmp/s', repo_stars: 500,
      intent_tags: 'test', trigger_patterns: 'when testing',
      capability_summary: 'test skill',
    });
    upsertResource(db, {
      name: 'starred-skill', type: 'skill', source: 'preinstalled',
      local_path: '/tmp/s', repo_stars: 0,
      intent_tags: 'test', trigger_patterns: 'when testing',
      capability_summary: 'test skill',
    });
    const row = db.prepare('SELECT repo_stars FROM resources WHERE name = ?').get('starred-skill');
    expect(row.repo_stars).toBe(500);
    db.close();
  });

  it('updates repo_stars when new value is positive', () => {
    const db = createRegistryDb();
    upsertResource(db, {
      name: 'starred-skill', type: 'skill', source: 'preinstalled',
      local_path: '/tmp/s', repo_stars: 500,
      intent_tags: 'test', trigger_patterns: 'when testing',
      capability_summary: 'test skill',
    });
    upsertResource(db, {
      name: 'starred-skill', type: 'skill', source: 'preinstalled',
      local_path: '/tmp/s', repo_stars: 800,
      intent_tags: 'test', trigger_patterns: 'when testing',
      capability_summary: 'test skill',
    });
    const row = db.prepare('SELECT repo_stars FROM resources WHERE name = ?').get('starred-skill');
    expect(row.repo_stars).toBe(800);
    db.close();
  });
});

// ─── Adaptive Cooldown ──────────────────────────────────────────────────────

describe('adaptive cooldown', () => {
  // Helper: seed feedback invocations in the past (2 days ago) so they
  // contribute to adoption stats but don't interfere with cooldown checks.
  function seedFeedback(db, id, total, adoptedCount) {
    for (let i = 0; i < total; i++) {
      db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
        VALUES (?, ?, 'user_prompt', 2, 1, ?, ?, ?, datetime('now', '-2 days'))`).run(
        id, `feedback-${i}`,
        i < adoptedCount ? 1 : 0,
        i < adoptedCount ? 'success' : 'ignored',
        i < adoptedCount ? 1.0 : 0,
      );
    }
  }

  it('uses shorter cooldown when recent adoption rate is high', () => {
    const db = createRegistryDb();
    const id = seedResource(db);
    seedFeedback(db, id, 10, 8); // 80% adoption rate

    // Recommend 35 minutes ago (inside 60-min default, outside 30-min high-adoption cooldown)
    db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, created_at)
      VALUES (?, 'past-sess', 'user_prompt', 2, 1, datetime('now', '-35 minutes'))`).run(id);

    const result = isRecentlyRecommended(db, id, 'new-session');
    expect(result).toBe(false); // 35 min > 30 min adaptive cooldown
    db.close();
  });

  it('uses longer cooldown when recent adoption rate is low', () => {
    const db = createRegistryDb();
    const id = seedResource(db);
    seedFeedback(db, id, 10, 1); // 10% adoption rate

    // Recommend 90 minutes ago (outside 60-min default, inside 120-min low-adoption cooldown)
    db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, created_at)
      VALUES (?, 'past-sess', 'user_prompt', 2, 1, datetime('now', '-90 minutes'))`).run(id);

    const result = isRecentlyRecommended(db, id, 'new-session');
    expect(result).toBe(true); // 90 min < 120 min adaptive cooldown
    db.close();
  });

  it('uses default cooldown with insufficient data', () => {
    const db = createRegistryDb();
    const id = seedResource(db);
    seedFeedback(db, id, 2, 2); // only 2 invocations — below threshold

    // 45 minutes ago — inside 60-min default window
    db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, created_at)
      VALUES (?, 'past-sess', 'user_prompt', 2, 1, datetime('now', '-45 minutes'))`).run(id);

    const result = isRecentlyRecommended(db, id, 'new-session');
    expect(result).toBe(true); // 45 min < 60 min default cooldown
    db.close();
  });
});

// ─── Consecutive Rejection Silencing ────────────────────────────────────────

describe('consecutive rejection silencing (exponential backoff)', () => {
  it('silences with 1h backoff on first rejection cycle', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    // 8 consecutive rejections
    for (let i = 0; i < 8; i++) {
      recordInvocation(db, {
        resource_id: id, session_id: `sess-${i}`, trigger: 'user_prompt', tier: 2, recommended: 1,
      });
    }

    const result = isRecentlyRecommended(db, id, 'new-session');
    expect(result).toBe(true);

    const row = db.prepare('SELECT silenced_until, cooldown_hours FROM resources WHERE id = ?').get(id);
    expect(row.silenced_until).toBeTruthy();
    expect(row.cooldown_hours).toBe(1); // First backoff = 1 hour
    db.close();
  });

  it('doubles backoff on second rejection cycle', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    // Pre-set cooldown_hours to 1 (first cycle already happened)
    db.prepare('UPDATE resources SET cooldown_hours = 1 WHERE id = ?').run(id);

    for (let i = 0; i < 8; i++) {
      recordInvocation(db, {
        resource_id: id, session_id: `sess-${i}`, trigger: 'user_prompt', tier: 2, recommended: 1,
      });
    }

    isRecentlyRecommended(db, id, 'new-session');
    const row = db.prepare('SELECT cooldown_hours FROM resources WHERE id = ?').get(id);
    expect(row.cooldown_hours).toBe(2); // Doubled: 1 → 2
    db.close();
  });

  it('caps backoff at 256 hours', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    db.prepare('UPDATE resources SET cooldown_hours = 256 WHERE id = ?').run(id);

    for (let i = 0; i < 8; i++) {
      recordInvocation(db, {
        resource_id: id, session_id: `sess-${i}`, trigger: 'user_prompt', tier: 2, recommended: 1,
      });
    }

    isRecentlyRecommended(db, id, 'new-session');
    const row = db.prepare('SELECT cooldown_hours FROM resources WHERE id = ?').get(id);
    expect(row.cooldown_hours).toBe(256); // Capped, not 512
    db.close();
  });

  it('resets backoff after 7+ days without recommendation', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    // Set existing backoff state
    db.prepare('UPDATE resources SET cooldown_hours = 64 WHERE id = ?').run(id);

    // Only 1 old recommendation (>7 days ago)
    db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, created_at)
      VALUES (?, 'old-sess', 'user_prompt', 2, 1, datetime('now', '-10 days'))`).run(id);

    const result = isRecentlyRecommended(db, id, 'new-session');
    // Should have reset backoff (not silenced — only 1 rec, below threshold)
    const row = db.prepare('SELECT cooldown_hours FROM resources WHERE id = ?').get(id);
    expect(row.cooldown_hours).toBe(0); // Reset!
    db.close();
  });

  it('does not silence if one recent recommendation was adopted', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    for (let i = 0; i < 7; i++) {
      db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
        VALUES (?, ?, 'user_prompt', 2, 1, 0, 'ignored', 0, datetime('now', '-2 days'))`).run(id, `sess-${i}`);
    }
    db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
      VALUES (?, 'sess-7', 'user_prompt', 2, 1, 1, 'success', 1.0, datetime('now', '-2 days'))`).run(id);

    const result = isRecentlyRecommended(db, id, null);
    expect(result).toBe(false);
    db.close();
  });

  it('does not silence with fewer than 8 rejections', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
        VALUES (?, ?, 'user_prompt', 2, 1, 0, 'ignored', 0, datetime('now', '-2 days'))`).run(id, `sess-${i}`);
    }

    const result = isRecentlyRecommended(db, id, null);
    expect(result).toBe(false);
    db.close();
  });

  it('respects active silence even without invocation history', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    db.prepare("UPDATE resources SET silenced_until = datetime('now', '+7 days') WHERE id = ?").run(id);

    const result = isRecentlyRecommended(db, id, 'any-session');
    expect(result).toBe(true);
    db.close();
  });

  it('silences without outcome — uses adopted=0 default', () => {
    const db = createRegistryDb();
    const id = seedResource(db);

    for (let i = 0; i < 8; i++) {
      db.prepare(`INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, created_at)
        VALUES (?, ?, 'user_prompt', 2, 1, datetime('now', '-${i} hours'))`).run(id, `sess-${i}`);
    }

    const result = isRecentlyRecommended(db, id, 'new-session');
    expect(result).toBe(true);
    db.close();
  });
});

// ─── filterAutoLoadedSkills ─────────────────────────────────────────────────

describe('filterAutoLoadedSkills', () => {
  it('filters plugin-namespaced skills (auto-loaded via hooks)', () => {
    const results = [
      { name: 'superpowers-tdd', type: 'skill', invocation_name: 'superpowers:test-driven-development' },
      { name: 'superpowers-debugging', type: 'skill', invocation_name: 'superpowers:systematic-debugging' },
      { name: 'frontend-design', type: 'skill', invocation_name: 'frontend-design:frontend-design' },
      { name: 'community-only', type: 'skill', invocation_name: '' },
    ];
    const filtered = _filterAutoLoadedSkills(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('community-only');
  });

  it('keeps standalone installed skills (no plugin namespace)', () => {
    const results = [
      { name: 'claude-code-plugin-dev', type: 'skill', invocation_name: 'claude-code-plugin-dev' },
      { name: 'build-error-resolver', type: 'skill', invocation_name: 'build-error-resolver' },
      { name: 'community-tool', type: 'skill', invocation_name: '' },
      { name: 'another-community', type: 'skill' },
    ];
    const filtered = _filterAutoLoadedSkills(results);
    expect(filtered).toHaveLength(4);
  });

  it('keeps agents regardless of invocation_name', () => {
    const results = [
      { name: 'gsd-executor', type: 'agent', invocation_name: 'gsd:executor' },
      { name: 'code-review-ai/reviewer', type: 'agent', invocation_name: '' },
    ];
    const filtered = _filterAutoLoadedSkills(results);
    expect(filtered).toHaveLength(2);
  });

  it('keeps skills without invocation_name', () => {
    const results = [
      { name: 'standalone-skill', type: 'skill', invocation_name: '' },
      { name: 'another', type: 'skill' },
    ];
    const filtered = _filterAutoLoadedSkills(results);
    expect(filtered).toHaveLength(2);
  });

  it('distinguishes plugin-namespaced from standalone installed', () => {
    const results = [
      { name: 'superpowers-debugging', type: 'skill', invocation_name: 'superpowers:systematic-debugging' },
      { name: 'code-review-expert', type: 'skill', invocation_name: 'code-review-expert' },
      { name: 'community-tool', type: 'skill', invocation_name: '' },
    ];
    const filtered = _filterAutoLoadedSkills(results);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(r => r.name)).toEqual(['code-review-expert', 'community-tool']);
  });
});

// ─── filterGarbageMetadata ──────────────────────────────────────────────────

describe('filterGarbageMetadata', () => {
  it('filters resources where capability_summary restates the name', () => {
    const results = [
      { name: 'error-diagnostics/error-detective', capability_summary: 'agent: error diagnostics/error detective' },
      { name: 'error-debugging/error-detective', capability_summary: 'agent: error debugging/error detective' },
      { name: 'code-review-expert', capability_summary: 'Comprehensive code review with quality metrics and best practices' },
    ];
    const filtered = _filterGarbageMetadata(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('code-review-expert');
  });

  it('filters resources with empty capability_summary', () => {
    const results = [
      { name: 'no-metadata', capability_summary: '' },
      { name: 'has-metadata', capability_summary: 'Real useful description of what this does' },
    ];
    const filtered = _filterGarbageMetadata(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('has-metadata');
  });

  it('keeps resources with genuine descriptions', () => {
    const results = [
      { name: 'mcp-builder', capability_summary: 'Create and configure MCP servers with proper schema, tool registration, and error handling' },
      { name: 'postgres-patterns', capability_summary: 'PostgreSQL query optimization, schema design, indexing strategies, and security best practices' },
    ];
    const filtered = _filterGarbageMetadata(results);
    expect(filtered).toHaveLength(2);
  });
});
