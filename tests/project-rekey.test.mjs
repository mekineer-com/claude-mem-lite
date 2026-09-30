// D9 part 2: rows a non-ASCII project stored under its OLD id follow it to the new one.
//
// Before D9, ~/projects/博客 and ~/projects/商城 both stored everything as `projects----`. The new
// naming rule gives each its own id, which on its own would strand every existing memory under
// the old, shared one. Rows are moved when their recorded file paths prove which directory
// they belong to; the rest cannot be attributed and stay, and the user is told once where.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { createTestDb, insertObs, insertSession, makeFixtureTracker } from './test-helpers.mjs';
import {
  legacyProjectNameFromDir,
  rekeyLegacyProject,
  legacyIdIsExclusive,
  moveProjectRows,
} from '../lib/project-rekey.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const BLOG = '/home/u/projects/博客';
const SHOP = '/home/u/projects/商城';
const OLD = 'projects----';

function obs(db, title, files, extra = {}) {
  const id = Number(insertObs(db, { project: OLD, title, ...extra }).lastInsertRowid);
  for (const f of files)
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, f);
  return id;
}
const projectOf = (db, id) => db.prepare('SELECT project FROM observations WHERE id = ?').get(id).project;

describe('rekeyLegacyProject', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: OLD });
  });
  afterEach(() => db.close());

  it('premise: both directories had the same old id', () => {
    expect(legacyProjectNameFromDir(BLOG)).toBe(OLD);
    expect(legacyProjectNameFromDir(SHOP)).toBe(OLD);
  });

  it("moves the rows whose files are in this directory, and nobody else's", () => {
    const blog = obs(db, 'blog post layout', [`${BLOG}/src/post.js`]);
    const blogRoot = obs(db, 'blog readme', [BLOG]);
    const shop = obs(db, 'shop cart bug', [`${SHOP}/src/cart.js`]);
    const lookalike = obs(db, 'other blog dir', [`${BLOG}-archive/x.js`]); // prefix, not inside
    const unknown = obs(db, 'relative path only', ['src/post.js']);

    const r = rekeyLegacyProject(db, { dir: BLOG, project: 'projects--博客', legacy: OLD });
    expect(r).toEqual({ moved: 2, left: 3 });
    expect(projectOf(db, blog)).toBe('projects--博客');
    expect(projectOf(db, blogRoot)).toBe('projects--博客');
    for (const id of [shop, lookalike, unknown]) expect(projectOf(db, id)).toBe(OLD);
  });

  it('keeps a compression cluster in one project', () => {
    const keeper = obs(db, 'blog keeper', []);
    const member = obs(db, 'blog member', [`${BLOG}/a.js`], { compressedInto: keeper });
    const sibling = obs(db, 'blog member 2', [], { compressedInto: keeper });
    rekeyLegacyProject(db, { dir: BLOG, project: 'projects--博客', legacy: OLD });
    for (const id of [keeper, member, sibling]) expect(projectOf(db, id)).toBe('projects--博客');
  });

  it('treats LIKE metacharacters in the directory literally', () => {
    const odd = obs(db, 'odd', ['/w/a_b%/x.js']);
    const other = obs(db, 'other', ['/w/aXbYZ/x.js']);
    rekeyLegacyProject(db, { dir: '/w/a_b%', project: 'w--a_b-', legacy: OLD });
    expect(projectOf(db, odd)).toBe('w--a_b-');
    expect(projectOf(db, other)).toBe(OLD);
  });

  it('does not take a directory whose path differs only in ASCII case (SQLite LIKE would)', () => {
    const upper = obs(db, 'upper-case sibling', ['/home/A/projects/博客/x.js']);
    const mine = obs(db, 'mine', ['/home/a/projects/博客/y.js']);
    rekeyLegacyProject(db, { dir: '/home/a/projects/博客', project: 'projects--博客', legacy: OLD });
    expect(projectOf(db, mine)).toBe('projects--博客');
    expect(projectOf(db, upper)).toBe(OLD);
  });

  it('matches Windows paths stored with backslashes against a forward-slash directory', () => {
    const win = obs(db, 'win', ['C:\\Users\\u\\projects\\博客\\x.js']);
    const other = obs(db, 'shop', ['C:\\Users\\u\\projects\\商城\\y.js']);
    const dir = 'C:/Users/u/projects/博客';
    expect(legacyIdIsExclusive(db, { dir, legacy: OLD })).toBe(false); // the 商城 row is a sibling
    rekeyLegacyProject(db, { dir, project: 'projects--博客', legacy: OLD });
    expect(projectOf(db, win)).toBe('projects--博客');
    expect(projectOf(db, other)).toBe(OLD);
  });

  it('matches a path the OS spelled decomposed', () => {
    const nfd = '/w/cafe\u0301';
    const id = obs(db, 'cafe', [`${nfd}/x.js`], { project: 'w--caf--' });
    rekeyLegacyProject(db, { dir: '/w/caf\u00e9', project: 'w--caf\u00e9', legacy: 'w--caf--' });
    expect(projectOf(db, id)).toBe('w--caf\u00e9');
  });
});

describe('an old id only this directory used', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: OLD });
  });
  afterEach(() => db.close());
  const defer = (title) =>
    db
      .prepare(
        `INSERT INTO deferred_work (project, title, priority, status, created_at_epoch)
         VALUES (?, ?, 2, 'open', ?)`,
      )
      .run(OLD, title, Date.now());

  it('is exclusive when no stored path belongs to another directory with the same old id', () => {
    obs(db, 'blog', [`${BLOG}/src/post.js`]);
    obs(db, 'outside every project', ['/etc/hosts', '/home/u/.bashrc']);
    obs(db, 'no path', []);
    expect(legacyIdIsExclusive(db, { dir: BLOG, legacy: OLD })).toBe(true);
    obs(db, 'shop', [`${SHOP}/src/cart.js`]); // a sibling with the same old id
    expect(legacyIdIsExclusive(db, { dir: BLOG, legacy: OLD })).toBe(false);
  });

  it('is not exclusive once a sibling has moved off the same old id (its new id maps back to it)', () => {
    obs(db, 'shop', [`${SHOP}/src/cart.js`]);
    expect(legacyIdIsExclusive(db, { dir: SHOP, legacy: OLD, project: 'projects--商城' })).toBe(true); // premise
    insertSession(db, { id: 'blog-sess', project: 'projects--博客' }); // 博客 already re-keyed
    expect(legacyIdIsExclusive(db, { dir: SHOP, legacy: OLD, project: 'projects--商城' })).toBe(false);
  });

  it('reads backslash paths as Windows paths', () => {
    obs(db, 'win blog', ['C:\\Users\\u\\projects\\博客\\x.js']);
    expect(legacyIdIsExclusive(db, { dir: 'C:/Users/u/projects/博客', legacy: OLD })).toBe(true);
    expect(legacyIdIsExclusive(db, { dir: 'C:\\Users\\u\\projects\\博客', legacy: OLD })).toBe(true);
  });

  it('then moves everything stored under it: sessions, summaries, deferred items, not only memories', () => {
    obs(db, 'blog', [`${BLOG}/src/post.js`]);
    obs(db, 'no path', []);
    defer('finish the archive page');
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
       VALUES ('sess-1', ?, 'last request', datetime('now'), ?)`,
    ).run(OLD, Date.now());
    const r = moveProjectRows(db, { from: OLD, to: 'projects--博客' });
    expect(r.moved).toBe(2);
    for (const t of ['observations', 'sdk_sessions', 'session_summaries', 'deferred_work']) {
      expect(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project = ?`).get(OLD).n, t).toBe(0);
      expect(
        db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project = ?`).get('projects--博客').n,
        t,
      ).toBeGreaterThan(0);
    }
  });
});

describe('at SessionStart', () => {
  let home, dir;
  beforeEach(() => {
    const root = fixtures.track(join(tmpdir(), `mem-rekey-${randomUUID().slice(0, 8)}`));
    home = join(root, 'home');
    dir = join(root, 'projects', '博客');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    initSchema(db);
    insertSession(db, { id: 'sess-1', project: OLD });
    const id = Number(insertObs(db, { project: OLD, title: 'blog layout lesson' }).lastInsertRowid);
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, `${dir}/post.js`);
    insertObs(db, { project: OLD, title: 'unattributable' });
    // A sibling that shared the old id (商城 → projects---- too): the old id is not this one's alone.
    const shop = Number(insertObs(db, { project: OLD, title: 'shop cart lesson' }).lastInsertRowid);
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(
      shop,
      join(dirname(dir), '商城', 'cart.js'),
    );
    db.close();
  });

  const start = (d = dir) =>
    execFileSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      input: JSON.stringify({ session_id: 'cc-1', source: 'startup', cwd: d }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: d,
        CLAUDE_MEM_HOOK_RUNNING: '',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        CLAUDE_MEM_SKIP_COMPRESS: '1',
        CLAUDE_MEM_SKIP_OPTIMIZE: '1',
        CLAUDE_MEM_SKIP_SUMMARY: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
      encoding: 'utf8',
      timeout: 20000,
    });

  it('moves the attributable rows once and tells the user once', () => {
    const first = start();
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), { readonly: true });
    const rows = db.prepare('SELECT title, project FROM observations ORDER BY id').all();
    db.close();
    expect(rows).toEqual([
      { title: 'blog layout lesson', project: 'projects--博客' },
      { title: 'unattributable', project: OLD },
      { title: 'shop cart lesson', project: OLD },
    ]);
    expect(first).toContain('projects--博客');
    expect(first).toContain(`--project ${OLD}`);
    expect(
      readdirSync(join(home, '.claude-mem-lite', 'runtime')).some((f) => f.startsWith('.project-rekeyed-')),
    ).toBe(true);
    expect(start()).not.toContain(`--project ${OLD}`);
  });

  // Delta review P2-1: 博客 moves its path-proven rows first, which removes the only path evidence
  // of 博客 from the old id; 商城 then saw "no other directory" and took 博客's pathless memories
  // and deferred items.
  it("a second sibling does not take the first one's leftovers", () => {
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    insertObs(db, { project: OLD, title: 'blog pathless lesson' });
    db.prepare(
      `INSERT INTO deferred_work (project, title, priority, status, created_at_epoch) VALUES (?, 'BLOG todo', 2, 'open', ?)`,
    ).run(OLD, Date.now());
    db.close();
    start(); // 博客: path-proven move only (商城's path is there)
    const shop = join(dirname(dir), '商城');
    mkdirSync(shop, { recursive: true });
    start(shop);
    const ro = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), { readonly: true });
    const blogLeft = ro
      .prepare("SELECT project FROM observations WHERE title = 'blog pathless lesson'")
      .get().project;
    const todo = ro.prepare("SELECT project FROM deferred_work WHERE title = 'BLOG todo'").get().project;
    const shopRow = ro
      .prepare("SELECT project FROM observations WHERE title = 'shop cart lesson'")
      .get().project;
    ro.close();
    expect([blogLeft, todo]).toEqual([OLD, OLD]); // still where 博客's notice says to look
    expect(shopRow).toBe('projects--商城'); // 商城 still takes its own, by path
  });

  it('takes everything, deferred items included, when the old id was this directory alone', () => {
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    db.prepare("DELETE FROM observations WHERE title = 'shop cart lesson'").run();
    db.prepare(
      `INSERT INTO deferred_work (project, title, priority, status, created_at_epoch)
       VALUES (?, 'finish the archive page', 2, 'open', ?)`,
    ).run(OLD, Date.now());
    db.close();
    const out = start();
    const ro = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), { readonly: true });
    const left = ['observations', 'deferred_work', 'sdk_sessions'].map(
      (t) => ro.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project = ?`).get(OLD).n,
    );
    ro.close();
    expect(left).toEqual([0, 0, 0]);
    expect(out).toContain('projects--博客');
    expect(out).not.toContain(`--project ${OLD}`); // nothing stayed behind to point at

    // A sibling that opens afterwards finds its old id empty: nothing moved, so no notice
    // (it used to say "Moved everything stored under the old id (0 memories …)").
    const shop = join(dirname(dir), '商城');
    mkdirSync(shop, { recursive: true });
    expect(start(shop)).not.toContain('now has its own id');
  });
});
