import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION, initSchema } from '../schema.mjs';
import {
  computeSearchTelemetry, formatSearchTelemetryReport, rateSearchResults, recordSearch,
} from '../lib/search-telemetry.mjs';
import { handleSearchFeedbackForTest, handleSearchForTest } from '../server.mjs';

const openDb = (path = ':memory:') => {
  const db = new Database(path);
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
};

function seedObservation(db, { project = 'telemetry-test', title = 'Alpha telemetry lesson' } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch)
    VALUES ('content-1', 'memory-1', ?, ?, ?)
  `).run(project, new Date(now).toISOString(), now);
  return Number(db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, text, type, title, created_at, created_at_epoch, importance)
    VALUES ('memory-1', ?, ?, 'decision', ?, ?, ?, 3)
  `).run(project, title, title, new Date(now).toISOString(), now).lastInsertRowid);
}

describe('search telemetry v45', () => {
  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates both tables, self-heals a missing table, and cascades run deletion', () => {
    const db = openDb();
    expect(CURRENT_SCHEMA_VERSION).toBe(45);
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(45);
    const id = recordSearch(db, {
      project: 'p', query: 'alpha', surface: 'mcp_search', client: 'test',
      results: [{ source: 'obs', id: 1, title: 'Alpha' }],
    });
    db.prepare('DELETE FROM search_runs WHERE search_id = ?').run(id);
    expect(db.prepare('SELECT COUNT(*) c FROM search_results').get().c).toBe(0);

    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE search_results');
    initSchema(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'search_results'").get().name).toBe('search_results');
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(45);
    db.close();
  });

  it('upgrades a v44-shaped database and reopens idempotently', () => {
    const db = openDb();
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE search_results; DROP TABLE search_runs; UPDATE schema_version SET version = 44;');
    initSchema(db);
    initSchema(db);
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(45);
    expect(db.prepare("SELECT COUNT(*) c FROM pragma_table_info('search_results') WHERE name = 'relevance'").get().c).toBe(1);
    db.close();
  });

  it('records snapshots and sparse relevance, then replaces only resubmitted ratings', () => {
    const db = openDb();
    const searchId = recordSearch(db, {
      project: 'p', query: 'alpha', surface: 'mcp_search', searchMode: 'normal',
      corpusCounts: { obs: 10 }, matchedCount: 2, client: 'codex/1', now: 1000,
      results: [
        { source: 'obs', id: 7, title: 'Alpha' },
        { source: 'session', id: 8, request: 'Beta' },
        { source: 'prompt', id: 9, prompt_text: 'Gamma' },
        { source: 'event', id: 10, title: 'Delta' },
      ],
    });
    expect(rateSearchResults(db, {
      searchId, relevant: ['#7', 'P#9'], partiallyRelevant: ['S#8', 'E#10'], ratedBy: 'codex/1', now: 2000,
    })).toBe(4);
    rateSearchResults(db, { searchId, irrelevant: ['#7'], ratedBy: 'codex/1', now: 3000 });
    expect(db.prepare('SELECT result_id, snapshot_label, relevance, rated_by FROM search_results ORDER BY returned_rank').all()).toEqual([
      { result_id: 7, snapshot_label: 'Alpha', relevance: 'irrelevant', rated_by: 'codex/1' },
      { result_id: 8, snapshot_label: 'Beta', relevance: 'partial', rated_by: 'codex/1' },
      { result_id: 9, snapshot_label: 'Gamma', relevance: 'relevant', rated_by: 'codex/1' },
      { result_id: 10, snapshot_label: 'Delta', relevance: 'partial', rated_by: 'codex/1' },
    ]);
    db.close();
  });

  it('rejects malformed, duplicate, and foreign result IDs without partial updates', () => {
    const db = openDb();
    const searchId = recordSearch(db, {
      query: 'alpha', surface: 'mcp_search', client: 'test',
      results: [{ source: 'obs', id: 7, title: 'Alpha' }],
    });
    expect(() => rateSearchResults(db, { searchId, relevant: ['7'], ratedBy: 'test' })).toThrow(/Invalid result ID/);
    expect(() => rateSearchResults(db, { searchId, relevant: ['#7'], irrelevant: ['#7'], ratedBy: 'test' })).toThrow(/more than once/);
    expect(() => rateSearchResults(db, { searchId, relevant: ['S#7'], ratedBy: 'test' })).toThrow(/was not returned/);
    expect(db.prepare('SELECT relevance FROM search_results').get().relevance).toBeNull();
    db.close();
  });

  it('fails immediately on a locked writer and restores the connection timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-search-telemetry-'));
    tempDirs.push(dir);
    const path = join(dir, 'test.db');
    const writer = openDb(path);
    const contender = new Database(path);
    contender.pragma('busy_timeout = 4321');
    writer.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    expect(() => recordSearch(contender, {
      query: 'alpha', surface: 'mcp_search', client: 'test', results: [],
    })).toThrow(/locked|busy/i);
    expect(Date.now() - started).toBeLessThan(500);
    expect(contender.pragma('busy_timeout', { simple: true })).toBe(4321);
    writer.exec('ROLLBACK');
    contender.close();
    writer.close();
  });

  it('records MCP results, leaves the reminder last, and reports relevance', async () => {
    const db = openDb();
    const obsId = seedObservation(db);
    const result = await handleSearchForTest(db, {
      query: 'alpha telemetry lesson', project: 'telemetry-test', deep: false,
    }, { clientIdentity: 'codex/1' });
    expect(result.search_id).toBeGreaterThan(0);
    expect(result.content[0].text.trim().endsWith(
      `Search ${result.search_id} — rate relevance with mem_search_feedback; omit any result you cannot judge honestly.`
    )).toBe(true);
    handleSearchFeedbackForTest(db, {
      search_id: result.search_id, relevant: [`#${obsId}`],
    }, { clientIdentity: 'codex/1' });
    const report = computeSearchTelemetry(db, { project: 'telemetry-test' });
    expect(report).toMatchObject({ search_count: 1, rated_count: 1, relevance_coverage: 1 });
    expect(report.relevance_distribution.relevant).toBe(1);
    expect(formatSearchTelemetryReport(report)).toContain('Relevance coverage: 1/1 (100.0%)');
    db.close();
  });

  it('defaults MCP search to five results and pages with offset five', async () => {
    const db = openDb();
    seedObservation(db, { title: 'Paging token entry 0' });
    const insert = db.prepare(`
      INSERT INTO observations
        (memory_session_id, project, text, type, title, created_at, created_at_epoch, importance)
      VALUES ('memory-1', 'telemetry-test', ?, 'decision', ?, ?, ?, 3)
    `);
    for (let i = 1; i < 7; i++) {
      const title = `Paging token entry ${i}`;
      const now = Date.now();
      insert.run(title, title, new Date(now).toISOString(), now);
    }
    const createdAt = Date.now() - 86400000;
    db.prepare('UPDATE observations SET created_at = ?, created_at_epoch = ?')
      .run(new Date(createdAt).toISOString(), createdAt);
    const first = await handleSearchForTest(db, { query: 'paging token', project: 'telemetry-test', deep: false });
    const second = await handleSearchForTest(db, { query: 'paging token', project: 'telemetry-test', offset: 5, deep: false });
    expect(first.results).toHaveLength(5);
    expect(second.results).toHaveLength(2);
    const pages = [...first.results, ...second.results];
    expect(new Set(pages.map(row => row.id)).size,
      JSON.stringify({ first: first.results.map(row => [row.id, row.score]), second: second.results.map(row => [row.id, row.score]) })).toBe(7);
    db.close();
  });

  it('keeps rank precision surface-local and gates it by surface coverage', () => {
    const db = openDb();
    for (let i = 1; i <= 30; i++) {
      const searchId = recordSearch(db, {
        query: `mcp ${i}`, surface: 'mcp_search', client: 'test',
        results: [{ source: 'obs', id: i, title: `MCP ${i}` }], now: i,
      });
      rateSearchResults(db, { searchId, relevant: [`#${i}`], ratedBy: 'test', now: i });
    }
    const hookId = recordSearch(db, {
      query: 'hook', surface: 'user_prompt_hook', client: 'test',
      results: [{ source: 'obs', id: 100, title: 'Hook' }], now: 31,
    });
    rateSearchResults(db, { searchId: hookId, irrelevant: ['#100'], ratedBy: 'test', now: 31 });

    const report = computeSearchTelemetry(db, { now: 32 });
    expect(Object.keys(report.by_rank).sort()).toEqual(['mcp_search:1', 'user_prompt_hook:1']);
    const text = formatSearchTelemetryReport(report);
    expect(text).toContain('mcp_search #1: 30/30 relevant');
    expect(text).toContain('user_prompt_hook #1: suppressed (surface: 1 ratings');
    db.close();
  });

  it('keeps MCP search output when telemetry cannot acquire the writer lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-search-telemetry-mcp-'));
    tempDirs.push(dir);
    const path = join(dir, 'test.db');
    const writer = openDb(path);
    seedObservation(writer);
    writer.pragma('wal_checkpoint(FULL)');
    const contender = new Database(path);
    writer.exec('BEGIN IMMEDIATE');
    const result = await handleSearchForTest(contender, {
      query: 'alpha telemetry lesson', project: 'telemetry-test', deep: false,
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.search_id).toBeNull();
    expect(result.content[0].text).toContain('Alpha telemetry lesson');
    expect(result.content[0].text).not.toContain('rate relevance');
    writer.exec('ROLLBACK');
    contender.close();
    writer.close();
  });

  it('records genuine zero-result searches but not queries filtered to no terms', async () => {
    const db = openDb();
    const invalid = await handleSearchForTest(db, { query: 'AND OR NOT', deep: false });
    expect(invalid.search_id).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) c FROM search_runs').get().c).toBe(0);

    const miss = await handleSearchForTest(db, { query: 'definitelymissingtoken', deep: false });
    expect(miss.search_id).toBeGreaterThan(0);
    expect(miss.content[0].text).not.toContain('rate relevance');
    expect(db.prepare('SELECT returned_count FROM search_runs WHERE search_id = ?').get(miss.search_id).returned_count).toBe(0);
    db.close();
  });
});
