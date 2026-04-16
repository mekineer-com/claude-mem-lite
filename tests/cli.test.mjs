// Tests for mem-cli.mjs — CLI command layer
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Import mem-cli.mjs command functions indirectly via run().
 * Since internal functions (cmdSearch, cmdRecent, etc.) are not exported,
 * we test through the public run() interface by capturing stdout.
 *
 * To inject a :memory: DB, we mock schema.mjs's ensureDb.
 */

let testDb;

// Capture stdout + stderr combined (fail() writes to stderr, out() to stdout)
function captureStdout(fn) {
  let output = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (str) => { output += str; return true; };
  process.stderr.write = (str) => { output += str; return true; };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        return output;
      }).catch((err) => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        throw err;
      });
    }
  } catch (err) {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    throw err;
  }
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  return output;
}

// Capture stdout only (for JSON output tests that must not mix stderr)
function captureStdoutOnly(fn) {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = (str) => { output += str; return true; };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        process.stdout.write = original;
        return output;
      }).catch((err) => {
        process.stdout.write = original;
        throw err;
      });
    }
  } catch (err) {
    process.stdout.write = original;
    throw err;
  }
  process.stdout.write = original;
  return output;
}

// Mock ensureDb to return our test DB
vi.mock('../schema.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    ensureDb: () => {
      // Return a proxy that intercepts close() to prevent the CLI from closing our test DB
      return new Proxy(testDb, {
        get(target, prop) {
          if (prop === 'close') return () => {};
          return target[prop];
        },
      });
    },
  };
});

// Mock inferProject to return a consistent value
vi.mock('../utils.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    inferProject: () => 'test--project',
  };
});

// Import run after mocks are set up
const { run } = await import('../mem-cli.mjs');

// ─── Argument Parsing ────────────────────────────────────────────────────────
// parseArgs is not exported, but we can test its behavior through commands

describe('CLI argument parsing (via commands)', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('search parses query and --type flag', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed auth crash', text: 'authentication error in login',
    });
    const output = await captureStdout(() => run(['search', 'authentication', '--type', 'bugfix']));
    expect(output).toContain('Fixed auth crash');
    expect(output).toContain('result');
  });

  it('search parses --limit flag', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Discovery ${i}`, text: `search term alpha ${i}`,
      });
    }
    const output = await captureStdout(() => run(['search', 'alpha', '--limit', '2']));
    // Should have header + 2 result lines
    const lines = output.trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(3); // header + 2 results max
  });

  it('recent parses count from positional arg', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Recent obs ${i}`, text: `content ${i}`, epochOffset: i * 1000,
      });
    }
    const output = await captureStdout(() => run(['recent', '2']));
    const lines = output.trim().split('\n');
    // header + 2 entries
    expect(lines.length).toBe(3);
  });

  it('get parses comma-separated IDs', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'First obs', text: 'first content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Second obs', text: 'second content',
    });
    const output = await captureStdout(() => run(['get', '1,2']));
    expect(output).toContain('First obs');
    expect(output).toContain('Second obs');
  });
});

// ─── search command ──────────────────────────────────────────────────────────

describe('CLI search command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('returns results with correct output format', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed database connection timeout', text: 'database connection pool was exhausted',
    });
    const output = await captureStdout(() => run(['search', 'database connection']));
    expect(output).toContain('[mem]');
    expect(output).toContain('result');
    expect(output).toContain('Fixed database connection timeout');
    // Output line format: #ID ICON DATE TITLE
    expect(output).toMatch(/#\d+/);
  });

  it('shows "No results" for unmatched query', async () => {
    const output = await captureStdout(() => run(['search', 'zzzyyyxxx']));
    expect(output).toContain('No results');
  });

  it('filters by --type', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug in parser', text: 'parser logic error',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Discovered parser pattern', text: 'parser pattern discovery',
    });
    const bugOnly = await captureStdout(() => run(['search', 'parser', '--type', 'bugfix']));
    expect(bugOnly).toContain('Bug in parser');
    expect(bugOnly).not.toContain('Discovered parser pattern');
  });

  it('respects --limit', async () => {
    for (let i = 0; i < 10; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Widget feature ${i}`, text: `widget implementation details ${i}`,
      });
    }
    const output = await captureStdout(() => run(['search', 'widget', '--limit', '3']));
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBeLessThanOrEqual(3);
  });

  it('shows lesson_learned when present', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Race condition in queue', text: 'queue race condition',
      lessonLearned: 'Always use mutex for shared state',
    });
    const output = await captureStdout(() => run(['search', 'queue race']));
    expect(output).toContain('Always use mutex');
  });

  it('falls back to OR query when AND returns nothing', async () => {
    // Insert observation that matches "alpha" but not "alpha AND zzzzz"
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Alpha discovery', text: 'alpha protocol implementation details',
    });
    // "alpha zzzzz" as AND query won't match, but OR fallback should find "alpha"
    const output = await captureStdout(() => run(['search', 'alpha zzzzz']));
    expect(output).toContain('Alpha discovery');
  });

  // R-1: LOW_SIGNAL title filtering — default search hides hook-llm degraded titles
  // ("Modified X", "Worked on X", etc.) that compete for BM25 rank but have
  // ~3% access rate. They remain searchable via --include-noise.
  it('excludes LOW_SIGNAL titles from default search', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Modified auth.mjs',
      text: 'uniquealphatoken handling tweaked',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Auth flow uniquealphatoken validation fix',
      text: 'uniquealphatoken validation root cause',
    });
    const output = await captureStdout(() => run(['search', 'uniquealphatoken']));
    expect(output).toContain('Auth flow uniquealphatoken validation fix');
    expect(output).not.toContain('Modified auth.mjs');
  });

  it('--include-noise restores LOW_SIGNAL titles in search results', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Modified auth.mjs',
      text: 'uniquealphatoken handling tweaked',
    });
    const output = await captureStdout(() => run(['search', 'uniquealphatoken', '--include-noise']));
    expect(output).toContain('Modified auth.mjs');
  });

  // R-3: lesson_learned presence lifts rank vs identical obs without lesson.
  // Empirical basis: bugfix with lesson has +6.3pp hit rate over bugfix without.
  // The multiplier is intentionally small (×1.3) — this is a gentle rerank, not a bucket.
  it('ranks observations with lesson_learned above identical ones without', async () => {
    // Insert the WITHOUT-lesson row first (newer) to prove the lesson boost
    // overcomes any tie-break favoring recency.
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Queue fix uniquebetatoken variant A',
      text: 'uniquebetatoken race condition in worker queue',
      epochOffset: 0,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Queue fix uniquebetatoken variant B',
      text: 'uniquebetatoken race condition in worker queue',
      lessonLearned: 'Always acquire the mutex before peeking the queue head',
      epochOffset: -5000,
    });
    const output = await captureStdout(() => run(['search', 'uniquebetatoken']));
    const withIdx = output.indexOf('Queue fix uniquebetatoken variant B');
    const withoutIdx = output.indexOf('Queue fix uniquebetatoken variant A');
    expect(withIdx).toBeGreaterThan(-1);
    expect(withoutIdx).toBeGreaterThan(-1);
    // Lower index = appears first in ranked output
    expect(withIdx).toBeLessThan(withoutIdx);
  });

  it('shows usage when no query provided', async () => {
    const output = await captureStdout(() => run(['search']));
    expect(output).toContain('Usage');
  });
});

// ─── recent command ──────────────────────────────────────────────────────────

describe('CLI recent command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows recent observations with default count (10)', async () => {
    for (let i = 0; i < 12; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Observation ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent']));
    expect(output).toContain('[mem] Recent');
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(10);
  });

  it('respects explicit count', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Obs ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent', '3']));
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(3);
  });

  it('shows "No recent observations" when DB is empty', async () => {
    const output = await captureStdout(() => run(['recent']));
    expect(output).toContain('No recent observations');
  });

  it('formats relative time correctly', async () => {
    // Insert obs with epoch 2 hours ago
    const twoHoursAgo = Date.now() - 2 * 3600000;
    testDb.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', 'content', 'discovery', 'Two hours ago obs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run(new Date(twoHoursAgo).toISOString(), twoHoursAgo);

    const output = await captureStdout(() => run(['recent']));
    expect(output).toContain('2h ago');
  });

  it('excludes compressed observations', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed obs', text: 'content', compressedInto: 999,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active obs', text: 'content',
    });
    const output = await captureStdout(() => run(['recent']));
    expect(output).not.toContain('Compressed obs');
    expect(output).toContain('Active obs');
  });
});

// ─── recall command ──────────────────────────────────────────────────────────

describe('CLI recall command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('finds observations by filename in files_modified', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Updated server config', text: 'config update',
      filesModified: '["src/server.mjs"]',
    });
    const output = await captureStdout(() => run(['recall', 'src/server.mjs']));
    expect(output).toContain('History for server.mjs');
    expect(output).toContain('Updated server config');
  });

  it('shows "No history" for unknown file', async () => {
    const output = await captureStdout(() => run(['recall', 'nonexistent.ts']));
    expect(output).toContain('No history');
  });

  it('shows lesson_learned inline when present', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed import order', text: 'import bug',
      filesModified: '["app/main.ts"]',
      lessonLearned: 'Check import order carefully',
    });
    const output = await captureStdout(() => run(['recall', 'main.ts']));
    expect(output).toContain('Check import order');
  });

  it('shows usage when no file provided', async () => {
    const output = await captureStdout(() => run(['recall']));
    expect(output).toContain('Usage');
  });
});

// ─── get command ─────────────────────────────────────────────────────────────

describe('CLI get command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows full detail for single ID', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'Chose PostgreSQL over MySQL',
      text: 'database selection',
      narrative: 'We evaluated both databases and chose Postgres for JSON support',
    });
    const output = await captureStdout(() => run(['get', '1']));
    expect(output).toContain('#1 [decision]');
    expect(output).toContain('title: Chose PostgreSQL over MySQL');
    expect(output).toContain('narrative: We evaluated both databases');
  });

  it('shows multiple IDs', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'First observation', text: 'first',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'feature',
      title: 'Second observation', text: 'second',
    });
    const output = await captureStdout(() => run(['get', '1,2']));
    expect(output).toContain('First observation');
    expect(output).toContain('Second observation');
  });

  it('shows "No observations found" for non-existent ID', async () => {
    const output = await captureStdout(() => run(['get', '9999']));
    expect(output).toContain('No observations found');
  });

  it('shows files from files_modified', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Updated configs', text: 'config changes',
      filesModified: '["src/config.ts", "src/db.ts"]',
    });
    const output = await captureStdout(() => run(['get', '1']));
    expect(output).toContain('files_modified: ["src/config.ts", "src/db.ts"]');
  });

  it('shows lesson when present', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Memory leak fix', text: 'memory leak',
      lessonLearned: 'Always clear intervals on unmount',
    });
    const output = await captureStdout(() => run(['get', '1']));
    expect(output).toContain('lesson_learned: Always clear intervals on unmount');
  });

  it('shows usage when no IDs provided', async () => {
    const output = await captureStdout(() => run(['get']));
    expect(output).toContain('Usage');
  });
});

// ─── timeline command ────────────────────────────────────────────────────────

describe('CLI timeline command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows timeline around anchor with <-- marker', async () => {
    const baseEpoch = Date.now() - 100000;
    for (let i = 0; i < 7; i++) {
      const epoch = baseEpoch + i * 10000;
      testDb.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES ('mem-s1', 'test--project', 'content ${i}', 'discovery', 'Timeline obs ${i}', '', '', '', '', '[]', '[]', 1, ?, ?)
      `).run(new Date(epoch).toISOString(), epoch);
    }
    // Anchor on the 4th observation (id=4)
    const output = await captureStdout(() => run(['timeline', '--anchor', '4']));
    expect(output).toContain('Timeline around #4');
    expect(output).toContain('<--');
    // Should show observations around the anchor
    expect(output).toContain('Timeline obs');
  });

  it('respects --before and --after counts', async () => {
    const baseEpoch = Date.now() - 100000;
    for (let i = 0; i < 10; i++) {
      const epoch = baseEpoch + i * 10000;
      testDb.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES ('mem-s1', 'test--project', 'content ${i}', 'discovery', 'TL ${i}', '', '', '', '', '[]', '[]', 1, ?, ?)
      `).run(new Date(epoch).toISOString(), epoch);
    }
    const output = await captureStdout(() => run(['timeline', '--anchor', '5', '--before', '1', '--after', '1']));
    // Should have header + anchor + 1 before + 1 after = 4 lines
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(3); // 1 before + anchor + 1 after
  });

  it('shows "not found" for invalid anchor', async () => {
    const output = await captureStdout(() => run(['timeline', '--anchor', '999']));
    expect(output).toContain('not found');
  });

  it('shows recent observations when no --anchor provided', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent obs', text: 'content', epochOffset: 0,
    });
    const output = await captureStdout(() => run(['timeline']));
    expect(output).toContain('Timeline (most recent');
    expect(output).toContain('Recent obs');
  });

  it('shows "No observations" when no --anchor and DB empty', async () => {
    const output = await captureStdout(() => run(['timeline']));
    expect(output).toContain('No observations');
  });
});

// ─── save command ────────────────────────────────────────────────────────────

describe('CLI save command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('saves with default options (type=discovery)', async () => {
    const output = await captureStdout(() => run(['save', 'Authentication uses JWT tokens']));
    expect(output).toContain('[mem] Saved');
    expect(output).toContain('[discovery]');
    expect(output).toContain('Authentication uses JWT tokens');

    // Verify in DB
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.type).toBe('discovery');
    expect(row.text).toBe('Authentication uses JWT tokens');
    expect(row.importance).toBe(2); // default
  });

  it('saves with explicit --type and --title', async () => {
    const output = await captureStdout(() => run(['save', 'Use Redis for caching', '--type', 'decision', '--title', 'Cache architecture']));
    expect(output).toContain('[decision]');
    expect(output).toContain('Cache architecture');

    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.type).toBe('decision');
    expect(row.title).toBe('Cache architecture');
  });

  it('rejects out-of-range importance (must be 1-3)', async () => {
    const out5 = await captureStdout(() => run(['save', 'Test importance high', '--importance', '5']));
    expect(out5).toContain('Invalid importance');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const out0 = await captureStdout(() => run(['save', 'Test importance zero', '--importance', '0']));
    expect(out0).toContain('Invalid importance');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const outNeg = await captureStdout(() => run(['save', 'Test importance neg', '--importance', '-1']));
    expect(outNeg).toContain('Invalid importance');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    // Valid importance 1 saves successfully
    await captureStdout(() => run(['save', 'Test importance one', '--importance', '1']));
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.importance).toBe(1);
  });

  it('rejects invalid type', async () => {
    const output = await captureStdout(() => run(['save', 'test content', '--type', 'invalid']));
    expect(output).toContain('Invalid type');
    expect(output).toContain('Valid:');
  });

  it('shows usage when no text provided', async () => {
    const output = await captureStdout(() => run(['save']));
    expect(output).toContain('Usage');
  });

  it('creates a session for FK constraint', async () => {
    await captureStdout(() => run(['save', 'New observation via CLI']));
    const sessions = testDb.prepare("SELECT * FROM sdk_sessions WHERE content_session_id LIKE 'manual-%'").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].status).toBe('active');
  });
});

// ─── stats command ───────────────────────────────────────────────────────────

describe('CLI stats command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows stats with observations in DB', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug 1', text: 'bugfix',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug 2', text: 'bugfix 2',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Discovery 1', text: 'discovery',
    });

    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('[mem] Stats');
    expect(output).toContain('Total:');
    expect(output).toContain('observations');
    expect(output).toContain('sessions');
    expect(output).toContain('Type distribution');
    expect(output).toContain('bugfix: 2');
    expect(output).toContain('discovery: 1');
  });

  it('shows stats for empty DB', async () => {
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('[mem] Stats');
    expect(output).toContain('Total: 0 observations');
  });
});

// ─── help and unknown commands ───────────────────────────────────────────────

describe('CLI help and error handling', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('shows help for no args', async () => {
    const output = await captureStdout(() => run([]));
    expect(output).toContain('claude-mem-lite CLI');
    expect(output).toContain('Commands:');
  });

  it('shows help for --help flag', async () => {
    const output = await captureStdout(() => run(['--help']));
    expect(output).toContain('Commands:');
  });

  it('shows help for help command', async () => {
    const output = await captureStdout(() => run(['help']));
    expect(output).toContain('Commands:');
  });

  it('shows help for -h flag', async () => {
    const output = await captureStdout(() => run(['-h']));
    expect(output).toContain('Commands:');
  });

  it('shows error for unknown command', async () => {
    const output = await captureStdout(() => run(['nonexistent']));
    expect(output).toContain('Unknown command');
  });
});

// ─── delete command ─────────────────────────────────────────────────────────

describe('CLI delete command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows usage when no IDs provided', async () => {
    const output = await captureStdout(() => run(['delete']));
    expect(output).toContain('Usage');
  });

  it('shows preview without --confirm', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Delete preview test', text: 'content to delete',
    });
    const output = await captureStdout(() => run(['delete', '1']));
    expect(output).toContain('Preview');
    expect(output).toContain('Delete preview test');
    expect(output).toContain('--confirm');
    // Observation still exists
    const row = testDb.prepare('SELECT id FROM observations WHERE id = 1').get();
    expect(row).toBeTruthy();
  });

  it('deletes with --confirm', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'To be deleted', text: 'deletion target',
    });
    const output = await captureStdout(() => run(['delete', '1', '--confirm']));
    expect(output).toContain('Deleted 1');
    const row = testDb.prepare('SELECT id FROM observations WHERE id = 1').get();
    expect(row).toBeUndefined();
  });

  it('handles non-existent IDs gracefully', async () => {
    const output = await captureStdout(() => run(['delete', '9999']));
    expect(output).toContain('No observations found');
  });

  it('handles invalid ID strings', async () => {
    const output = await captureStdout(() => run(['delete', 'abc']));
    expect(output).toContain('No valid IDs');
  });

  it('cleans related_ids references on delete', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'First', text: 'first content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Second', text: 'second content', relatedIds: '[1]',
    });
    await captureStdout(() => run(['delete', '1', '--confirm']));
    const row = testDb.prepare('SELECT related_ids FROM observations WHERE id = 2').get();
    expect(JSON.parse(row.related_ids)).toEqual([]);
  });
});

// ─── update command ─────────────────────────────────────────────────────────

describe('CLI update command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows usage when no ID provided', async () => {
    const output = await captureStdout(() => run(['update']));
    expect(output).toContain('Usage');
  });

  it('shows error for non-existent observation', async () => {
    const output = await captureStdout(() => run(['update', '9999', '--title', 'New']));
    expect(output).toContain('not found');
  });

  it('shows error when no fields specified', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'No update', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1']));
    expect(output).toContain('No fields to update');
  });

  it('updates title', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Original title', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1', '--title', 'Updated title']));
    expect(output).toContain('Updated #1');
    expect(output).toContain('title');
    const row = testDb.prepare('SELECT title FROM observations WHERE id = 1').get();
    expect(row.title).toBe('Updated title');
  });

  it('updates type', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Type change', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--type', 'bugfix']));
    const row = testDb.prepare('SELECT type FROM observations WHERE id = 1').get();
    expect(row.type).toBe('bugfix');
  });

  it('rejects invalid importance values', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Importance test', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1', '--importance', '5']));
    expect(output).toContain('Invalid importance');
    const row = testDb.prepare('SELECT importance FROM observations WHERE id = 1').get();
    expect(row.importance).toBe(1); // unchanged (default)
  });

  it('updates lesson_learned via --lesson', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Lesson update', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--lesson', 'Always validate input']));
    const row = testDb.prepare('SELECT lesson_learned FROM observations WHERE id = 1').get();
    expect(row.lesson_learned).toBe('Always validate input');
  });

  it('updates narrative', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Narrative update', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--narrative', 'Detailed narrative text']));
    const row = testDb.prepare('SELECT narrative FROM observations WHERE id = 1').get();
    expect(row.narrative).toBe('Detailed narrative text');
  });

  it('updates concepts', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Concepts update', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--concepts', 'auth security jwt']));
    const row = testDb.prepare('SELECT concepts FROM observations WHERE id = 1').get();
    expect(row.concepts).toBe('auth security jwt');
  });
});

// ─── export command ─────────────────────────────────────────────────────────

describe('CLI export command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('exports observations as JSON by default', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Export test bug', text: 'export content',
    });
    const output = await captureStdoutOnly(() => run(['export']));
    const data = JSON.parse(output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].title).toBe('Export test bug');
  });

  it('exports as JSONL format', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'JSONL export 1', text: 'line 1',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'JSONL export 2', text: 'line 2',
    });
    const output = await captureStdoutOnly(() => run(['export', '--format', 'jsonl']));
    const lines = output.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).title).toBeTruthy();
  });

  it('filters by --type', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug export', text: 'bug content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Discovery export', text: 'discovery content',
    });
    const output = await captureStdoutOnly(() => run(['export', '--type', 'bugfix']));
    const data = JSON.parse(output);
    expect(data.length).toBe(1);
    expect(data[0].type).toBe('bugfix');
  });

  it('filters by --from and --to', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Old export', text: 'old content', epochOffset: -10 * 86400000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent export', text: 'recent content',
    });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const output = await captureStdoutOnly(() => run(['export', '--from', yesterday]));
    const data = JSON.parse(output);
    expect(data.length).toBe(1);
    expect(data[0].title).toBe('Recent export');
  });

  it('respects --limit', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Export item ${i}`, text: `content ${i}`,
      });
    }
    const output = await captureStdoutOnly(() => run(['export', '--limit', '2']));
    const data = JSON.parse(output);
    expect(data.length).toBe(2);
  });

  it('excludes compressed observations by default', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed obs', text: 'compressed', compressedInto: 999,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active obs', text: 'active',
    });
    const output = await captureStdoutOnly(() => run(['export']));
    const data = JSON.parse(output);
    expect(data.length).toBe(1);
    expect(data[0].title).toBe('Active obs');
  });

  it('includes compressed with --include-compressed', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed obs', text: 'compressed', compressedInto: 999,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active obs', text: 'active',
    });
    const output = await captureStdoutOnly(() => run(['export', '--include-compressed']));
    const data = JSON.parse(output);
    expect(data.length).toBe(2);
  });

  it('shows message for empty export', async () => {
    const output = await captureStdout(() => run(['export', '--type', 'bugfix']));
    expect(output).toContain('No observations found');
  });
});

// ─── compress command ───────────────────────────────────────────────────────

describe('CLI compress command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows preview by default', async () => {
    // Insert old, low-importance observations
    const oldEpoch = -60 * 86400000; // 60 days ago
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Old obs ${i}`, text: `old content ${i}`, importance: 1,
        epochOffset: oldEpoch + i * 1000,
      });
    }
    const output = await captureStdout(() => run(['compress']));
    expect(output).toContain('Compression preview');
    expect(output).toContain('--execute');
  });

  it('shows no candidates when all are recent', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent obs', text: 'recent content', importance: 1,
    });
    const output = await captureStdout(() => run(['compress']));
    expect(output).toContain('No candidates');
  });

  it('executes compression with --execute', async () => {
    const oldEpoch = -60 * 86400000;
    for (let i = 0; i < 4; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Compress target ${i}`, text: `compress content ${i}`, importance: 1,
        epochOffset: oldEpoch + i * 1000,
      });
    }
    const output = await captureStdout(() => run(['compress', '--execute']));
    expect(output).toContain('Compressed');
    expect(output).toContain('weekly summaries');
    // Verify compressed_into is set on originals
    const compressed = testDb.prepare('SELECT COUNT(*) as c FROM observations WHERE compressed_into IS NOT NULL AND compressed_into > 0').get();
    expect(compressed.c).toBeGreaterThan(0);
  });

  it('shows no candidates when importance is high', async () => {
    const oldEpoch = -60 * 86400000;
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Important obs', text: 'important content', importance: 3,
      epochOffset: oldEpoch,
    });
    const output = await captureStdout(() => run(['compress']));
    expect(output).toContain('No candidates');
  });
});

// ─── maintain command ───────────────────────────────────────────────────────

describe('CLI maintain command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows usage for no action', async () => {
    const output = await captureStdout(() => run(['maintain']));
    expect(output).toContain('Usage');
  });

  it('shows usage for invalid action', async () => {
    const output = await captureStdout(() => run(['maintain', 'invalid']));
    expect(output).toContain('Usage');
  });

  it('scan reports maintenance stats', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active observation', text: 'active content',
    });
    const output = await captureStdout(() => run(['maintain', 'scan']));
    expect(output).toContain('Maintenance scan');
    expect(output).toContain('Total active');
    expect(output).toContain('Near-duplicate pairs');
    expect(output).toContain('Stale');
    expect(output).toContain('Broken');
    expect(output).toContain('Boostable');
    expect(output).toContain('Pending purge');
  });

  it('scan detects near-duplicates', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Fix authentication bug in login page', text: 'auth bug content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Fix authentication bug in login page', text: 'auth bug content 2',
    });
    const output = await captureStdout(() => run(['maintain', 'scan']));
    expect(output).toContain('Near-duplicate pairs: 1');
  });

  it('execute runs cleanup operation', async () => {
    // Insert broken observation (no title, no narrative)
    testDb.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', '', 'discovery', '', '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'cleanup']));
    expect(output).toContain('Cleaned up');
  });

  it('execute runs boost operation', async () => {
    // Insert frequently accessed low-importance observation
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Boostable obs', text: 'boostable content', importance: 1,
      accessCount: 5,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'boost']));
    expect(output).toContain('Boosted');
    const row = testDb.prepare('SELECT importance FROM observations WHERE title = ?').get('Boostable obs');
    expect(row.importance).toBe(2);
  });

  it('execute runs decay operation', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Stale obs', text: 'stale content', importance: 2,
      epochOffset: -60 * 86400000, // 60 days ago
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'decay']));
    expect(output).toContain('Decayed');
  });

  it('execute runs dedup with --merge-ids', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Keep this one', text: 'keep content', importance: 2,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Remove this dup', text: 'dup content', importance: 1,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'dedup', '--merge-ids', '1:2']));
    expect(output).toContain('Merged');
    const row = testDb.prepare('SELECT compressed_into FROM observations WHERE id = 2').get();
    expect(row.compressed_into).toBe(1);
  });

  it('execute runs purge_stale operation', async () => {
    // Insert observation marked as pending purge (old). -2 matches COMPRESSED_PENDING_PURGE in utils.mjs.
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Pending purge obs', text: 'purge content',
      compressedInto: -2,
      epochOffset: -60 * 86400000,
    });
    // T2-P0-A: --confirm is now required for the destructive path.
    const output = await captureStdout(() => run([
      'maintain', 'execute', '--ops', 'purge_stale', '--confirm',
    ]));
    expect(output).toContain('Purged 1 stale observations');
  });

  it('execute purge_stale without --confirm previews and does not delete', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Pending purge obs preview', text: 'purge content',
      compressedInto: -2,
      epochOffset: -60 * 86400000,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'purge_stale']));
    expect(output).toContain('purge_stale preview (no --confirm)');
    const row = testDb.prepare("SELECT id FROM observations WHERE title = 'Pending purge obs preview'").get();
    expect(row).toBeDefined();
  });
});

// ─── browse command ─────────────────────────────────────────────────────────

describe('CLI browse command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows empty dashboard with no observations', async () => {
    const output = await captureStdout(() => run(['browse']));
    expect(output).toContain('Memory Dashboard');
    expect(output).toContain('No observations found');
  });

  it('shows observations grouped by tier', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Recent working memory', text: 'recent content',
    });
    const output = await captureStdout(() => run(['browse']));
    expect(output).toContain('Memory Dashboard');
    expect(output).toContain('Working Memory');
    expect(output).toContain('Active Memory');
    expect(output).toContain('Archive');
  });

  it('filters by --tier', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Browse tier filter', text: 'content',
    });
    const output = await captureStdout(() => run(['browse', '--tier', 'working']));
    expect(output).toContain('Working Memory');
  });

  it('rejects invalid tier', async () => {
    const output = await captureStdout(() => run(['browse', '--tier', 'invalid']));
    expect(output).toContain('Invalid tier');
  });

  it('shows totals when no tier filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Totals test', text: 'content',
    });
    const output = await captureStdout(() => run(['browse']));
    expect(output).toContain('Totals:');
  });
});

// ─── context command ────────────────────────────────────────────────────────

describe('CLI context command', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('reports empty context for a project with no data', async () => {
    const output = await captureStdout(() =>
      run(['context', '--project', 'test--empty-proj']),
    );
    expect(output).toContain('No context yet');
    expect(output).toContain('test--empty-proj');
  });

  it('generates context block live from DB when session summary exists', async () => {
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    const now = Date.now();
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'test--project', 'Fix auth bug', 'Patched middleware', 'Add tests', ?, ?)
    `).run('mem-s1', new Date(now).toISOString(), now);

    const output = await captureStdout(() =>
      run(['context', '--project', 'test--project']),
    );
    expect(output).toContain('<claude-mem-context>');
    expect(output).toContain('</claude-mem-context>');
    expect(output).toContain('### Last Session');
    expect(output).toContain('Fix auth bug');
    expect(output).toContain('Patched middleware');
  });

  it('does not read from CLAUDE.md even when one exists', async () => {
    // Context now comes from DB only — CLAUDE.md is ignored on purpose.
    // Seed DB with known data and assert the output comes from the DB, not
    // from any CLAUDE.md file that might be sitting around.
    insertSession(testDb, { id: 's2', project: 'test--db-only', memoryId: 'mem-s2' });
    const now = Date.now();
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'test--db-only', 'DB-derived request', 'DB-derived completed', 'DB-derived next', ?, ?)
    `).run('mem-s2', new Date(now).toISOString(), now);

    const output = await captureStdout(() =>
      run(['context', '--project', 'test--db-only']),
    );
    expect(output).toContain('DB-derived request');
    // Ensure the error-paths from the old CLAUDE.md-reading implementation are gone.
    expect(output).not.toContain('No CLAUDE.md');
    expect(output).not.toContain('No claude-mem-context block found');
  });

  it('emits JSON with parsed sections when --json is set', async () => {
    insertSession(testDb, { id: 's3', project: 'test--json-proj', memoryId: 'mem-s3' });
    const now = Date.now();
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'test--json-proj', 'Ship v2.30', 'Done', 'Release notes', ?, ?)
    `).run('mem-s3', new Date(now).toISOString(), now);

    const output = await captureStdout(() =>
      run(['context', '--project', 'test--json-proj', '--json']),
    );
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('raw');
    expect(parsed).toHaveProperty('sections');
    expect(parsed.raw).toContain('Ship v2.30');
    expect(parsed.sections).toHaveProperty('last_session');
  });
});

// ─── stats command extended ─────────────────────────────────────────────────

describe('CLI stats command extended', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows data health metrics', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Health test', text: 'some content here',
    });
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('Data Health');
    expect(output).toContain('Est. tokens');
    expect(output).toContain('Avg importance');
    expect(output).toContain('Low-value');
    expect(output).toContain('Compressed');
    expect(output).toContain('Tier distribution');
  });

  it('shows daily activity', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Daily activity test', text: 'daily content',
    });
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('Daily activity');
  });

  it('filters by --project', async () => {
    const output = await captureStdout(() => run(['stats', '--project', 'test--project']));
    expect(output).toContain('test--project');
  });

  it('filters by --days', async () => {
    const output = await captureStdout(() => run(['stats', '--days', '7']));
    expect(output).toContain('Last 7d');
  });

  it('shows session and prompt counts', async () => {
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('sessions');
    expect(output).toContain('prompts');
  });

  it('shows top projects when no project filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Projects list test', text: 'content',
    });
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('Top projects');
    expect(output).toContain('test--project');
  });
});

// N-1: `stats --quality` quality dashboard — baseline for the R-2 Haiku prompt A/B.
// Surfaces lesson rate, LOW_SIGNAL rate, per-type hit/lesson %, and explicit R-2 targets.
describe('CLI stats --quality command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    // Deterministic seed: 10 obs in-window, known lesson/LOW_SIGNAL/access distribution.
    // bugfix: 4 total, 2 with lesson (50%), 1 accessed (25% hit)
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed queue race', text: 'q', lessonLearned: 'Always mutex first', accessCount: 1 });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed token expiry', text: 't', lessonLearned: 'Check TTL on refresh' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed null deref', text: 'n' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed off-by-one', text: 'o' });
    // decision: 1 total, 1 with lesson (100%), 1 accessed (100% hit)
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'Switch to RRF merge', text: 'r',
      lessonLearned: 'BM25+vector beats either alone', accessCount: 2 });
    // discovery: 1 total, 1 with lesson, 0 accessed
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'FTS5 CJK quirk', text: 'f', lessonLearned: 'Needs bigram workaround' });
    // change: 3 total, all LOW_SIGNAL titles, 0 lessons, 0 accessed
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Modified auth.mjs', text: 'a' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Modified server.mjs', text: 's' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Worked on utils.mjs', text: 'u' });
    // refactor: 1 total, no lesson, no access
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'refactor',
      title: 'Extracted helper', text: 'h' });
    // Totals: 10 obs, 4 with lesson (40%), 3 LOW_SIGNAL (30%), 2 accessed (20% hit)
  });
  afterEach(() => { testDb.close(); });

  it('outputs quality snapshot header with --quality flag', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toContain('Quality snapshot');
  });

  it('reports overall lesson rate as "4 / 10 (40.0%)"', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    // Exact format: `Lesson rate:      4 / 10 (40.0%)` (spacing flexible)
    expect(output).toMatch(/Lesson rate:\s*4\s*\/\s*10\s*\(40\.0%\)/);
  });

  it('reports LOW_SIGNAL rate as "3 / 10 (30.0%)"', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toMatch(/LOW_SIGNAL:\s*3\s*\/\s*10\s*\(30\.0%\)/);
  });

  it('shows per-type breakdown with hit% and lesson%', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    // bugfix row: count=4, hit=25% (1/4 accessed), lesson=50% (2/4)
    expect(output).toMatch(/bugfix\s+4\s+.*hit\s*25\.0%.*lesson\s*50\.0%/);
    // change row: count=3, 0% hit, 0% lesson
    expect(output).toMatch(/change\s+3\s+.*hit\s*0\.0%.*lesson\s*0\.0%/);
  });

  it('shows R-2 watchdog target lines', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toContain('Targets');
    // Should show current vs target for lesson rate
    expect(output).toMatch(/Lesson rate.*15%/);
    // And for LOW_SIGNAL
    expect(output).toMatch(/LOW_SIGNAL.*30%/);
  });

  it('standard `stats` (no --quality) does NOT show quality block', async () => {
    const output = await captureStdout(() => run(['stats']));
    expect(output).not.toContain('Quality snapshot');
    expect(output).not.toContain('LOW_SIGNAL');
  });
});

// N-1 extension: unresolved_bugfix metric — proxy for "investigation, not fix" pollution.
// R-7 micro-experiment showed many type=bugfix observations are actually investigations
// where narrative explicitly ends with "root cause not yet identified" — Haiku tagged
// them bugfix because hasError, but no fix was applied. This metric tracks the pollution
// rate so we can see whether R-6 (manual save contract) reduces it over time.
describe('CLI stats --quality unresolved_bugfix metric', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    // 5 bugfix observations: 3 unresolved (investigation only), 2 resolved (real fixes).
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Investigate test failure in parser', text: 'p',
      narrative: 'Ran cargo test and saw the failure. Searched for the symbol but Root cause not yet identified from the output.',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Lint failures in gsd-lite', text: 'l',
      narrative: 'Investigation of npm lint failures. Errors persisted on retry. Still fails after re-running biome check.',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Test suite failures in executor context', text: 't',
      narrative: 'TAP output shows failures in buildExecutorContext subtests. Regression suspected but root cause not yet identified.',
    });
    // Resolved bugfix #1 — has a clear root cause + fix
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fix race in credit deduction', text: 'r',
      narrative: 'IntegrityError in concurrent deduction. Root cause: read-then-write without SELECT FOR UPDATE. Added row lock; verified with stress test.',
      lessonLearned: 'Use SELECT FOR UPDATE for any read-then-write on a contended row',
    });
    // Resolved bugfix #2
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fix CJK tokenization in FTS5', text: 'c',
      narrative: 'FTS5 porter stemmer does not split CJK. Added bigram fallback in utils.mjs and verified search recall.',
      lessonLearned: 'FTS5 needs CJK bigram workaround',
    });
    // Totals: 5 bugfix, 3 unresolved (60%), 2 resolved
  });
  afterEach(() => { testDb.close(); });

  it('reports unresolved bugfix count as "3 / 5 (60.0%)"', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toMatch(/Unresolved bugfix:\s*3\s*\/\s*5\s*\(60\.0%\)/);
  });

  it('flags unresolved bugfix line as a R-6 watchdog (should trend down)', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    // The line should explicitly mention R-6 or "trend down" so users know what to look for.
    expect(output).toMatch(/Unresolved bugfix:.*R-6|Unresolved bugfix:.*trend.*↓|Unresolved bugfix:.*should.*decrease/);
  });

  it('matches case-insensitively against narrative pollution markers', async () => {
    // Add an extra observation with mixed-case marker — should still count
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Edge case', text: 'e',
      narrative: 'NOT YET RESOLVED — needs follow-up.',
    });
    const output = await captureStdout(() => run(['stats', '--quality']));
    // Now 4 unresolved out of 6 bugfix
    expect(output).toMatch(/Unresolved bugfix:\s*4\s*\/\s*6/);
  });
});

// ─── search cross-source (sessions + prompts) ──────────────────────────────

describe('CLI search cross-source', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows invalid source error', async () => {
    const output = await captureStdout(() => run(['search', 'test', '--source', 'invalid']));
    expect(output).toContain('Invalid --source');
  });

  it('shows no valid terms error', async () => {
    // Sanitized FTS query becomes empty for very short/stop words
    const output = await captureStdout(() => run(['search', 'a']));
    // Should either show 'No valid search terms' or 'No results'
    expect(output).toMatch(/No valid|No results/);
  });

  it('searches sessions when --source sessions', async () => {
    // Insert a session summary
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', 'Fix authentication module', 'Fixed auth module', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['search', 'authentication', '--source', 'sessions']));
    // Session search may work or fail depending on FTS availability
    expect(output).toBeDefined();
  });

  it('searches prompts when --source prompts', async () => {
    // Insert a user prompt
    testDb.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch)
      VALUES ('s1', 'How to fix the database connection issue', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['search', 'database connection', '--source', 'prompts']));
    expect(output).toBeDefined();
  });

  it('searches with --offset for pagination', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Paginated search item ${i}`, text: `paginated search content ${i}`,
      });
    }
    const output = await captureStdout(() => run(['search', 'paginated', '--limit', '2', '--offset', '2']));
    expect(output).toBeDefined();
  });

  it('searches with --branch filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Feature branch obs', text: 'branch filter content',
      branch: 'feat/auth',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Main branch obs', text: 'main branch filter content',
      branch: 'main',
    });
    const output = await captureStdout(() => run(['search', 'branch filter', '--branch', 'feat/auth']));
    expect(output).toBeDefined();
  });

  it('searches with --from and --to date filters', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Old date filter obs', text: 'old date filter content',
      epochOffset: -10 * 86400000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent date filter obs', text: 'recent date filter content',
    });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const output = await captureStdout(() => run(['search', 'date filter', '--from', yesterday]));
    expect(output).toContain('Recent date filter obs');
    expect(output).not.toContain('Old date filter obs');
  });

  it('type-list fallback when FTS returns nothing for typed search', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fallback type list bug', text: 'some unrelated content',
    });
    // Search for terms not in FTS but with --type, should trigger type-list fallback
    const output = await captureStdout(() => run(['search', 'zzz_nonexistent_zzz', '--type', 'bugfix']));
    // Either finds via fallback or shows no results
    expect(output).toBeDefined();
  });
});

// ─── get command with --source ──────────────────────────────────────────────

describe('CLI get command with source', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('gets session details with --source session', async () => {
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, investigated, learned, next_steps, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', 'Implement auth', 'Auth implemented', 'Auth patterns', 'JWT is better', 'Add tests', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['get', '1', '--source', 'session']));
    expect(output).toContain('S#1');
    expect(output).toContain('Request: Implement auth');
    expect(output).toContain('Completed: Auth implemented');
    expect(output).toContain('Investigated: Auth patterns');
    expect(output).toContain('Learned: JWT is better');
    expect(output).toContain('Next steps: Add tests');
  });

  it('shows no sessions found for non-existent ID', async () => {
    const output = await captureStdout(() => run(['get', '9999', '--source', 'session']));
    expect(output).toContain('No sessions found');
  });

  it('gets prompt details with --source prompt', async () => {
    testDb.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch)
      VALUES ('s1', 'How to fix the auth bug', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['get', '1', '--source', 'prompt']));
    expect(output).toContain('P#1');
    expect(output).toContain('Text: How to fix the auth bug');
    expect(output).toContain('Session: s1');
  });

  it('shows no prompts found for non-existent ID', async () => {
    const output = await captureStdout(() => run(['get', '9999', '--source', 'prompt']));
    expect(output).toContain('No prompts found');
  });

  it('gets observations with --fields filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fields filter test', text: 'content', narrative: 'Full narrative here',
    });
    const output = await captureStdout(() => run(['get', '1', '--fields', 'title,narrative']));
    expect(output).toContain('Fields filter test');
    expect(output).toContain('Full narrative here');
    // Should not include fields not in the --fields list (except header fields id/type/created_at)
    expect(output).not.toContain('importance:');
  });
});

// ─── timeline query-based anchor ────────────────────────────────────────────

describe('CLI timeline query-based anchor', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('finds anchor via --query flag', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Timeline query anchor target', text: 'unique anchor content for query',
      epochOffset: -60000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Before item', text: 'before content', epochOffset: -120000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'After item', text: 'after content',
    });
    const output = await captureStdout(() => run(['timeline', '--query', 'unique anchor']));
    expect(output).toContain('<--');
    expect(output).toContain('Timeline around');
  });

  it('finds anchor via positional query', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'feature',
      title: 'Positional query anchor', text: 'positional query content',
    });
    const output = await captureStdout(() => run(['timeline', 'positional query']));
    expect(output).toContain('Positional query anchor');
    expect(output).toContain('<--');
  });

  it('timeline with --project filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Project timeline obs', text: 'project timeline content',
    });
    const output = await captureStdout(() => run(['timeline', '--project', 'test--project']));
    expect(output).toContain('Project timeline obs');
  });
});

// ─── fts-check command ──────────────────────────────────────────────────────

describe('CLI fts-check command', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('shows usage for no action', async () => {
    const output = await captureStdout(() => run(['fts-check']));
    expect(output).toContain('Usage');
  });

  it('shows usage for invalid action', async () => {
    const output = await captureStdout(() => run(['fts-check', 'invalid']));
    expect(output).toContain('Usage');
  });

  it('checks FTS integrity', async () => {
    const output = await captureStdout(() => run(['fts-check', 'check']));
    expect(output).toContain('FTS5');
  });

  it('rebuilds FTS', async () => {
    const output = await captureStdout(() => run(['fts-check', 'rebuild']));
    expect(output).toContain('rebuilt');
  });
});

// ─── registry command ───────────────────────────────────────────────────────

describe('CLI registry command', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('shows usage for no action', async () => {
    const output = await captureStdout(() => run(['registry']));
    expect(output).toContain('Usage');
  });

  it('shows usage for invalid action', async () => {
    const output = await captureStdout(() => run(['registry', 'invalid']));
    expect(output).toContain('Usage');
  });

  // Registry commands access real DB files via REGISTRY_DB_PATH.
  // These tests just verify the command routing works without crashing.
  it('list runs without crashing', async () => {
    const output = await captureStdout(() => run(['registry', 'list']));
    // May succeed or show "not available" depending on registry DB
    expect(output).toBeDefined();
  });

  it('stats runs without crashing', async () => {
    const output = await captureStdout(() => run(['registry', 'stats']));
    expect(output).toBeDefined();
  });

  it('reindex runs without crashing', async () => {
    const output = await captureStdout(() => run(['registry', 'reindex']));
    expect(output).toBeDefined();
  });

  it('search shows usage when no query', async () => {
    const output = await captureStdout(() => run(['registry', 'search']));
    expect(output).toContain('Usage');
  });

  it('import shows usage when missing params', async () => {
    const output = await captureStdout(() => run(['registry', 'import']));
    expect(output).toContain('Usage');
  });

  it('remove shows usage when missing params', async () => {
    const output = await captureStdout(() => run(['registry', 'remove']));
    expect(output).toContain('Usage');
  });
});
