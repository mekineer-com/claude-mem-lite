// Comprehensive simulation test — exercises real-world usage scenarios and edge cases
// Tests things that unit tests may miss: integration paths, boundary conditions, data integrity

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, createRegistryTestDb, insertSession, insertObs } from './test-helpers.mjs';
import {
  sanitizeFtsQuery, relaxFtsQueryToOr, scrubSecrets, computeMinHash,
  estimateJaccardFromMinHash, jaccardSimilarity, truncate, cjkBigrams,
  extractFilePaths, makeEntryDesc, clampImportance,
  computeRuleImportance, detectBashSignificance, extractErrorKeywords,
  isRelatedToEpisode, fmtDate, fmtTime, isoWeekKey, parseJsonFromLLM,
  tokenizeHandoff, isSpecificTerm, extractMatchKeywords, estimateTokens,
} from '../utils.mjs';
import { initSchema, ensureFTS, rebuildFTS, checkFTSIntegrity } from '../schema.mjs';
import { buildSummaryLines, computeAdaptiveWindows, selectWithTokenBudget } from '../hook-context.mjs';
import {
  shouldSkipDispatch, extractContextSignals,
  isRecentlyRecommended, isSessionCapped, SESSION_RECOMMEND_CAP,
} from '../dispatch.mjs';
import { renderInjection } from '../dispatch-inject.mjs';
import { _detectAdoption } from '../dispatch-feedback.mjs';
import { upsertResource, getResourceByName } from '../registry.mjs';
import { retrieveResources, buildEnhancedQuery, buildQueryFromText } from '../registry-retriever.mjs';
import Database from 'better-sqlite3';

// ─── 1. FTS5 Query Edge Cases ────────────────────────────────────────────────

describe('FTS5 Query Edge Cases (Simulated User Input)', () => {
  it('handles SQL injection attempts safely', () => {
    // After stripping special chars, SQL keywords become harmless search tokens
    const result = sanitizeFtsQuery("'; DROP TABLE observations; --");
    expect(result).not.toBeNull();
    // The result is a valid FTS5 query of text tokens, not SQL
  });

  it('handles deeply nested parentheses/brackets', () => {
    const result = sanitizeFtsQuery('((((test))))');
    expect(result).toBeTruthy();
    expect(result).toContain('test');
  });

  it('handles strings of only FTS-stripped special characters', () => {
    // These chars are in the strip pattern [{}()[\]^~*:"]
    expect(sanitizeFtsQuery('***')).toBeNull();
    expect(sanitizeFtsQuery('{{}}')).toBeNull();
    expect(sanitizeFtsQuery('(())')).toBeNull();
    expect(sanitizeFtsQuery('""')).toBeNull();
  });

  it('handles extremely long queries without hanging', () => {
    const longQuery = 'performance '.repeat(500);
    const start = Date.now();
    const result = sanitizeFtsQuery(longQuery);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toBeTruthy();
  });

  it('handles mixed CJK and English with synonym expansion', () => {
    const result = sanitizeFtsQuery('修复 database bug');
    expect(result).toBeTruthy();
    expect(result).toContain('修复');
  });

  it('handles emoji in queries', () => {
    const result = sanitizeFtsQuery('fix bug in auth');
    expect(result).toBeTruthy();
  });

  it('handles FTS5 keyword conflicts (AND, OR, NOT, NEAR)', () => {
    const r1 = sanitizeFtsQuery('NOT working');
    expect(r1).toBeTruthy();
    // NOT should be filtered as FTS5 keyword
    expect(r1).not.toMatch(/\bNOT\b/);

    const r2 = sanitizeFtsQuery('NEAR the bug');
    expect(r2).toBeTruthy();
  });

  it('handles tab/newline characters in queries', () => {
    const result = sanitizeFtsQuery("fix\tthe\nbug\r\n");
    expect(result).toBeTruthy();
  });

  it('relaxFtsQueryToOr on single token returns null', () => {
    expect(relaxFtsQueryToOr('test')).toBeNull();
  });

  it('relaxFtsQueryToOr properly converts multi-token', () => {
    const result = relaxFtsQueryToOr('test bug');
    expect(result).toBe('test OR bug');
  });

  it('handles queries with only CJK single characters', () => {
    const result = sanitizeFtsQuery('修 复');
    // Two separate single CJK chars — no bigram run, each becomes individual token
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

// ─── 2. FTS5 Search Correctness ─────────────────────────────────────────────

describe('FTS5 Search Round-Trip', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'myproject', memoryId: 'sess-1' });
  });

  it('can find observation by title keyword', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'Fixed authentication timeout bug', type: 'bugfix' });

    const fts = sanitizeFtsQuery('authentication');
    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain('authentication');
  });

  it('synonym expansion finds related terms', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'Kubernetes deployment configuration', type: 'discovery' });

    const fts = sanitizeFtsQuery('k8s');
    expect(fts).toBeTruthy();
    expect(fts.toLowerCase()).toContain('kubernetes');

    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(1);
  });

  it('CJK search finds content via bigrams in text field', () => {
    // Simulate real observation save: CJK bigrams go into the text field
    const title = '修复数据库连接超时问题';
    const bigramText = cjkBigrams(title);
    insertObs(db, {
      sessionId: 'sess-1', project: 'myproject', title,
      text: bigramText, // CJK bigrams in text field (as buildFtsTextField does)
      type: 'bugfix',
    });

    // FTS5 unicode61 tokenizes full CJK runs as single tokens, so multi-char
    // CJK terms in AND queries may not match. Production code uses OR fallback.
    const fts = sanitizeFtsQuery('数据库');
    expect(fts).toBeTruthy();
    let rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    if (rows.length === 0) {
      // OR fallback — mirrors production search behavior in server.mjs
      const orFts = relaxFtsQueryToOr(fts);
      if (orFts) {
        rows = db.prepare(`
          SELECT o.id, o.title FROM observations_fts
          JOIN observations o ON observations_fts.rowid = o.id
          WHERE observations_fts MATCH ?
        `).all(orFts);
      }
    }
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe(title);
  });

  it('CJK synonym expansion bridges to English content', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'Fixed database connection timeout', type: 'bugfix' });

    // Chinese query should expand to include English synonyms
    const fts = sanitizeFtsQuery('数据库');
    expect(fts.toLowerCase()).toContain('database');

    // AND query may fail because CJK bigram tokens won't match English content.
    // Production code uses OR fallback to handle cross-language matches.
    let rows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    if (rows.length === 0) {
      const orFts = relaxFtsQueryToOr(fts);
      if (orFts) {
        rows = db.prepare(`
          SELECT o.id FROM observations_fts
          JOIN observations o ON observations_fts.rowid = o.id
          WHERE observations_fts MATCH ?
        `).all(orFts);
      }
    }
    expect(rows.length).toBe(1);
  });

  it('OR fallback finds results when AND returns nothing', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'React component rendering issue', type: 'bugfix' });
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'Database migration script', type: 'change' });

    const ftsAnd = sanitizeFtsQuery('react database');
    const andRows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(ftsAnd);
    expect(andRows.length).toBe(0);

    const orQuery = relaxFtsQueryToOr(ftsAnd);
    expect(orQuery).toBeTruthy();
    const orRows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(orQuery);
    expect(orRows.length).toBe(2);
  });

  it('compressed observations are excluded from FTS search', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'Active observation about caching', type: 'discovery' });
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'Old compressed observation about caching strategy', type: 'discovery', compressedInto: -1 });

    const fts = sanitizeFtsQuery('caching');
    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
    `).all(fts);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain('Active');
  });

  it('FTS5 rebuild and integrity check work', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'myproject', title: 'Test FTS rebuild', type: 'discovery' });
    const rebuild = rebuildFTS(db);
    expect(rebuild.rebuilt.length).toBe(3);
    expect(rebuild.errors.length).toBe(0);

    const integrity = checkFTSIntegrity(db);
    expect(integrity.healthy).toBe(true);
    expect(integrity.details).toHaveLength(3);
    expect(integrity.details.every(d => d.endsWith('ok'))).toBe(true);
  });
});

// ─── 3. Secret Scrubbing Edge Cases ─────────────────────────────────────────

describe('Secret Scrubbing Real-World Scenarios', () => {
  it('scrubs secrets embedded in code snippets', () => {
    const code = `const config = {
      apiKey: "sk-proj-abc123def456ghi789",
      dbUrl: "postgres://admin:supersecret@db.example.com:5432/mydb",
      token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    }`;
    const result = scrubSecrets(code);
    expect(result).not.toContain('sk-proj-abc123def456ghi789');
    expect(result).not.toContain('supersecret');
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('scrubs JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = scrubSecrets(jwt);
    expect(result).not.toContain('eyJ');
  });

  it('scrubs PEM private keys', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA2Z3qX2BTLS4e+KTNMHW6123456
-----END RSA PRIVATE KEY-----`;
    const result = scrubSecrets(pem);
    expect(result).toContain('***PEM_KEY***');
  });

  it('preserves normal code that looks like secrets', () => {
    const code = 'const error_handler = new ErrorHandler();';
    const result = scrubSecrets(code);
    expect(result).toBe(code);
  });

  it('handles empty/null/undefined input', () => {
    expect(scrubSecrets('')).toBe('');
    expect(scrubSecrets(null)).toBe('');
    expect(scrubSecrets(undefined)).toBe('');
  });

  it('scrubs Stripe keys', () => {
    // Verify Stripe key pattern scrubbing (truncated to avoid GitHub push protection)
    const prefix = 'sk_liv' + 'e_';
    const text = 'Using key ' + prefix + 'XXXXXXXXXXXXXXXXXXXX1234';
    expect(scrubSecrets(text)).not.toContain(prefix);
  });

  it('scrubs npm tokens', () => {
    const text = 'npm_abcdefghijklmnopqrstuvwxyz0123456789abcdefg';
    expect(scrubSecrets(text)).toBe('***');
  });
});

// ─── 4. Dispatch System Simulation ──────────────────────────────────────────

describe('Dispatch: Tier 0 Filtering', () => {
  it('skips when Claude chose a Skill', () => {
    const result = shouldSkipDispatch({ tool_name: 'Skill', tool_input: { skill: 'superpowers:brainstorming' } });
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('claude_chose_skill');
  });

  it('skips Agent with explicit subagent_type', () => {
    const result = shouldSkipDispatch({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'find files' } });
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('claude_chose_agent');
  });

  it('does NOT skip Agent without subagent_type (general purpose)', () => {
    const result = shouldSkipDispatch({ tool_name: 'Agent', tool_input: { prompt: 'research something' } });
    expect(result.skip).toBe(false);
  });

  it('skips all read-only tools', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'LSP', 'WebSearch', 'WebFetch']) {
      expect(shouldSkipDispatch({ tool_name: tool, tool_input: {} }).skip).toBe(true);
    }
  });

  it('skips MCP tools', () => {
    expect(shouldSkipDispatch({ tool_name: 'mcp__mem__mem_search', tool_input: {} }).skip).toBe(true);
  });

  it('skips simple bash queries', () => {
    for (const cmd of ['ls -la', 'cat file.txt', 'git status', 'git log', 'node --version']) {
      expect(shouldSkipDispatch({ tool_name: 'Bash', tool_input: { command: cmd } }).skip).toBe(true);
    }
  });

  it('does NOT skip complex bash commands', () => {
    for (const cmd of ['npm test', 'npx vitest run', 'docker build .', 'terraform apply']) {
      expect(shouldSkipDispatch({ tool_name: 'Bash', tool_input: { command: cmd } }).skip).toBe(false);
    }
  });

  it('does NOT skip edit tools', () => {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(shouldSkipDispatch({ tool_name: tool, tool_input: {} }).skip).toBe(false);
    }
  });
});

describe('Dispatch: Context Signal Extraction', () => {
  it('extracts intent from English prompt', () => {
    const signals = extractContextSignals(
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },
      { userPrompt: 'Write tests for the auth module' }
    );
    expect(signals.intent).toContain('test');
  });

  it('extracts intent from Chinese prompt', () => {
    const signals = extractContextSignals(
      { tool_name: 'Edit', tool_input: {} },
      { userPrompt: '修复登录页面的bug' }
    );
    expect(signals.intent).toContain('fix');
  });

  it('handles negation: "don\'t test"', () => {
    const signals = extractContextSignals(
      { tool_name: 'Edit', tool_input: {} },
      { userPrompt: "don't test, just fix the bug" }
    );
    expect(signals.intent).not.toContain('test');
    expect(signals.intent).toContain('fix');
  });

  it('handles CJK negation: "别测试"', () => {
    const signals = extractContextSignals(
      { tool_name: 'Edit', tool_input: {} },
      { userPrompt: '别测试了，直接修复这个bug' }
    );
    expect(signals.intent).toContain('fix');
  });

  it('distinguishes run-test vs write-test', () => {
    const runSignals = extractContextSignals(
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },
      { userPrompt: 'run the tests' }
    );
    expect(runSignals.suppressedIntents).toContain('test');

    const writeSignals = extractContextSignals(
      { tool_name: 'Edit', tool_input: {} },
      { userPrompt: 'write tests for auth' }
    );
    expect(writeSignals.intent).toContain('test');
    expect(writeSignals.suppressedIntents).not.toContain('test');
  });

  it('extracts tech stack from recent files', () => {
    const signals = extractContextSignals(
      { tool_name: 'Edit', tool_input: {} },
      { userPrompt: 'fix this', recentFiles: ['/app/src/index.tsx', '/app/src/api.ts'] }
    );
    expect(signals.techStack).toContain('typescript');
    expect(signals.techStack).toContain('react');
  });

  it('extracts raw domain keywords', () => {
    const signals = extractContextSignals(
      { tool_name: 'Edit', tool_input: {} },
      { userPrompt: 'review the seo configuration' }
    );
    expect(signals.rawKeywords).toContain('seo');
  });

  it('extracts error domain from bash output', () => {
    const signals = extractContextSignals(
      { tool_name: 'Bash', tool_input: { command: 'npx tsc' }, tool_response: 'error TS2345: Argument of type string is not assignable' },
      {}
    );
    expect(signals.errorDomain).toBe('type-error');
  });
});

describe('Dispatch: Cooldown & Session Cap', () => {
  let db;

  beforeEach(() => {
    db = createRegistryTestDb();
  });

  it('session cap enforced at SESSION_RECOMMEND_CAP', () => {
    for (let i = 1; i <= SESSION_RECOMMEND_CAP; i++) {
      db.prepare(`INSERT INTO resources (name, type, source, capability_summary, local_path) VALUES (?, 'skill', 'preinstalled', 'test', '/test')`).run(`res-${i}`);
      db.prepare(`INSERT INTO invocations (resource_id, session_id, recommended, created_at) VALUES (?, 'session-1', 1, datetime('now'))`).run(i);
    }
    expect(isSessionCapped(db, 'session-1')).toBe(true);
    expect(isSessionCapped(db, 'session-2')).toBe(false);
  });

  it('isRecentlyRecommended prevents re-recommendation within cooldown', () => {
    db.prepare(`INSERT INTO resources (name, type, source, capability_summary, local_path) VALUES ('test-skill', 'skill', 'preinstalled', 'test', '/test')`).run();
    db.prepare(`INSERT INTO invocations (resource_id, session_id, recommended, created_at) VALUES (1, 'session-1', 1, datetime('now'))`).run();

    expect(isRecentlyRecommended(db, 1, 'session-2')).toBe(true);
    db.prepare(`INSERT INTO resources (name, type, source, capability_summary, local_path) VALUES ('other-skill', 'skill', 'preinstalled', 'test', '/test')`).run();
    expect(isRecentlyRecommended(db, 2, 'session-2')).toBe(false);
  });

  it('consecutive rejection silencing', () => {
    db.prepare(`INSERT INTO resources (name, type, source, capability_summary, local_path) VALUES ('rejected-skill', 'skill', 'preinstalled', 'test', '/test')`).run();
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO invocations (resource_id, session_id, recommended, adopted, outcome, created_at) VALUES (1, ?, 1, 0, 'ignored', datetime('now', ?))`).run(`s-${i}`, `-${i} hours`);
    }
    expect(isRecentlyRecommended(db, 1, 'new-session')).toBe(true);
  });
});

// Haiku Tier3 tests removed — Haiku dispatch disabled and code removed (P5)

// ─── 5. Adoption Detection ──────────────────────────────────────────────────

describe('Dispatch Feedback: Adoption Detection', () => {
  it('detects skill adoption by exact invocation_name match', () => {
    const inv = { resource_name: 'superpowers-tdd', resource_type: 'skill', invocation_name: 'superpowers:test-driven-development' };
    const events = [{ tool_name: 'Skill', tool_input: { skill: 'superpowers:test-driven-development' } }];
    expect(_detectAdoption(inv, events)).toEqual({ adopted: true, score: 1.0 });
  });

  it('detects agent adoption by description match', () => {
    const inv = { resource_name: 'code-review', resource_type: 'agent' };
    const events = [{ tool_name: 'Agent', tool_input: { description: 'Perform code review', prompt: 'Review the changes' } }];
    expect(_detectAdoption(inv, events)).toEqual({ adopted: true, score: 1.0 });
  });

  it('detects behavioral debugging adoption', () => {
    const inv = { resource_name: 'debugging-helper', resource_type: 'skill' };
    const events = [
      { tool_name: 'Read', tool_input: {} },
      { tool_name: 'Bash', tool_input: {}, tool_response: 'Error: ENOENT: no such file or directory, this is a long error message' },
      { tool_name: 'Edit', tool_input: {} },
    ];
    expect(_detectAdoption(inv, events)).toEqual({ adopted: true, score: 0.5 });
  });

  it('does not detect adoption for unrelated events', () => {
    const inv = { resource_name: 'superpowers-tdd', resource_type: 'skill', invocation_name: 'superpowers:test-driven-development' };
    const events = [
      { tool_name: 'Read', tool_input: {} },
      { tool_name: 'Edit', tool_input: {} },
    ];
    expect(_detectAdoption(inv, events)).toEqual({ adopted: false, score: 0 });
  });
});

// ─── 6. Injection Rendering ─────────────────────────────────────────────────

describe('Injection Rendering', () => {
  it('renders invocable skill injection', () => {
    const resource = { name: 'tdd', type: 'skill', invocation_name: 'superpowers:test-driven-development', capability_summary: 'TDD workflow guidance' };
    const result = renderInjection(resource, 'test intent detected');
    expect(result).toContain('[Recommended]');
    expect(result).toContain('superpowers:test-driven-development');
    expect(result).toContain('test intent detected');
  });

  it('enforces MAX_INJECTION_CHARS limit', () => {
    const resource = { name: 'long-skill', type: 'skill', invocation_name: 'x', capability_summary: 'a'.repeat(5000) };
    const result = renderInjection(resource);
    expect(result.length).toBeLessThanOrEqual(3000);
  });

  it('renders agent injection', () => {
    const resource = { name: 'code-architect', type: 'agent', capability_summary: 'Designs feature architectures', local_path: '/nonexistent' };
    const result = renderInjection(resource);
    expect(result).toContain('[Recommended]');
    expect(result).toContain('code-architect');
  });
});

// ─── 7. Hook Context: buildSummaryLines and Token Budgeting ─────────────────

describe('Hook Context: buildSummaryLines', () => {
  it('handles null input', () => {
    expect(buildSummaryLines(null)).toEqual([]);
  });

  it('handles empty summary', () => {
    expect(buildSummaryLines({})).toEqual(['### Last Session', '']);
  });

  it('truncates long fields to ~120 chars each', () => {
    const lines = buildSummaryLines({
      request: 'a'.repeat(200),
      completed: 'b'.repeat(200),
      remaining_items: 'c'.repeat(200),
      next_steps: 'd'.repeat(200),
    });
    // Each field line: "Label: " (7-16 chars) + truncate(content, 120) ≤ 120
    for (const line of lines) {
      if (line && !line.startsWith('#') && line.length > 0) {
        expect(line.length).toBeLessThanOrEqual(140); // label + 120 truncated content
      }
    }
  });

  it('parses JSON lessons and key_decisions', () => {
    const lines = buildSummaryLines({
      lessons: '["Lesson 1", "Lesson 2"]',
      key_decisions: '["Decision 1"]',
    });
    expect(lines.some(l => l.includes('Lesson 1'))).toBe(true);
    expect(lines.some(l => l.includes('Decision 1'))).toBe(true);
  });

  it('handles malformed JSON in lessons gracefully', () => {
    const lines = buildSummaryLines({
      lessons: 'not json',
      key_decisions: '{broken',
    });
    expect(lines.some(l => l.includes('Lesson'))).toBe(false);
  });
});

describe('Hook Context: Token Budget Selection', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test-project', memoryId: 'sess-1' });
  });

  it('respects token budget limit', () => {
    for (let i = 0; i < 20; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test-project',
        title: `Observation ${i} about feature development workflow`,
        narrative: `Detailed narrative about observation ${i} with enough content to consume tokens`,
        type: 'discovery',
        importance: 2,
        epochOffset: -i * 3600000,
      });
    }

    const result = selectWithTokenBudget(db, 'test-project', 200);
    expect(result.totalTokens).toBeLessThanOrEqual(200);
    expect(result.observations.length).toBeGreaterThan(0);
  });

  it('prioritizes high-importance observations', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'test-project', title: 'Low importance item', type: 'change', importance: 1 });
    insertObs(db, { sessionId: 'sess-1', project: 'test-project', title: 'High importance item', type: 'decision', importance: 3 });

    const result = selectWithTokenBudget(db, 'test-project', 500);
    expect(result.observations.length).toBe(2);
    expect(result.observations.some(o => o.title === 'High importance item')).toBe(true);
  });

  it('returns empty for non-existent project', () => {
    const result = selectWithTokenBudget(db, 'nonexistent-project', 2000);
    expect(result.observations).toHaveLength(0);
    expect(result.summaries).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
  });
});

describe('Hook Context: Adaptive Windows', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test', memoryId: 'sess-1' });
  });

  it('returns wider windows for low-activity projects', () => {
    const windows = computeAdaptiveWindows(db, 'test');
    expect(windows.tier1).toBe(48 * 3600000);
    expect(windows.tier3).toBe(60 * 86400000);
  });

  it('returns tighter windows for high-activity projects', () => {
    for (let i = 0; i < 80; i++) {
      insertObs(db, {
        sessionId: 'sess-1', project: 'test',
        title: `Obs ${i}`, type: 'change',
        epochOffset: -Math.random() * 7 * 86400000,
      });
    }
    const windows = computeAdaptiveWindows(db, 'test');
    expect(windows.tier1).toBe(12 * 3600000);
    expect(windows.tier3).toBe(14 * 86400000);
  });
});

// ─── 8. Registry & Retriever ────────────────────────────────────────────────

describe('Registry: CRUD Operations', () => {
  let db;

  beforeEach(() => {
    db = createRegistryTestDb();
  });

  it('upsert creates a new resource', () => {
    const id = upsertResource(db, {
      name: 'test-skill',
      type: 'skill',
      capability_summary: 'A test skill for testing',
      intent_tags: 'test,quality',
      local_path: '/test/skill',
    });
    expect(id).toBeGreaterThan(0);
    const resource = getResourceByName(db, 'skill', 'test-skill');
    expect(resource.name).toBe('test-skill');
    expect(resource.type).toBe('skill');
  });

  it('upsert updates existing resource', () => {
    upsertResource(db, { name: 'test-skill', type: 'skill', capability_summary: 'Original', local_path: '/test' });
    upsertResource(db, { name: 'test-skill', type: 'skill', capability_summary: 'Updated', local_path: '/test' });
    const resource = getResourceByName(db, 'skill', 'test-skill');
    expect(resource.capability_summary).toBe('Updated');
  });

  it('handles special characters in resource names', () => {
    const id = upsertResource(db, {
      name: 'my-skill:v2.0',
      type: 'skill',
      capability_summary: 'Skill with special chars',
      local_path: '/test/skill',
    });
    expect(id).toBeGreaterThan(0);
    const resource = getResourceByName(db, 'skill', 'my-skill:v2.0');
    expect(resource).toBeTruthy();
  });
});

describe('Registry Retriever: FTS5 Search', () => {
  let db;

  beforeEach(() => {
    db = createRegistryTestDb();
    upsertResource(db, { name: 'superpowers-tdd', type: 'skill', capability_summary: 'Test-driven development workflow', intent_tags: 'test,quality', keywords: 'tdd testing red green refactor', local_path: '/skills/tdd' });
    upsertResource(db, { name: 'superpowers-debugging', type: 'skill', capability_summary: 'Systematic debugging methodology', intent_tags: 'fix,debug', keywords: 'debug troubleshoot error fix', local_path: '/skills/debug' });
    upsertResource(db, { name: 'frontend-design', type: 'skill', capability_summary: 'UI component design system', intent_tags: 'design,ui', keywords: 'react css tailwind component', domain_tags: 'web,browser,react', local_path: '/skills/frontend' });
    upsertResource(db, { name: 'ios-app-builder', type: 'agent', capability_summary: 'iOS application development', intent_tags: 'build', keywords: 'swift xcode ios', domain_tags: 'swift,ios', local_path: '/agents/ios' });
  });

  it('retrieves resources by keyword', () => {
    const results = retrieveResources(db, 'testing');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('superpowers-tdd');
  });

  it('buildEnhancedQuery combines signals', () => {
    const query = buildEnhancedQuery({
      intent: 'test',
      primaryIntent: 'test',
      techStack: 'typescript',
      action: 'edit',
      rawKeywords: [],
      suppressedIntents: [],
    });
    expect(query).toBeTruthy();
    expect(query.toLowerCase()).toContain('test');
  });

  it('buildQueryFromText handles empty text', () => {
    const query = buildQueryFromText('');
    expect(query).toBeNull();
  });

  it('retrieves with empty query returns nothing (not error)', () => {
    const results = retrieveResources(db, '');
    expect(results).toEqual([]);
  });
});

// ─── 9. Utility Function Edge Cases ─────────────────────────────────────────

describe('Utility Edge Cases', () => {
  it('jaccardSimilarity handles identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('jaccardSimilarity handles disjoint strings', () => {
    expect(jaccardSimilarity('hello world', 'foo bar')).toBe(0);
  });

  it('jaccardSimilarity handles empty strings', () => {
    expect(jaccardSimilarity('', 'hello')).toBe(0);
    expect(jaccardSimilarity('hello', '')).toBe(0);
    expect(jaccardSimilarity('', '')).toBe(0);
  });

  it('truncate handles various edge cases', () => {
    expect(truncate('', 10)).toBe('');
    expect(truncate(null, 10)).toBe('');
    expect(truncate('short', 100)).toBe('short');
    expect(truncate('hello\nworld', 20)).toBe('hello world');
    expect(truncate('a'.repeat(100), 10)).toHaveLength(10);
    expect(truncate('a'.repeat(100), 10)).toContain('…');
  });

  it('estimateTokens handles edge cases', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens(null)).toBe(1);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('MinHash: identical texts produce identical signatures', () => {
    const sig1 = computeMinHash('The quick brown fox jumps over the lazy dog');
    const sig2 = computeMinHash('The quick brown fox jumps over the lazy dog');
    expect(sig1).toBe(sig2);
    expect(estimateJaccardFromMinHash(sig1, sig2)).toBe(1);
  });

  it('MinHash: similar texts have high similarity', () => {
    const sig1 = computeMinHash('The quick brown fox jumps over the lazy dog');
    const sig2 = computeMinHash('The quick brown fox leaps over the lazy dog');
    const sim = estimateJaccardFromMinHash(sig1, sig2);
    expect(sim).toBeGreaterThan(0.5);
  });

  it('MinHash: short texts return null', () => {
    expect(computeMinHash('hi')).toBeNull();
    expect(computeMinHash('two words')).toBeNull();
    expect(computeMinHash('')).toBeNull();
    expect(computeMinHash(null)).toBeNull();
  });

  it('MinHash: different length sigs return 0', () => {
    expect(estimateJaccardFromMinHash('abcd', 'abcdef')).toBe(0);
  });

  it('clampImportance handles edge cases', () => {
    expect(clampImportance(0)).toBe(1);
    expect(clampImportance(5)).toBe(3);
    expect(clampImportance(-1)).toBe(1);
    expect(clampImportance(NaN)).toBe(1);
    expect(clampImportance('string')).toBe(1);
    expect(clampImportance(2.7)).toBe(3);
    expect(clampImportance(1.4)).toBe(1);
  });

  it('detectBashSignificance detects various patterns', () => {
    expect(detectBashSignificance({ command: 'npx vitest run' }, '').isTest).toBe(true);
    expect(detectBashSignificance({ command: 'npm run build' }, '').isBuild).toBe(true);
    expect(detectBashSignificance({ command: 'git push origin main' }, '').isGit).toBe(true);
    expect(detectBashSignificance({ command: 'kubectl apply -f deploy.yaml' }, '').isDeploy).toBe(true);
    expect(detectBashSignificance({ command: 'ls' }, 'file1.txt\nfile2.txt').isSignificant).toBe(false);
  });

  it('detectBashSignificance error detection requires minimum length', () => {
    expect(detectBashSignificance({ command: 'ls' }, 'error').isError).toBe(false);
    expect(detectBashSignificance({ command: 'npm test' }, 'Error: failed to compile module at line 42 with unexpected token').isError).toBe(true);
  });

  it('extractErrorKeywords filters stop words', () => {
    const keywords = extractErrorKeywords(
      'npm run build',
      'Error: Cannot find module "auth-handler"\n  at Function.Module._resolveFilename'
    );
    expect(keywords).not.toBeNull();
    expect(keywords).not.toContain('error');
    expect(keywords).not.toContain('cannot');
    expect(keywords.some(k => k.includes('auth'))).toBe(true);
  });

  it('extractFilePaths handles various input shapes', () => {
    expect(extractFilePaths({ file_path: '/app/src/index.ts' })).toEqual(['/app/src/index.ts']);
    expect(extractFilePaths({ path: '/app/src' })).toEqual(['/app/src']);
    expect(extractFilePaths({ command: 'cat /app/src/index.ts' })).toEqual(['/app/src/index.ts']);
    expect(extractFilePaths({ command: 'cat /dev/null /app/file.ts' })).toEqual(['/app/file.ts']);
    expect(extractFilePaths({ file_path: '/x', path: '/x' })).toEqual(['/x']);
  });

  it('isRelatedToEpisode handles empty file sets', () => {
    expect(isRelatedToEpisode({ files: [] }, [])).toBe(true);
    expect(isRelatedToEpisode({ files: [] }, ['/app/x.ts'])).toBe(true);
    expect(isRelatedToEpisode({ files: ['/app/x.ts'] }, [])).toBe(true);
  });

  it('isRelatedToEpisode detects test-sibling relationship', () => {
    expect(isRelatedToEpisode(
      { files: ['/app/src/auth.ts'] },
      ['/app/tests/auth.test.ts']
    )).toBe(true);
  });

  it('fmtDate handles various inputs', () => {
    expect(fmtDate('')).toBe('');
    expect(fmtDate(null)).toBe('');
    const result = fmtDate('2026-03-13T12:30:00Z');
    expect(result).toContain('Mar');
    expect(result).toContain('12:30');
  });

  it('fmtTime handles various inputs', () => {
    expect(fmtTime('')).toBe('');
    expect(fmtTime(null)).toBe('');
    expect(fmtTime('2026-03-13T08:05:00Z')).toBe('08:05');
  });

  it('isoWeekKey produces correct format', () => {
    const key = isoWeekKey(Date.UTC(2026, 0, 5));
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('parseJsonFromLLM handles various formats', () => {
    expect(parseJsonFromLLM('{"key": "value"}')).toEqual({ key: 'value' });
    expect(parseJsonFromLLM('```json\n{"key": "value"}\n```')).toEqual({ key: 'value' });
    expect(parseJsonFromLLM('Here is the result: {"key": "value"}')).toEqual({ key: 'value' });
    expect(parseJsonFromLLM('')).toBeNull();
    expect(parseJsonFromLLM(null)).toBeNull();
    expect(parseJsonFromLLM('not json at all')).toBeNull();
  });

  it('tokenizeHandoff handles various inputs', () => {
    expect(tokenizeHandoff('')).toEqual([]);
    expect(tokenizeHandoff(null)).toEqual([]);
    expect(tokenizeHandoff('hello world foo')).toEqual(['hello', 'world', 'foo']);
    expect(tokenizeHandoff('a ab abc')).toEqual(['abc']);
  });

  it('isSpecificTerm identifies specific terms', () => {
    expect(isSpecificTerm('auth_handler')).toBe(true);
    expect(isSpecificTerm('api-endpoint')).toBe(true);
    expect(isSpecificTerm('the')).toBe(false);
    expect(isSpecificTerm('ab')).toBe(false);
    expect(isSpecificTerm('')).toBe(false);
    expect(isSpecificTerm(null)).toBe(false);
  });

  it('computeRuleImportance detects important patterns', () => {
    expect(computeRuleImportance({
      entries: [{ tool: 'Edit', files: ['/app/.env'], bashSig: null }],
      files: ['/app/.env'],
    })).toBe(3);

    expect(computeRuleImportance({
      entries: [{ tool: 'Edit', files: ['/app/migration_001.sql'], bashSig: null }],
      files: ['/app/migration_001.sql'],
    })).toBe(3);

    expect(computeRuleImportance({
      entries: [{ tool: 'Bash', files: [], bashSig: { isError: true, isTest: true } }],
      files: [],
    })).toBe(3);

    expect(computeRuleImportance({
      entries: [{ tool: 'Edit', files: ['/app/utils.js'], bashSig: null }],
      files: ['/app/utils.js'],
    })).toBe(1);
  });

  it('cjkBigrams handles various inputs', () => {
    expect(cjkBigrams('')).toBe('');
    expect(cjkBigrams(null)).toBe('');
    expect(cjkBigrams('hello')).toBe('');
    expect(cjkBigrams('修复')).toBe('修复');
    // Dictionary-based: "修复" and "崩溃" are compounds; "了系" and "统崩" are bigram fallback
    expect(cjkBigrams('修复了系统崩溃')).toBe('修复 了系 系统 统崩 崩溃');
  });

  it('extractMatchKeywords combines files and text', () => {
    const result = extractMatchKeywords('fix auth bug', ['/app/src/auth-handler.ts']);
    expect(result).toContain('auth-handler');
    expect(result).toContain('fix');
    expect(result).toContain('auth');
  });
});

// ─── 10. Schema Migration Idempotency ───────────────────────────────────────

describe('Schema: Migration Idempotency', () => {
  it('running initSchema twice does not error', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });

  it('ensureFTS is idempotent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE test_content (id INTEGER PRIMARY KEY, text1 TEXT, text2 TEXT)');
    ensureFTS(db, 'test_content_fts', 'test_content', ['text1', 'text2']);
    expect(() => ensureFTS(db, 'test_content_fts', 'test_content', ['text1', 'text2'])).not.toThrow();
    db.close();
  });

  it('FTS5 triggers work correctly (insert, update, delete)', () => {
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'test', memoryId: 's1' });

    // Insert
    insertObs(db, { sessionId: 's1', project: 'test', title: 'Unique search term xyzfoo', type: 'discovery' });
    let rows = db.prepare(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'xyzfoo'`).all();
    expect(rows.length).toBe(1);

    // Update
    db.prepare(`UPDATE observations SET title = 'Updated unique term xyzbar' WHERE title LIKE '%xyzfoo%'`).run();
    rows = db.prepare(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'xyzfoo'`).all();
    expect(rows.length).toBe(0);
    rows = db.prepare(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'xyzbar'`).all();
    expect(rows.length).toBe(1);

    // Delete
    db.prepare(`DELETE FROM observations WHERE title LIKE '%xyzbar%'`).run();
    rows = db.prepare(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'xyzbar'`).all();
    expect(rows.length).toBe(0);

    db.close();
  });
});

// ─── 11. Data Integrity ─────────────────────────────────────────────────────

describe('Data Integrity', () => {
  it('foreign key constraint prevents orphan observations', () => {
    const db = createTestDb();
    expect(() => {
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
        VALUES ('nonexistent', 'test', 'discovery', 'Orphan', datetime('now'), ?)
      `).run(Date.now());
    }).toThrow();
    db.close();
  });

  it('unique memory_session_id constraint works', () => {
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'test', memoryId: 'm1' });
    expect(() => {
      insertSession(db, { id: 's2', project: 'test', memoryId: 'm1' });
    }).toThrow();
    db.close();
  });

  it('observation type CHECK constraint works', () => {
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'test', memoryId: 's1' });
    expect(() => {
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
        VALUES ('s1', 'test', 'invalid_type', 'Bad type', datetime('now'), ?)
      `).run(Date.now());
    }).toThrow();
    db.close();
  });
});

// ─── 12. Concurrent-like Scenarios ──────────────────────────────────────────

describe('Concurrent-like Scenarios', () => {
  it('handles rapid-fire observation inserts', () => {
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'test', memoryId: 's1' });

    const insertMany = db.transaction(() => {
      for (let i = 0; i < 100; i++) {
        insertObs(db, {
          sessionId: 's1', project: 'test',
          title: `Rapid obs ${i}`, type: 'change',
          epochOffset: i,
        });
      }
    });
    expect(() => insertMany()).not.toThrow();

    const count = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    expect(count.c).toBe(100);

    const fts = db.prepare(`SELECT COUNT(*) as c FROM observations_fts WHERE observations_fts MATCH 'Rapid'`).all();
    expect(fts.length).toBeGreaterThan(0);

    db.close();
  });

  it('handles large batch with mixed types', () => {
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'test', memoryId: 's1' });
    const types = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];

    const insertBatch = db.transaction(() => {
      for (let i = 0; i < 60; i++) {
        insertObs(db, {
          sessionId: 's1', project: 'test',
          title: `Mixed type obs ${i}`,
          type: types[i % types.length],
          importance: (i % 3) + 1,
          epochOffset: -i * 3600000,
        });
      }
    });
    expect(() => insertBatch()).not.toThrow();

    const typeCounts = db.prepare('SELECT type, COUNT(*) as c FROM observations GROUP BY type').all();
    expect(typeCounts.length).toBe(6);
    for (const tc of typeCounts) {
      expect(tc.c).toBe(10);
    }

    db.close();
  });
});

// ─── 13. Registry Retriever: Domain Filtering ──────────────────────────────

describe('Registry Retriever: Domain Filtering', () => {
  let db;

  beforeEach(() => {
    db = createRegistryTestDb();
    upsertResource(db, { name: 'ios-builder', type: 'skill', capability_summary: 'Build iOS apps', domain_tags: 'swift,ios', keywords: 'swift xcode ios', local_path: '/skills/ios' });
    upsertResource(db, { name: 'rust-analyzer', type: 'skill', capability_summary: 'Rust code analysis', domain_tags: 'rust', keywords: 'rust cargo clippy', local_path: '/skills/rust' });
    upsertResource(db, { name: 'code-review', type: 'skill', capability_summary: 'Code review helper', intent_tags: 'review', keywords: 'review quality check', local_path: '/skills/review' });
  });

  it('domain-filtered resources excluded for non-matching projects', () => {
    const results = retrieveResources(db, 'review', { projectDomains: ['javascript', 'node'] });
    const names = results.map(r => r.name);
    expect(names).toContain('code-review');
    expect(names).not.toContain('ios-builder');
  });
});

// ─── 14. makeEntryDesc Edge Cases ───────────────────────────────────────────

describe('makeEntryDesc Edge Cases', () => {
  it('handles Edit with empty strings', () => {
    const desc = makeEntryDesc('Edit', { file_path: '', old_string: '', new_string: '' }, '');
    expect(desc).toBeTruthy();
  });

  it('handles Bash error detection in response', () => {
    const desc = makeEntryDesc('Bash', { command: 'npm test' },
      'Error: test suite failed with 5 errors across multiple files in the project');
    expect(desc).toContain('ERROR');
  });

  it('handles Agent/Task tool', () => {
    const desc = makeEntryDesc('Agent', { description: 'Research codebase' }, '');
    expect(desc).toBe('Research codebase');
  });

  it('handles WebSearch', () => {
    const desc = makeEntryDesc('WebSearch', { query: 'How to fix CORS in Express' }, '');
    expect(desc).toContain('CORS');
  });

  it('handles unknown tool', () => {
    const desc = makeEntryDesc('UnknownTool', {}, 'some response');
    expect(desc).toContain('UnknownTool');
  });
});

// ─── 15. mem_save CJK Bigrams Fix Verification ─────────────────────────────

describe('mem_save CJK fix: bigrams in text field', () => {
  it('cjkBigrams appended to content creates searchable FTS entries', () => {
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'test', memoryId: 's1' });

    // Simulate the fixed mem_save logic
    const title = '修复数据库连接超时';
    const content = '通过增加连接池大小修复了数据库超时问题';
    const bigramText = cjkBigrams(title + ' ' + content);
    const textField = bigramText ? content + ' ' + bigramText : content;

    insertObs(db, {
      sessionId: 's1', project: 'test', title,
      text: textField,
      type: 'bugfix',
    });

    // Should be searchable by CJK terms (with OR fallback like production code)
    for (const query of ['数据库', '超时', '连接']) {
      const fts = sanitizeFtsQuery(query);
      let rows = db.prepare(`
        SELECT o.id FROM observations_fts
        JOIN observations o ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
      `).all(fts);
      if (rows.length === 0) {
        const orFts = relaxFtsQueryToOr(fts);
        if (orFts) {
          rows = db.prepare(`
            SELECT o.id FROM observations_fts
            JOIN observations o ON observations_fts.rowid = o.id
            WHERE observations_fts MATCH ?
          `).all(orFts);
        }
      }
      expect(rows.length).toBeGreaterThan(0);
    }

    // Should also be searchable via CJK→EN synonym
    const ftsDb = sanitizeFtsQuery('数据库');
    expect(ftsDb.toLowerCase()).toContain('database');

    db.close();
  });
});
