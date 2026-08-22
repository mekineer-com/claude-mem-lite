import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { recallByFile } from '../lib/recall-core.mjs';

// Single-source recall core (convergence audit 2026-06-13): cmdRecall (CLI) and
// mem_recall (MCP) hand-copied the junction query, LIKE escaping, and the
// access-count bump — the same drift class as the mem_get formatter drift
// (#8678). These tests pin the shared contract; renderers stay per-surface.
describe('recall-core', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-rc', project: 'test' });
  });
  afterEach(() => db.close());

  // Pre-tag review of v3.76.2 (SF-1/S3): recall-core derived its key with node:path
  // `basename` and matched with a bare `%<basename>` suffix LIKE — the two defects
  // v3.76.2 fixed in lib/file-edge-match.mjs, still live on THIS face. recallByFile is
  // mem_recall (MCP) and the CLI `recall` command, so both were affected.
  //
  // FAILS IF: this face stops using the shared fileMatchClause/fileMatchParams and
  // hand-rolls the derivation again.
  it('matches a Windows-shaped path against a bare-basename junction entry', () => {
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'hook-memory null deref', lessonLearned: 'guard the deref',
      filesModified: '["hook-memory.mjs"]',
    });
    const { filename, rows } = recallByFile(db, 'C:\\proj\\src\\hook-memory.mjs');
    expect(filename).toBe('hook-memory.mjs');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].title).toMatch(/hook-memory/);
  });

  it('does not collide across the path boundary (utils.mjs must not match bash-utils.mjs)', () => {
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'bash-utils regex fix', lessonLearned: 'anchor the suffix',
      filesModified: '["src/bash-utils.mjs"]',
    });
    expect(recallByFile(db, 'utils.mjs').rows).toEqual([]);
  });

  it('matches by basename against full-path junction entries', () => {
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'utils fix', lessonLearned: 'check CJK boundary',
      filesModified: '["/repo/src/utils.mjs"]',
    });
    const { filename, rows } = recallByFile(db, '/somewhere/else/utils.mjs');
    expect(filename).toBe('utils.mjs');
    expect(rows).toHaveLength(1);
    expect(rows[0].lesson_learned).toBe('check CJK boundary');
  });

  it('escapes LIKE wildcards in filenames (underscore must not match any-char)', () => {
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'underscore file', filesModified: '["my_file.mjs"]',
    });
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'wildcard trap', filesModified: '["myxfile.mjs"]',
    });
    const { rows } = recallByFile(db, 'my_file.mjs');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('underscore file');
  });

  it('filters low-signal titles by default, includes them with includeNoise', () => {
    insertObs(db, {
      sessionId: 'sess-rc', type: 'change', importance: 1,
      title: 'Modified noisy.mjs', filesModified: '["noisy.mjs"]',
    });
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'real noisy.mjs lesson', filesModified: '["noisy.mjs"]',
    });
    const def = recallByFile(db, 'noisy.mjs');
    expect(def.rows.map(r => r.title)).toEqual(['real noisy.mjs lesson']);
    const all = recallByFile(db, 'noisy.mjs', { includeNoise: true });
    expect(all.rows).toHaveLength(2);
  });

  it('bumps access_count and last_accessed_at on recalled rows only', () => {
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'bumped', filesModified: '["bump.mjs"]',
    });
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'untouched', filesModified: '["other.mjs"]',
    });
    const { rows } = recallByFile(db, 'bump.mjs');
    const bumped = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(rows[0].id);
    expect(bumped.access_count).toBe(1);
    const other = db.prepare("SELECT access_count FROM observations WHERE title = 'untouched'").get();
    expect(other.access_count || 0).toBe(0);
  });

  it('respects limit and excludes compressed rows', () => {
    for (let i = 0; i < 5; i++) {
      insertObs(db, {
        sessionId: 'sess-rc', type: 'bugfix', importance: 2,
        title: `many ${i}`, filesModified: '["many.mjs"]',
      });
    }
    insertObs(db, {
      sessionId: 'sess-rc', type: 'bugfix', importance: 2,
      title: 'compressed away', filesModified: '["many.mjs"]', compressedInto: 1,
    });
    const { rows } = recallByFile(db, 'many.mjs', { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.title !== 'compressed away')).toBe(true);
  });

  it('returns the column superset both surfaces need (importance + epoch included)', () => {
    insertObs(db, {
      sessionId: 'sess-rc', type: 'decision', importance: 3,
      title: 'cols probe', filesModified: '["cols.mjs"]',
    });
    const { rows } = recallByFile(db, 'cols.mjs');
    const r = rows[0];
    for (const k of ['id', 'type', 'title', 'lesson_learned', 'importance', 'created_at', 'created_at_epoch', 'project']) {
      expect(k in r, `column ${k}`).toBe(true);
    }
  });
});
