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

  it('OR fallback prints a "relaxed AND→OR" hint so callers know the match is loose', () => {
    seedObs({ title: 'Alpha protocol fix', text: 'alpha protocol implementation repair' });
    const { stdout } = runCli(['search', 'alpha zzzzz_nonexistent']);
    expect(stdout).toMatch(/relaxed AND.{0,3}OR/);
  });

  it('no fallback hint when AND match succeeds', () => {
    seedObs({ title: 'Alpha protocol fix', text: 'alpha protocol implementation repair' });
    const { stdout } = runCli(['search', 'alpha protocol']);
    expect(stdout).toContain('Alpha protocol fix');
    expect(stdout).not.toMatch(/relaxed AND.{0,3}OR/);
  });

  it('no fallback hint when user explicitly passes --or', () => {
    seedObs({ title: 'Alpha protocol fix', text: 'alpha protocol implementation repair' });
    const { stdout } = runCli(['search', 'alpha zzzzz_nonexistent', '--or']);
    expect(stdout).toContain('Alpha protocol fix');
    expect(stdout).not.toMatch(/relaxed AND.{0,3}OR/);
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

  it('hides hook-llm fallback titles by default but surfaces with --include-noise', () => {
    seedObs({
      type: 'bugfix', title: 'Real fix for parser regression',
      filesModified: '["src/parser.mjs"]', lessonLearned: 'Catch trailing-whitespace edge case',
    });
    seedObs({
      type: 'change', title: 'Modified src/parser.mjs',
      filesModified: '["src/parser.mjs"]',
    });

    const def = runCli(['recall', 'parser.mjs']);
    expect(def.exitCode).toBe(0);
    expect(def.stdout).toContain('Real fix for parser regression');
    expect(def.stdout).not.toContain('Modified src/parser.mjs');

    const noisy = runCli(['recall', 'parser.mjs', '--include-noise']);
    expect(noisy.exitCode).toBe(0);
    expect(noisy.stdout).toContain('Real fix for parser regression');
    expect(noisy.stdout).toContain('Modified src/parser.mjs');
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
    expect(stderr).toMatch(/No records found.*\[obs\]/);
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

describe('CLI E2E: --json output for listing commands (Tier 2)', () => {
  it('recent --json emits parseable shape with project/limit/total/results', () => {
    seedObs({ title: 'Json recent A', text: 'a', importance: 2 });
    seedObs({ title: 'Json recent B', text: 'b', importance: 3, epochOffset: -60000 });

    const { stdout, exitCode } = runCli(['recent', '5', '--json']);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.project).toBe('parent--testproj');
    expect(data.limit).toBe(5);
    expect(data.total).toBe(2);
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toHaveProperty('id');
    expect(data.results[0]).toHaveProperty('type');
    expect(data.results[0]).toHaveProperty('title');
    expect(data.results[0]).toHaveProperty('importance');
    expect(data.results[0]).toHaveProperty('created_at_epoch');
    expect(typeof data.results[0].created_at_epoch).toBe('number');
  });

  it('recent --json emits empty form when no observations', () => {
    const { stdout } = runCli(['recent', '5', '--json'], {
      env: { CLAUDE_PROJECT_DIR: join(tmpHome, 'other', 'empty') },
    });
    const data = JSON.parse(stdout);
    expect(data.results).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('recall --json includes file/include_noise/results with lesson_learned', () => {
    seedObs({
      title: 'Json recall hit', text: 'r1',
      filesModified: '["lib/json-target.mjs"]', lessonLearned: 'lesson body',
    });

    const { stdout, exitCode } = runCli(['recall', 'json-target.mjs', '--json']);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.file).toBe('json-target.mjs');
    expect(data.include_noise).toBe(false);
    expect(data.total).toBe(1);
    expect(data.results[0].lesson_learned).toBe('lesson body');
  });

  it('recall --json empty form for unknown file', () => {
    const { stdout } = runCli(['recall', 'nonexistent_xyz.ts', '--json']);
    const data = JSON.parse(stdout);
    expect(data.total).toBe(0);
    expect(data.results).toEqual([]);
  });

  it('timeline --anchor --json emits anchor + before + after', () => {
    for (let i = 0; i < 5; i++) {
      seedObs({ title: `TL ${i}`, text: `t${i}`, epochOffset: -((4 - i) * 60000) });
    }
    const rows = db.prepare('SELECT id FROM observations ORDER BY created_at_epoch ASC').all();
    const anchorId = rows[2].id;

    const { stdout, exitCode } = runCli(['timeline', '--anchor', String(anchorId), '--before', '1', '--after', '1', '--json']);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.anchor.id).toBe(anchorId);
    expect(data.before).toHaveLength(1);
    expect(data.after).toHaveLength(1);
    expect(data.anchor_note).toBeNull();
  });

  it('timeline --json fallback shape when query has no anchor', () => {
    seedObs({ title: 'TL fallback', text: 'fb', epochOffset: -60000 });
    const { stdout } = runCli(['timeline', '--query', 'definitelyNoSuchTermZZZQQQ', '--json']);
    const data = JSON.parse(stdout);
    expect(data.anchor).toBeNull();
    expect(data.fallback).toBe('recent');
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('browse --json emits totals + per-tier counts and results', () => {
    seedObs({ title: 'Browse A', text: 'a' });
    seedObs({ title: 'Browse B', text: 'b' });

    const { stdout, exitCode } = runCli(['browse', '--json', '--limit', '2']);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.project).toBe('parent--testproj');
    expect(data.totals).toHaveProperty('grand_total');
    expect(data.tiers).toHaveProperty('working');
    expect(data.tiers).toHaveProperty('active');
    expect(data.tiers).toHaveProperty('archive');
    expect(data.tiers.working).toHaveProperty('count');
    expect(data.tiers.working).toHaveProperty('results');
  });

  it('browse --tier --json scopes to one tier in the totals + tiers shape', () => {
    seedObs({ title: 'Working tier obs', text: 'w' });
    const { stdout } = runCli(['browse', '--tier', 'working', '--json', '--limit', '5']);
    const data = JSON.parse(stdout);
    expect(data.tier_filter).toBe('working');
    expect(data.tiers.working).toBeTruthy();
    expect(data.tiers.active).toBeUndefined();
    expect(data.tiers.archive).toBeUndefined();
  });

  it('stats --json emits the nested-by-section shape', () => {
    seedObs({ type: 'bugfix', title: 'Bug A', text: 'ba' });
    seedObs({ type: 'decision', title: 'Dec A', text: 'da' });

    const { stdout, exitCode } = runCli(['stats', '--days', '30', '--json']);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.days).toBe(30);
    expect(data.totals).toHaveProperty('observations');
    expect(data.totals).toHaveProperty('sessions');
    expect(data.recent).toHaveProperty('observations');
    expect(data.type_distribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'bugfix' }),
      expect.objectContaining({ type: 'decision' }),
    ]));
    expect(data.data_health).toHaveProperty('noise_ratio');
    expect(data.tier_distribution).toHaveProperty('working');
  });

  it('JSON_SUPPORTED_CMDS extension: no stderr "not supported" note for the 5 cmds', () => {
    seedObs({ title: 'No-warning probe', text: 'p' });
    const { stderr } = runCli(['recent', '1', '--json']);
    expect(stderr).not.toContain('--json is supported only on');
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
    // cli.mjs short-circuits --help / -h to mem-cli.mjs run(['help']).
    const { stdout } = runCli(['help']);
    expect(stdout).toContain('claude-mem-lite CLI');
  });

  it('reports unknown command', () => {
    // Unknown commands hit the final branch in cli.mjs: stderr "Unknown command"
    // + Levenshtein suggestion + exit 1. (search without a query is a separate
    // usage-error path inside mem-cli.mjs.)
    const { stderr: missingQuery } = runCli(['search']);
    expect(missingQuery).toContain('Usage');
    const { stderr: unknown, exitCode } = runCli(['not_a_real_cmd_xyzzy']);
    expect(unknown).toContain('Unknown command');
    expect(exitCode).toBe(1);
  });
});

// Regression: v2.32.3 shipped cli.mjs with 'adopt' and 'unadopt' missing from
// CLI_COMMANDS, so `claude-mem-lite adopt` fell through to the unknown-command
// branch and `/adopt` was broken for installed users. Lock this via E2E.
describe('CLI E2E: adopt / unadopt routing', () => {
  it('adopt is routed by cli.mjs (not unknown-command)', () => {
    const { stdout, stderr, exitCode } = runCli(['adopt', '--dry-run'], {
      env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projectDir },
    });
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('Unknown command');
    expect(stdout).toContain('[adopt --dry-run]');
  });

  it('unadopt is routed by cli.mjs (not unknown-command)', () => {
    const { stderr, exitCode } = runCli(['unadopt'], {
      env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projectDir },
    });
    // Never-adopted memdir → benign no-op, exit 0, no routing error
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('Unknown command');
  });

  it('help output advertises adopt and unadopt', () => {
    const { stdout, exitCode } = runCli(['help']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\s*adopt\b/m);
    expect(stdout).toMatch(/^\s*unadopt\b/m);
  });
});

// Regression: v2.71.0 shipped cli.mjs without 'import-jsonl' in CLI_COMMANDS,
// so `claude-mem-lite import-jsonl …` fell through to the unknown-command
// branch even though help and the mem-cli switch case both existed (#8414).
// tests/import-jsonl.test.mjs invokes importJsonl() directly and missed it.
// Lock CLI routing here.
describe('CLI E2E: import-jsonl routing', () => {
  it('import-jsonl is routed by cli.mjs (not unknown-command)', () => {
    const emptyDir = join(tmpHome, 'empty-jsonl-dir');
    mkdirSync(emptyDir, { recursive: true });
    const { stdout, stderr, exitCode } = runCli(['import-jsonl', emptyDir]);
    expect(stderr).not.toContain('Unknown command');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No .jsonl files found');
  });

  it('import-jsonl without args prints Usage (not Unknown command)', () => {
    const { stderr, exitCode } = runCli(['import-jsonl']);
    expect(stderr).not.toContain('Unknown command');
    expect(stderr).toContain('Usage');
    expect(exitCode).toBe(1);
  });

  it('help output advertises import-jsonl', () => {
    const { stdout, exitCode } = runCli(['help']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\s*import-jsonl\b/m);
  });
});

describe('CLI E2E: context', () => {
  it('reports empty context for a project with no DB data', () => {
    // Pre-v2.30 this asserted a "No CLAUDE.md" error. Post-v2.30 the command
    // generates context live from DB and simply reports no data.
    const { stdout } = runCli(['context', '--project', 'mem-cli-e2e-empty']);
    expect(stdout).toContain('No context yet');
  });

  it('generates context block live from DB, ignoring any CLAUDE.md file', () => {
    // Seed DB with a session summary for the default E2E project
    const db = new Database(join(dataDir, 'claude-mem-lite.db'));
    const now = Date.now();
    const sessionId = `cli-e2e-ctx-${randomUUID().slice(0, 8)}`;
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'mem-cli-e2e-ctx', ?, ?, 'completed')
    `).run(sessionId, sessionId, new Date(now).toISOString(), now);
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'mem-cli-e2e-ctx', 'DB-derived request', 'DB-derived completed', 'DB-derived next', ?, ?)
    `).run(sessionId, new Date(now).toISOString(), now);
    db.close();

    // Write a CLAUDE.md with a DIFFERENT context — the CLI must ignore it
    const claudeMd = `# Project
Some content

<claude-mem-context>
### Last Session
Stale file-derived data that MUST NOT appear
</claude-mem-context>
`;
    writeFileSync(join(projectDir, 'CLAUDE.md'), claudeMd);

    const { stdout } = runCli(['context', '--project', 'mem-cli-e2e-ctx']);
    expect(stdout).toContain('<claude-mem-context>');
    expect(stdout).toContain('DB-derived request');
    expect(stdout).toContain('DB-derived completed');
    expect(stdout).not.toContain('Stale file-derived data');
  });
});

// ─── Round 2 audit regressions ───────────────────────────────────────────────

describe('registry bare value-less flag (Round2-P1)', () => {
  // Pre-fix: a bare `--name` parsed to boolean true, slipped past `if (!name||...)`,
  // and reached the SQLite bind → raw "TypeError: SQLite3 can only bind..." stacktrace.
  it('registry import rejects bare --name instead of crashing on SQLite bind', () => {
    const { stderr, exitCode } = runCli(['registry', 'import', '--name', '--resource-type', 'skill']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('requires a value');
    expect(stderr).not.toContain('TypeError');
  });

  it('registry remove rejects bare --name instead of crashing on SQLite bind', () => {
    const { stderr, exitCode } = runCli(['registry', 'remove', '--name', '--resource-type', 'skill']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('requires a value');
    expect(stderr).not.toContain('TypeError');
  });
});

describe('doctor --json routing (Round2-P1)', () => {
  // Pre-fix: cli.mjs forwarded ANY flagged `doctor --X` to the DB-layer cmdDoctor,
  // which rejected plain --json ("supported flags") — shadowing install.mjs's
  // documented health-check JSON. HOME override keeps install.mjs in the temp dir.
  it('doctor --json emits the install health JSON, not the "supported flags" error', () => {
    const { stdout } = runCli(['doctor', '--json'], { env: { HOME: tmpHome } });
    expect(stdout).not.toContain('supported flags');
    expect(stdout).toMatch(/"(checks|summary|issues)"/);
    // The emitted JSON must actually parse.
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });

  it('doctor --benchmark still routes to the DB-layer handler', () => {
    const { stdout } = runCli(['doctor', '--benchmark']);
    expect(stdout).not.toContain('supported flags');
  });
});

describe('import-jsonl all-skipped warning (Round2-P2)', () => {
  // Pre-fix: pointing import-jsonl at a non-transcript file (e.g. `export` output)
  // skipped every line and exited 0 with no signal — a silent no-op that read as success.
  it('warns when every line is skipped (wrong file format)', () => {
    const badPath = join(tmpHome, 'not-a-transcript.jsonl');
    writeFileSync(badPath, '{"id":1,"type":"bugfix","title":"x"}\n{"id":2,"type":"decision","title":"y"}\n');
    const { stdout, exitCode } = runCli(['import-jsonl', badPath, '--project', 'p']);
    expect(exitCode).toBe(0); // graceful, not a crash
    expect(stdout).toMatch(/0 imported/);
    expect(stdout).toMatch(/none matched/i);
  });
});
