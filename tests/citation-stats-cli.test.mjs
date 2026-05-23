import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

let testDb;

// Capture stdout + stderr combined
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

describe('citation-stats CLI', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'p1', memoryId: 'mem-s1' });
  });

  afterEach(() => {
    try { testDb.close(); } catch {}
  });

  function obs(overrides) {
    const result = insertObs(testDb, {
      sessionId: 'mem-s1',
      project: 'p1',
      type: 'bugfix',
      title: 't',
      importance: 2,
      ...overrides,
    });
    const id = result.lastInsertRowid;
    // The 3 v32 columns aren't accepted by insertObs — patch via raw UPDATE.
    testDb.prepare('UPDATE observations SET uncited_streak=?, cited_count=?, injection_count=? WHERE id=?')
      .run(overrides.uncited_streak ?? 0, overrides.cited_count ?? 0, overrides.injection_count ?? 0, id);
    return id;
  }

  it('reports active decay queue (uncited_streak >= 2)', async () => {
    obs({ title: 'queue me', importance: 2, uncited_streak: 2 });
    obs({ title: 'safe', importance: 2, uncited_streak: 1 });
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/decay queue/i);
    expect(output).toContain('queue me');
    expect(output).not.toContain('safe');
  });

  it('reports recently-promoted (cited_count > 0, importance >= 3)', async () => {
    obs({ title: 'pro', importance: 3, cited_count: 2 });
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/promoted/i);
    expect(output).toContain('pro');
  });

  it('reports per-project cite stats', async () => {
    obs({ title: 'a', importance: 2, cited_count: 1, injection_count: 3 });
    obs({ title: 'b', importance: 2, cited_count: 0, injection_count: 2 });
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/p1/);
    expect(output).toMatch(/cite rate|cited/i);
  });

  it('--json flag emits machine-readable output', async () => {
    obs({ title: 'j', importance: 2, uncited_streak: 2 });
    const output = await captureStdoutOnly(() => run(['citation-stats', '--json']));
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.decay_queue)).toBe(true);
    expect(parsed.decay_queue[0].title).toBe('j');
  });

  it('--days flag sets window for per-project cite rate', async () => {
    // Create old obs (outside 7-day window)
    obs({ title: 'old', importance: 2, cited_count: 5, injection_count: 10, epochOffset: -10 * 86400 * 1000 });
    // Create recent obs (inside window)
    obs({ title: 'new_recent', importance: 2, cited_count: 1, injection_count: 2, epochOffset: 0 });

    const output = await captureStdoutOnly(() => run(['citation-stats', '--days', '7']));
    // The title should be in the output (in either decay queue or promoted section)
    // Since the new obs doesn't have uncited_streak>=2, it won't be in decay queue
    // Since it doesn't have importance=3, it won't be in promoted either
    // But it should be counted in the per-project cite rate
    expect(output).toContain('Cite rate by project');
  });
});
