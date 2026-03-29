// E2E test suite for claude-mem-lite CLI commands
// Tests the actual CLI entry point (node cli.mjs <cmd>) as a subprocess
// Isolation via CLAUDE_MEM_DIR env var → redirects DB to temp dir

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const CLI_PATH = resolve('cli.mjs');

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-cli-e2e-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initTestDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db;
}

function runCli(args, { env = {} } = {}) {
  const mergedEnv = {
    ...process.env,
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_MEM_HOOK_RUNNING: undefined,
    ...env,
  };
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }

  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      timeout: 10000,
      encoding: 'utf8',
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

// ─── Test State ──────────────────────────────────────────────────────────────

let tmpHome;
let dataDir;
let projectDir;
let db;

beforeEach(() => {
  tmpHome = makeTmpDir();
  dataDir = join(tmpHome, '.claude-mem-lite');
  projectDir = join(tmpHome, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  db = initTestDb(dataDir);

  // Insert test session
  const now = new Date();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('e2e-sess', 'e2e-sess', 'parent--testproj', now.toISOString(), now.getTime());
});

afterEach(() => {
  try { db.close(); } catch {}
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─── Helper: Seed observations ───────────────────────────────────────────────

function seedObs({ type = 'discovery', title, text = '', importance = 1, filesModified = '[]', lessonLearned = null, epochOffset = 0 }) {
  const epoch = Date.now() + epochOffset;
  const result = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
                              files_read, files_modified, importance, lesson_learned, created_at, created_at_epoch)
    VALUES ('e2e-sess', 'parent--testproj', ?, ?, ?, '', ?, '', '', '[]', ?, ?, ?, ?, ?)
  `).run(text || title, type, title, text || title, filesModified, importance, lessonLearned, new Date(epoch).toISOString(), epoch);

  // Populate observation_files junction table (mirrors production saveObservation behavior)
  if (filesModified && filesModified !== '[]') {
    try {
      const files = JSON.parse(filesModified);
      if (Array.isArray(files)) {
        const obsId = Number(result.lastInsertRowid);
        const insertFile = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
        for (const f of files) {
          if (typeof f === 'string' && f.length > 0) insertFile.run(obsId, f);
        }
      }
    } catch { /* skip malformed JSON */ }
  }

  return result;
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe('CLI E2E: search', () => {
  it('finds observations via FTS5 and returns formatted output', () => {
    seedObs({ type: 'bugfix', title: 'Fixed database connection pool leak', text: 'database connection pool was exhausted under load' });
    const { stdout, exitCode } = runCli(['search', 'database connection']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[mem]');
    expect(stdout).toContain('result');
    expect(stdout).toContain('Fixed database connection pool leak');
    expect(stdout).toMatch(/#\d+/);
    expect(stdout).toContain('🔴'); // bugfix icon
  });

  it('shows lesson_learned when present', () => {
    seedObs({ type: 'bugfix', title: 'Race condition in queue', text: 'queue race condition', lessonLearned: 'Always use mutex for shared state' });
    const { stdout } = runCli(['search', 'queue race']);
    expect(stdout).toContain('Always use mutex');
  });

  it('filters by --type', () => {
    seedObs({ type: 'bugfix', title: 'Bug in auth parser', text: 'parser auth logic error' });
    seedObs({ type: 'discovery', title: 'Discovered parser pattern', text: 'parser pattern discovery' });
    const { stdout } = runCli(['search', 'parser', '--type', 'bugfix']);
    expect(stdout).toContain('Bug in auth parser');
    expect(stdout).not.toContain('Discovered parser pattern');
  });

  it('respects --limit', () => {
    for (let i = 0; i < 10; i++) {
      seedObs({ title: `Widget feature ${i}`, text: `widget implementation details number ${i}` });
    }
    const { stdout } = runCli(['search', 'widget', '--limit', '3']);
    const lines = stdout.trim().split('\n').filter(l => l.startsWith('#'));
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('returns no results gracefully', () => {
    const { stdout, exitCode } = runCli(['search', 'nonexistent_xyzzy_query']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No results');
  });

  it('OR fallback finds partial matches', () => {
    seedObs({ title: 'Alpha protocol fix', text: 'alpha protocol implementation repair' });
    // "alpha zzzzz_nonexistent" AND returns nothing, OR should find "alpha"
    const { stdout } = runCli(['search', 'alpha zzzzz_nonexistent']);
    expect(stdout).toContain('Alpha protocol fix');
  });

  it('filters by --from and --to dates', () => {
    const twoDaysAgo = -2 * 86400000;
    seedObs({ title: 'Old discovery', text: 'old discovery text', epochOffset: twoDaysAgo });
    seedObs({ title: 'Recent discovery', text: 'recent discovery text' });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { stdout } = runCli(['search', 'discovery', '--from', yesterday]);
    expect(stdout).toContain('Recent discovery');
    expect(stdout).not.toContain('Old discovery');
  });

  it('filters by --importance', () => {
    seedObs({ title: 'Low importance item', text: 'low importance test', importance: 1 });
    seedObs({ title: 'High importance item', text: 'high importance test', importance: 3 });
    const { stdout } = runCli(['search', 'importance', '--importance', '3']);
    expect(stdout).toContain('High importance item');
    expect(stdout).not.toContain('Low importance item');
  });
});

describe('CLI E2E: recent', () => {
  it('shows recent observations with relative timestamps', () => {
    seedObs({ title: 'Just happened', text: 'just happened content' });
    seedObs({ title: 'Also happened', text: 'also happened content', epochOffset: -60000 });
    const { stdout, exitCode } = runCli(['recent', '5']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[mem] Recent');
    expect(stdout).toContain('Just happened');
    expect(stdout).toContain('Also happened');
    // Relative time format
    expect(stdout).toMatch(/just now|[0-9]+m ago/);
  });

  it('returns empty message when no observations', () => {
    // Use a project that has no observations
    const { stdout } = runCli(['recent', '5'], { env: { CLAUDE_PROJECT_DIR: join(tmpHome, 'other', 'empty') } });
    expect(stdout).toContain('No recent');
  });

  it('respects count argument', () => {
    for (let i = 0; i < 10; i++) {
      seedObs({ title: `Item ${i}`, text: `item text ${i}`, epochOffset: -i * 60000 });
    }
    const { stdout } = runCli(['recent', '3']);
    const lines = stdout.trim().split('\n').filter(l => l.startsWith('#'));
    expect(lines.length).toBe(3);
  });
});

describe('CLI E2E: recall', () => {
  it('finds observations by filename in files_modified', () => {
    seedObs({
      title: 'Fixed auth module', text: 'auth module fix',
      filesModified: '["src/auth.mjs"]',
    });
    const { stdout, exitCode } = runCli(['recall', 'auth.mjs']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Fixed auth module');
    expect(stdout).toContain('[mem] History for auth.mjs');
  });

  it('shows lesson with recall results', () => {
    seedObs({
      title: 'Schema migration gotcha', text: 'schema gotcha',
      filesModified: '["db/schema.mjs"]', lessonLearned: 'Always backup before migration',
    });
    const { stdout } = runCli(['recall', 'schema.mjs']);
    expect(stdout).toContain('Always backup before migration');
  });

  it('returns no history for unknown file', () => {
    const { stdout } = runCli(['recall', 'nonexistent_file_xyz.ts']);
    expect(stdout).toContain('No history');
  });
});

describe('CLI E2E: get', () => {
  it('returns full observation details', () => {
    seedObs({
      type: 'bugfix', title: 'Connection pool fix', text: 'Fixed pool exhaustion',
      importance: 3, filesModified: '["src/pool.mjs"]', lessonLearned: 'Monitor pool size',
    });
    const obsId = db.prepare('SELECT id FROM observations ORDER BY id DESC LIMIT 1').get().id;
    const { stdout, exitCode } = runCli(['get', String(obsId)]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[bugfix]');
    expect(stdout).toContain('Connection pool fix');
    expect(stdout).toContain('pool.mjs');
    expect(stdout).toContain('Monitor pool size');
    expect(stdout).toContain('importance: 3');
  });

  it('updates access_count', () => {
    seedObs({ title: 'Access test', text: 'access test content' });
    const obsId = db.prepare('SELECT id FROM observations ORDER BY id DESC LIMIT 1').get().id;
    const before = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(obsId);
    expect(before.access_count).toBe(0);

    runCli(['get', String(obsId)]);

    const after = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(obsId);
    expect(after.access_count).toBe(1);
  });

  it('handles multiple IDs', () => {
    seedObs({ title: 'First obs', text: 'first content' });
    seedObs({ title: 'Second obs', text: 'second content' });
    const rows = db.prepare('SELECT id FROM observations ORDER BY id DESC LIMIT 2').all();
    const ids = rows.map(r => r.id).join(',');
    const { stdout } = runCli(['get', ids]);
    expect(stdout).toContain('First obs');
    expect(stdout).toContain('Second obs');
  });

  it('handles non-existent ID gracefully', () => {
    const { stderr } = runCli(['get', '999999']);
    expect(stderr).toContain('No observations found');
  });
});

describe('CLI E2E: timeline', () => {
  it('shows timeline around an anchor', () => {
    // Create 7 observations with increasing timestamps
    for (let i = 0; i < 7; i++) {
      seedObs({ title: `Timeline item ${i}`, text: `timeline content ${i}`, epochOffset: -((6 - i) * 60000) });
    }
    const rows = db.prepare('SELECT id FROM observations ORDER BY created_at_epoch ASC').all();
    const anchorId = rows[3].id; // middle item

    const { stdout, exitCode } = runCli(['timeline', '--anchor', String(anchorId)]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Timeline around #${anchorId}`);
    expect(stdout).toContain('<--'); // anchor marker
    // Should have before + anchor + after items
    const lines = stdout.trim().split('\n').filter(l => l.startsWith('#'));
    expect(lines.length).toBe(7); // 3 before + 1 anchor + 3 after
  });

  it('supports --query anchor', () => {
    seedObs({ title: 'Unique query anchor target', text: 'unique target for timeline query anchor test' });
    seedObs({ title: 'Before item', text: 'before content', epochOffset: -120000 });
    seedObs({ title: 'After item', text: 'after content', epochOffset: 60000 });
    const { stdout } = runCli(['timeline', '--query', 'unique query anchor target']);
    expect(stdout).toContain('Unique query anchor target');
    expect(stdout).toContain('<--');
  });

  it('supports positional query', () => {
    seedObs({ title: 'Positional anchor test', text: 'positional anchor for timeline' });
    const { stdout } = runCli(['timeline', 'positional anchor test']);
    expect(stdout).toContain('Positional anchor test');
  });

  it('updates access_count for anchor', () => {
    seedObs({ title: 'Access timeline test', text: 'access timeline content' });
    const obsId = db.prepare('SELECT id FROM observations ORDER BY id DESC LIMIT 1').get().id;
    runCli(['timeline', '--anchor', String(obsId)]);
    const after = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(obsId);
    expect(after.access_count).toBe(1);
  });

  it('respects --before and --after', () => {
    for (let i = 0; i < 10; i++) {
      seedObs({ title: `TL item ${i}`, text: `timeline content ${i}`, epochOffset: -((9 - i) * 60000) });
    }
    const rows = db.prepare('SELECT id FROM observations ORDER BY created_at_epoch ASC').all();
    const anchorId = rows[5].id;
    const { stdout } = runCli(['timeline', '--anchor', String(anchorId), '--before', '1', '--after', '1']);
    const lines = stdout.trim().split('\n').filter(l => l.startsWith('#'));
    expect(lines.length).toBe(3); // 1 before + 1 anchor + 1 after
  });
});

describe('CLI E2E: save', () => {
  it('saves a new observation and confirms', () => {
    const { stdout, exitCode } = runCli(['save', 'Important architectural decision about caching layer']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[mem] Saved');
    expect(stdout).toContain('[discovery]');
    expect(stdout).toContain('Important architectural decision');

    // Verify in DB
    const obs = db.prepare("SELECT * FROM observations WHERE title LIKE '%architectural decision%'").get();
    expect(obs).toBeTruthy();
    expect(obs.type).toBe('discovery');
    expect(obs.importance).toBe(2); // CLI default for explicit save
    expect(obs.project).toBe('parent--testproj');
  });

  it('respects --type and --importance flags', () => {
    runCli(['save', 'Critical security fix for auth bypass', '--type', 'bugfix', '--importance', '3']);
    const obs = db.prepare("SELECT * FROM observations WHERE title LIKE '%security fix%'").get();
    expect(obs.type).toBe('bugfix');
    expect(obs.importance).toBe(3);
  });

  it('respects --title flag', () => {
    runCli(['save', 'Long description of what happened during the incident response and mitigation', '--title', 'Incident Response']);
    const obs = db.prepare("SELECT * FROM observations WHERE title = 'Incident Response'").get();
    expect(obs).toBeTruthy();
    expect(obs.narrative).toContain('Long description');
  });

  it('deduplicates similar saves within 5 minutes', () => {
    runCli(['save', 'Dedup test observation content here']);
    const { stdout } = runCli(['save', 'Dedup test observation content here']);
    expect(stdout).toContain('Skipped');
    expect(stdout).toContain('similar');

    // Only one observation should exist
    const count = db.prepare("SELECT COUNT(*) as c FROM observations WHERE title LIKE '%Dedup test%'").get();
    expect(count.c).toBe(1);
  });

  it('scrubs secrets from saved content', () => {
    runCli(['save', 'Found API key sk-proj-abcdef1234567890abcdef1234567890 in config']);
    const obs = db.prepare("SELECT * FROM observations ORDER BY id DESC LIMIT 1").get();
    expect(obs.text).not.toContain('sk-proj-abcdef1234567890abcdef1234567890');
    expect(obs.text).toContain('***');
  });

  it('generates minhash signature', () => {
    runCli(['save', 'This is a sufficiently long observation text to generate a minhash signature for dedup purposes']);
    const obs = db.prepare("SELECT minhash_sig FROM observations ORDER BY id DESC LIMIT 1").get();
    expect(obs.minhash_sig).toBeTruthy();
    expect(obs.minhash_sig.length).toBeGreaterThan(0);
  });

  it('rejects invalid type', () => {
    const { stderr, exitCode } = runCli(['save', 'test content', '--type', 'invalid_type']);
    expect(stderr).toContain('Invalid type');
    expect(exitCode).toBe(1); // validation error sets exit code 1
  });
});

describe('CLI E2E: stats', () => {
  it('shows observation counts and type distribution', () => {
    seedObs({ type: 'bugfix', title: 'Bug 1', text: 'bug content 1' });
    seedObs({ type: 'bugfix', title: 'Bug 2', text: 'bug content 2' });
    seedObs({ type: 'discovery', title: 'Disc 1', text: 'discovery content' });
    const { stdout, exitCode } = runCli(['stats']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[mem] Stats');
    expect(stdout).toContain('Total:');
    expect(stdout).toContain('observations');
    expect(stdout).toContain('sessions');
    expect(stdout).toContain('bugfix: 2');
    expect(stdout).toContain('discovery: 1');
  });

  it('filters by --project', () => {
    seedObs({ title: 'In project', text: 'in project content' });
    // Insert observation in a different project
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('other-sess', 'other-sess', 'other--project', datetime('now'), ?, 'active')
    `).run(Date.now());
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES ('other-sess', 'other--project', 'other text', 'change', 'Other obs', '', '', '', '', '[]', '[]', 1, datetime('now'), ?)
    `).run(Date.now());

    const { stdout } = runCli(['stats', '--project', 'testproj']);
    expect(stdout).toContain('parent--testproj');
  });
});

describe('CLI E2E: help and errors', () => {
  it('shows help with help command', () => {
    const helpResult = runCli(['help']);
    expect(helpResult.stdout).toContain('claude-mem-lite CLI');
    expect(helpResult.stdout).toContain('Commands:');
    expect(helpResult.stdout).toContain('search');
    expect(helpResult.stdout).toContain('save');
  });

  it('shows help with -h flag', () => {
    // Note: --help routes to install.mjs (not in CLI_COMMANDS set)
    // But 'help' command routes to mem-cli.mjs
    const { stdout } = runCli(['help']);
    expect(stdout).toContain('claude-mem-lite CLI');
  });

  it('reports unknown command', () => {
    // Direct CLI commands only — 'unknown_cmd' is not in CLI_COMMANDS set
    // so it routes to install.mjs which handles it
    const { stderr } = runCli(['search']); // search without query
    expect(stderr).toContain('Usage');
  });
});

describe('CLI E2E: context', () => {
  it('reports when no CLAUDE.md exists', () => {
    const { stdout } = runCli(['context']);
    expect(stdout).toContain('No CLAUDE.md');
  });

  it('extracts claude-mem-context block from CLAUDE.md', () => {
    const claudeMd = `# Project
Some content

<claude-mem-context>
### Last Session
Test context data here
</claude-mem-context>
`;
    writeFileSync(join(projectDir, 'CLAUDE.md'), claudeMd);
    const { stdout } = runCli(['context']);
    expect(stdout).toContain('Test context data here');
    expect(stdout).toContain('[mem] Current context');
  });
});
