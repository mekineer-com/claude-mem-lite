import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION, initSchema } from '../schema.mjs';
import {
  computeSearchTelemetry,
  formatSearchTelemetryReport,
  rateSearchResults,
  recordSearch,
} from '../lib/search-telemetry.mjs';
import { handleSearchFeedbackForTest, handleSearchForTest as rawHandleSearchForTest } from '../server.mjs';

const handleSearchForTest = (db, args, options = {}) =>
  rawHandleSearchForTest(db, args, {
    telemetryEnabled: true,
    producerVersion: 'test-version',
    ...options,
  });

const openDb = (path = ':memory:') => {
  const db = new Database(path);
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
};

function seedObservation(db, { project = 'telemetry-test', title = 'Alpha telemetry lesson' } = {}) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch)
    VALUES ('content-1', 'memory-1', ?, ?, ?)
  `,
  ).run(project, new Date(now).toISOString(), now);
  return Number(
    db
      .prepare(
        `
    INSERT INTO observations
      (memory_session_id, project, text, type, title, created_at, created_at_epoch, importance)
    VALUES ('memory-1', ?, ?, 'decision', ?, ?, ?, 3)
  `,
      )
      .run(project, title, title, new Date(now).toISOString(), now).lastInsertRowid,
  );
}

describe('search telemetry on schema v49', () => {
  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates both tables on a fresh database and cascades run deletion', () => {
    const db = openDb();
    expect(CURRENT_SCHEMA_VERSION).toBe(49);
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(49);
    const id = recordSearch(db, {
      project: 'p',
      query: 'alpha',
      surface: 'mcp_search',
      client: 'test',
      producerVersion: '6.9.1-test',
      results: [{ source: 'obs', id: 1, title: 'Alpha' }],
    });
    expect(db.prepare('SELECT producer_version FROM search_runs WHERE search_id = ?').get(id)).toEqual({
      producer_version: '6.9.1-test',
    });
    db.prepare('DELETE FROM search_runs WHERE search_id = ?').run(id);
    expect(db.prepare('SELECT COUNT(*) c FROM search_results').get().c).toBe(0);

    db.close();
  });

  it('preserves populated telemetry while upgrading a schema-46 database to 49', () => {
    const db = openDb();
    const searchId = recordSearch(db, {
      project: 'p',
      query: 'preserve me',
      surface: 'mcp_search',
      client: 'test',
      results: [{ source: 'obs', id: 7, title: 'Preserved result' }],
    });
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE observation_vectors (observation_id INTEGER PRIMARY KEY, vector BLOB);
      CREATE TABLE vocab_state (term TEXT PRIMARY KEY, value REAL);
      ALTER TABLE observations DROP COLUMN last_access_session_id;
      UPDATE schema_version SET version = 46;
    `);
    initSchema(db);
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(49);
    expect(db.prepare('SELECT query FROM search_runs WHERE search_id = ?').get(searchId).query).toBe(
      'preserve me',
    );
    expect(
      db.prepare('SELECT snapshot_label FROM search_results WHERE search_id = ?').get(searchId)
        .snapshot_label,
    ).toBe('Preserved result');
    expect(
      db
        .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('observation_vectors', 'vocab_state')")
        .get().c,
    ).toBe(0);
    db.close();
  });

  it('self-heals upstream schema 49 when telemetry tables are missing', () => {
    const db = openDb();
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE search_results; DROP TABLE search_runs;');
    initSchema(db);
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(49);
    expect(
      db.prepare("SELECT COUNT(*) c FROM pragma_table_info('search_results') WHERE name = 'relevance'").get()
        .c,
    ).toBe(1);
    db.close();
  });

  it('adds producer version to populated schema 49 without changing historical ratings', () => {
    const db = openDb();
    const searchId = recordSearch(db, {
      query: 'historical search',
      surface: 'mcp_search',
      client: 'test',
      results: [{ source: 'obs', id: 8, title: 'Historical result' }],
    });
    rateSearchResults(db, { searchId, relevant: ['#8'], ratedBy: 'test' });
    db.pragma('foreign_keys = OFF');
    db.exec('ALTER TABLE search_runs DROP COLUMN producer_version');

    initSchema(db);

    expect(db.prepare('SELECT query, producer_version FROM search_runs').get()).toEqual({
      query: 'historical search',
      producer_version: null,
    });
    expect(db.prepare('SELECT relevance FROM search_results').get()).toEqual({ relevance: 'relevant' });
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(49);
    db.close();
  });

  it('refuses a database newer than schema 49', () => {
    const db = openDb();
    db.prepare('UPDATE schema_version SET version = 50').run();
    expect(() => initSchema(db)).toThrow(/supports up to v49/);
    db.close();
  });

  it('records snapshots and sparse relevance, then replaces only resubmitted ratings', () => {
    const db = openDb();
    const searchId = recordSearch(db, {
      project: 'p',
      query: 'alpha',
      surface: 'mcp_search',
      searchMode: 'normal',
      corpusCounts: { obs: 10 },
      matchedCount: 2,
      client: 'codex/1',
      now: 1000,
      results: [
        { source: 'obs', id: 7, title: 'Alpha' },
        { source: 'session', id: 8, request: 'Beta' },
        { source: 'prompt', id: 9, prompt_text: 'Gamma' },
        { source: 'event', id: 10, title: 'Delta' },
      ],
    });
    expect(
      rateSearchResults(db, {
        searchId,
        relevant: ['#7', 'P#9'],
        partiallyRelevant: ['S#8', 'E#10'],
        ratedBy: 'codex/1',
        now: 2000,
      }),
    ).toBe(4);
    rateSearchResults(db, { searchId, irrelevant: ['#7'], ratedBy: 'codex/1', now: 3000 });
    expect(
      db
        .prepare(
          'SELECT result_id, snapshot_label, relevance, rated_by FROM search_results ORDER BY returned_rank',
        )
        .all(),
    ).toEqual([
      { result_id: 7, snapshot_label: 'Alpha', relevance: 'irrelevant', rated_by: 'codex/1' },
      { result_id: 8, snapshot_label: 'Beta', relevance: 'partial', rated_by: 'codex/1' },
      { result_id: 9, snapshot_label: 'Gamma', relevance: 'relevant', rated_by: 'codex/1' },
      { result_id: 10, snapshot_label: 'Delta', relevance: 'partial', rated_by: 'codex/1' },
    ]);
    db.close();
  });

  it('scrubs and caps persisted queries, result labels, and client identity', () => {
    const db = openDb();
    const searchId = recordSearch(db, {
      query: `deploy with api_key=sk-mykey123 ${'q'.repeat(600)}`,
      surface: 'mcp_search',
      client: `client token=abc123xyz ${'c'.repeat(600)}`,
      results: [{ source: 'obs', id: 7, title: `token=abc123xyz ${'t'.repeat(600)}` }],
    });
    const query = db.prepare('SELECT query FROM search_runs WHERE search_id = ?').get(searchId).query;
    expect(query).toHaveLength(500);
    expect(query).toContain('api_key=***');
    const label = db
      .prepare('SELECT snapshot_label FROM search_results WHERE search_id = ?')
      .get(searchId).snapshot_label;
    expect(label).toHaveLength(500);
    expect(label).toContain('token=***');
    const client = db.prepare('SELECT client FROM search_runs WHERE search_id = ?').get(searchId).client;
    expect(client).toHaveLength(500);
    expect(client).toContain('token=***');
    db.close();
  });

  it('rejects malformed, duplicate, and foreign result IDs without partial updates', () => {
    const db = openDb();
    const searchId = recordSearch(db, {
      query: 'alpha',
      surface: 'mcp_search',
      client: 'test',
      results: [{ source: 'obs', id: 7, title: 'Alpha' }],
    });
    expect(() => rateSearchResults(db, { searchId, relevant: ['7'], ratedBy: 'test' })).toThrow(
      /Invalid result ID/,
    );
    expect(() =>
      rateSearchResults(db, { searchId, relevant: ['#7'], irrelevant: ['#7'], ratedBy: 'test' }),
    ).toThrow(/more than once/);
    expect(() => rateSearchResults(db, { searchId, relevant: ['S#7'], ratedBy: 'test' })).toThrow(
      /was not returned/,
    );
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
    expect(() =>
      recordSearch(contender, {
        query: 'alpha',
        surface: 'mcp_search',
        client: 'test',
        results: [],
      }),
    ).toThrow(/locked|busy/i);
    expect(Date.now() - started).toBeLessThan(500);
    expect(contender.pragma('busy_timeout', { simple: true })).toBe(4321);
    writer.exec('ROLLBACK');
    contender.close();
    writer.close();
  });

  it('restores the configured timeout when the prior pragma value is unreadable', () => {
    const db = openDb();
    const pragma = db.pragma.bind(db);
    const wrapped = new Proxy(db, {
      get(target, prop) {
        if (prop === 'pragma') {
          return (source, options) =>
            source === 'busy_timeout' && options?.simple ? 'unknown' : pragma(source, options);
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    recordSearch(wrapped, { query: 'alpha', surface: 'mcp_search', client: 'test', results: [] });
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('records MCP results, leaves the reminder last, and reports relevance', async () => {
    const db = openDb();
    const obsId = seedObservation(db);
    const result = await handleSearchForTest(
      db,
      {
        query: 'alpha telemetry lesson',
        project: 'telemetry-test',
        deep: false,
      },
      { clientIdentity: 'codex/1' },
    );
    expect(result.search_id).toBeGreaterThan(0);
    expect(
      db.prepare('SELECT producer_version FROM search_runs WHERE search_id = ?').get(result.search_id),
    ).toEqual({ producer_version: 'test-version' });
    expect(
      result.content[0].text
        .trim()
        .endsWith(
          `Search ${result.search_id} — call mem_search_feedback for any result you can judge (query relevance, not novelty). For retrieval-quality investigations, assess contribution separately; this tool stores relevance only.`,
        ),
    ).toBe(true);
    handleSearchFeedbackForTest(
      db,
      {
        search_id: result.search_id,
        relevant: [`#${obsId}`],
      },
      { clientIdentity: 'codex/1' },
    );
    const report = computeSearchTelemetry(db, { project: 'telemetry-test' });
    expect(report).toMatchObject({ search_count: 1, rated_count: 1, relevance_coverage: 1 });
    expect(report.relevance_distribution.relevant).toBe(1);
    expect(formatSearchTelemetryReport(report)).toContain('Relevance coverage: 1/1 (100.0%)');
    expect(formatSearchTelemetryReport(report)).toContain('recording failures (last 14d): 0');
    db.close();
  });

  it('does not record or append a feedback reminder unless telemetry is enabled', async () => {
    const db = openDb();
    seedObservation(db);
    const result = await rawHandleSearchForTest(db, {
      query: 'alpha telemetry lesson',
      project: 'telemetry-test',
      deep: false,
    });
    expect(result.search_id).toBeNull();
    expect(result.content[0].text).not.toContain('mem_search_feedback');
    expect(db.prepare('SELECT COUNT(*) c FROM search_runs').get().c).toBe(0);
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
    for (let i = 1; i < 21; i++) {
      const title = `Paging token entry ${i}`;
      const now = Date.now();
      insert.run(title, title, new Date(now).toISOString(), now);
    }
    const createdAt = Date.now() - 86400000;
    db.prepare('UPDATE observations SET created_at = ?, created_at_epoch = ?').run(
      new Date(createdAt).toISOString(),
      createdAt,
    );
    const first = await handleSearchForTest(db, {
      query: 'paging token',
      project: 'telemetry-test',
      deep: false,
    });
    const second = await handleSearchForTest(db, {
      query: 'paging token',
      project: 'telemetry-test',
      offset: 5,
      deep: false,
    });
    const topTen = await handleSearchForTest(db, {
      query: 'paging token',
      project: 'telemetry-test',
      limit: 10,
      deep: false,
    });
    const topTwenty = await handleSearchForTest(db, {
      query: 'paging token',
      project: 'telemetry-test',
      limit: 20,
      deep: false,
    });
    expect(first.results).toHaveLength(5);
    expect(second.results).toHaveLength(5);
    const pages = [...first.results, ...second.results];
    expect(
      new Set(pages.map((row) => row.id)).size,
      JSON.stringify({
        first: first.results.map((row) => [row.id, row.score]),
        second: second.results.map((row) => [row.id, row.score]),
      }),
    ).toBe(10);
    expect(topTen.results.map((row) => row.id)).toEqual(pages.map((row) => row.id));
    expect(topTwenty.results.slice(0, 10).map((row) => row.id)).toEqual(topTen.results.map((row) => row.id));
    db.close();
  });

  it('keeps sparse-query expansion ordering stable across limits 5, 10, and 20', async () => {
    const db = openDb();
    seedObservation(db, { title: 'zebra minotaur rescue one' });
    const insert = db.prepare(`
      INSERT INTO observations
        (memory_session_id, project, text, narrative, type, title, created_at, created_at_epoch, importance)
      VALUES ('memory-1', 'telemetry-test', ?, ?, 'bugfix', ?, ?, ?, 3)
    `);
    for (const suffix of ['two', 'three', 'four', 'five', 'six']) {
      const title = `zebra minotaur rescue ${suffix}`;
      const now = Date.now();
      insert.run(title, `minotaur ${suffix} evidence`, title, new Date(now).toISOString(), now);
    }
    const targetTitle = 'minotaur queue saturation root cause';
    const now = Date.now();
    insert.run(targetTitle, 'minotaur consumers detach', targetTitle, new Date(now).toISOString(), now);

    const ids = async (limit) =>
      (
        await handleSearchForTest(db, {
          query: 'zebra quokka',
          project: 'telemetry-test',
          limit,
          deep: false,
        })
      ).results.map((row) => row.id);
    const top5 = await ids(5);
    const top10 = await ids(10);
    const top20 = await ids(20);
    expect(top5).toEqual(top10.slice(0, 5));
    expect(top10).toEqual(top20.slice(0, 10));
    expect(top5).toHaveLength(5);
    expect(top10).toHaveLength(7);
    expect(top20).toHaveLength(7);
    expect(top10).toContain(db.prepare('SELECT id FROM observations WHERE title = ?').get(targetTitle).id);
    db.close();
  });

  it('pages through the obs_type recent fallback beyond its first five rows', async () => {
    const db = openDb();
    seedObservation(db, { title: 'Decision fallback entry 0' });
    const insert = db.prepare(`
      INSERT INTO observations
        (memory_session_id, project, text, type, title, created_at, created_at_epoch, importance)
      VALUES ('memory-1', 'telemetry-test', ?, 'decision', ?, ?, ?, 3)
    `);
    for (let i = 1; i < 7; i++) {
      const title = `Decision fallback entry ${i}`;
      const now = Date.now() + i;
      insert.run(title, title, new Date(now).toISOString(), now);
    }
    const first = await handleSearchForTest(db, {
      query: 'no_matching_fts_term',
      project: 'telemetry-test',
      obs_type: 'decision',
      deep: false,
    });
    const second = await handleSearchForTest(db, {
      query: 'no_matching_fts_term',
      project: 'telemetry-test',
      obs_type: 'decision',
      offset: 5,
      deep: false,
    });
    expect(first.results).toHaveLength(5);
    expect(second.results).toHaveLength(2);
    expect(new Set([...first.results, ...second.results].map((row) => row.id)).size).toBe(7);
    db.close();
  });

  it('keeps rank precision surface-local and gates it by surface coverage', () => {
    const db = openDb();
    for (let i = 1; i <= 30; i++) {
      const searchId = recordSearch(db, {
        query: `mcp ${i}`,
        surface: 'mcp_search',
        client: 'test',
        results: [{ source: 'obs', id: i, title: `MCP ${i}` }],
        now: i,
      });
      rateSearchResults(db, { searchId, relevant: [`#${i}`], ratedBy: 'test', now: i });
    }
    const hookId = recordSearch(db, {
      query: 'hook',
      surface: 'user_prompt_hook',
      client: 'test',
      results: [{ source: 'obs', id: 100, title: 'Hook' }],
      now: 31,
    });
    rateSearchResults(db, { searchId: hookId, irrelevant: ['#100'], ratedBy: 'test', now: 31 });

    const report = computeSearchTelemetry(db, { now: 32 });
    expect(Object.keys(report.by_rank).sort()).toEqual(['mcp_search:1', 'user_prompt_hook:1']);
    const text = formatSearchTelemetryReport(report);
    expect(text).toContain('mcp_search #1: 30/30 relevant');
    expect(text).toContain('user_prompt_hook #1: suppressed (surface: 1 ratings');

    const underCovered = globalThis.structuredClone(report);
    underCovered.by_surface.mcp_search = {
      returned: 151,
      relevant: 30,
      partial: 0,
      irrelevant: 0,
      unrated: 121,
      coverage: 30 / 151,
    };
    expect(formatSearchTelemetryReport(underCovered)).toContain(
      'mcp_search #1: suppressed (surface: 30 ratings, 19.9% coverage)',
    );

    const unratedRank = globalThis.structuredClone(report);
    unratedRank.by_rank['mcp_search:1'] = {
      returned: 1,
      relevant: 0,
      partial: 0,
      irrelevant: 0,
      unrated: 1,
      coverage: 0,
    };
    const unratedText = formatSearchTelemetryReport(unratedRank);
    expect(unratedText).toContain('mcp_search #1: no ratings at this rank');
    expect(unratedText).not.toContain('NaN%');
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
      query: 'alpha telemetry lesson',
      project: 'telemetry-test',
      deep: false,
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
    expect(
      db.prepare('SELECT returned_count FROM search_runs WHERE search_id = ?').get(miss.search_id)
        .returned_count,
    ).toBe(0);
    db.close();
  });
});
