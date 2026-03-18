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

// Capture stdout output from synchronous code
function captureStdout(fn) {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = (str) => { output += str; return true; };
  try {
    const result = fn();
    // Handle async functions (run() is async)
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

  it('shows recent observations with default count (5)', async () => {
    for (let i = 0; i < 8; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Observation ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent']));
    expect(output).toContain('[mem] Recent');
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(5);
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
    expect(output).toContain('Title: Chose PostgreSQL over MySQL');
    expect(output).toContain('Narrative: We evaluated both databases');
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
    expect(output).toContain('Files: config.ts, db.ts');
  });

  it('shows lesson when present', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Memory leak fix', text: 'memory leak',
      lessonLearned: 'Always clear intervals on unmount',
    });
    const output = await captureStdout(() => run(['get', '1']));
    expect(output).toContain('Lesson: Always clear intervals on unmount');
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

  it('shows usage when no --anchor provided', async () => {
    const output = await captureStdout(() => run(['timeline']));
    expect(output).toContain('Usage');
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

  it('saves with --importance clamped to 1-3', async () => {
    await captureStdout(() => run(['save', 'Test importance high', '--importance', '5']));
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.importance).toBe(3); // clamped to max

    await captureStdout(() => run(['save', 'Test importance one', '--importance', '1']));
    const row2 = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row2.importance).toBe(1); // min value
  });

  it('defaults importance to 2 when --importance is 0 (falsy)', async () => {
    // parseInt('0') is 0, which is falsy → `|| 2` defaults to 2
    await captureStdout(() => run(['save', 'Test importance zero', '--importance', '0']));
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.importance).toBe(2); // 0 is falsy, falls back to default 2, then clamped
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
    const sessions = testDb.prepare("SELECT * FROM sdk_sessions WHERE content_session_id LIKE 'cli-%'").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].status).toBe('completed');
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
    expect(output).toContain('Observations:');
    expect(output).toContain('Sessions:');
    expect(output).toContain('Projects:');
    expect(output).toContain('Types:');
    expect(output).toContain('bugfix=2');
    expect(output).toContain('discovery=1');
  });

  it('shows stats for empty DB', async () => {
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('[mem] Stats');
    expect(output).toContain('Observations: 0');
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

  it('shows error for unknown command', async () => {
    const output = await captureStdout(() => run(['nonexistent']));
    expect(output).toContain('Unknown command');
  });
});
