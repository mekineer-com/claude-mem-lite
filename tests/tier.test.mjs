import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeTier, ACTIVE_WINDOWS, TIER_CASE_SQL, tierSqlParams, relativeTime } from '../tier.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { DECAY_HALF_LIFE_BY_TYPE } from '../utils.mjs';

const NOW = Date.now();
const HOUR = 3600000;
const DAY = 86400000;

const baseCtx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-current' };

describe('ACTIVE_WINDOWS', () => {
  it('equals 2x decay half-life for each type', () => {
    for (const [type, halfLife] of Object.entries(DECAY_HALF_LIFE_BY_TYPE)) {
      expect(ACTIVE_WINDOWS[type]).toBe(halfLife * 2);
    }
  });
});

describe('computeTier', () => {
  it('returns archive for compressed_into != 0', () => {
    expect(computeTier({ compressed_into: -1 }, baseCtx)).toBe('archive');
    expect(computeTier({ compressed_into: -2 }, baseCtx)).toBe('archive');
    expect(computeTier({ compressed_into: 42 }, baseCtx)).toBe('archive');
  });

  it('returns archive for superseded observations', () => {
    expect(computeTier({ superseded_at: NOW - DAY, compressed_into: null }, baseCtx)).toBe('archive');
  });

  it('archive wins over same-session (Rule 1 > Rule 2)', () => {
    expect(computeTier({
      compressed_into: -1, memory_session_id: 'sess-current',
    }, baseCtx)).toBe('archive');
  });

  it('returns working for same session', () => {
    expect(computeTier({
      memory_session_id: 'sess-current', project: 'test',
      compressed_into: null, superseded_at: null,
      created_at_epoch: NOW - 10 * DAY, importance: 1,
    }, baseCtx)).toBe('working');
  });

  it('returns working for recently accessed high-importance', () => {
    expect(computeTier({
      project: 'test', importance: 2, last_accessed_at: NOW - HOUR,
      compressed_into: null, superseded_at: null, memory_session_id: 'other',
      created_at_epoch: NOW - 30 * DAY, type: 'decision',
    }, baseCtx)).toBe('working');
  });

  it('not working if importance < 2 even if recently accessed', () => {
    expect(computeTier({
      project: 'test', importance: 1, last_accessed_at: NOW - HOUR,
      compressed_into: null, superseded_at: null, memory_session_id: 'other',
      created_at_epoch: NOW - 30 * DAY, type: 'decision',
    }, baseCtx)).not.toBe('working');
  });

  it('returns working for recently created same-project', () => {
    expect(computeTier({
      project: 'test', created_at_epoch: NOW - HOUR,
      compressed_into: null, superseded_at: null, memory_session_id: 'other',
      importance: 1, type: 'change',
    }, baseCtx)).toBe('working');
  });

  it('returns active for observation within decay window', () => {
    expect(computeTier({
      type: 'decision', created_at_epoch: NOW - 100 * DAY,
      compressed_into: null, superseded_at: null, memory_session_id: 'other',
      project: 'other-project', importance: 1,
    }, baseCtx)).toBe('active');
  });

  it('returns archive for observation beyond decay window', () => {
    expect(computeTier({
      type: 'change', created_at_epoch: NOW - 20 * DAY,
      compressed_into: null, superseded_at: null, memory_session_id: 'other',
      project: 'other-project', importance: 1,
    }, baseCtx)).toBe('archive');
  });

  it('handles null fields gracefully', () => {
    expect(computeTier({
      compressed_into: null, superseded_at: null, memory_session_id: null,
      project: null, importance: null, last_accessed_at: null,
      created_at_epoch: NOW - 5 * DAY, type: 'discovery',
    }, baseCtx)).toBe('active');
  });

  it('unknown type defaults to change active window (14d)', () => {
    expect(computeTier({
      type: 'unknown', created_at_epoch: NOW - 10 * DAY,
      compressed_into: null, superseded_at: null, memory_session_id: 'other',
      project: 'other', importance: 1,
    }, baseCtx)).toBe('active');

    expect(computeTier({
      type: 'unknown', created_at_epoch: NOW - 20 * DAY,
      compressed_into: null, superseded_at: null, memory_session_id: 'other',
      project: 'other', importance: 1,
    }, baseCtx)).toBe('archive');
  });
});

describe('TIER_CASE_SQL parity with computeTier', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-current' }); insertSession(db, { id: 'other-sess' }); });
  afterEach(() => { db.close(); });

  it('SQL and JS produce identical results for sample observations', () => {
    insertObs(db, { sessionId: 'sess-current', title: 'same-session', type: 'change' });
    insertObs(db, { sessionId: 'other-sess', title: 'recent', type: 'bugfix', epochOffset: -HOUR });
    insertObs(db, { sessionId: 'other-sess', title: 'active-decision', type: 'decision', epochOffset: -100 * DAY, project: 'other' });
    insertObs(db, { sessionId: 'other-sess', title: 'expired-change', type: 'change', epochOffset: -20 * DAY, project: 'other' });
    insertObs(db, { sessionId: 'other-sess', title: 'compressed', type: 'change', compressedInto: -1 });
    insertObs(db, { sessionId: 'other-sess', title: 'superseded', type: 'bugfix', supersededAt: NOW });
    insertObs(db, { sessionId: 'other-sess', title: 'high-imp-accessed', type: 'feature', importance: 2, lastAccessedAt: NOW - HOUR, epochOffset: -30 * DAY });

    const params = tierSqlParams(baseCtx);
    const rows = db.prepare(`
      SELECT *, ${TIER_CASE_SQL} as tier FROM observations
    `).all(...params);

    for (const row of rows) {
      const jsTier = computeTier(row, baseCtx);
      expect(row.tier).toBe(jsTier);
    }
  });
});

describe('relativeTime', () => {
  it('formats seconds', () => { expect(relativeTime(NOW - 30000, NOW)).toBe('30s ago'); });
  it('formats minutes', () => { expect(relativeTime(NOW - 5 * 60000, NOW)).toBe('5min ago'); });
  it('formats hours', () => { expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3h ago'); });
  it('formats days', () => { expect(relativeTime(NOW - 5 * DAY, NOW)).toBe('5d ago'); });
  it('formats months', () => { expect(relativeTime(NOW - 45 * DAY, NOW)).toBe('1mo ago'); });
});
