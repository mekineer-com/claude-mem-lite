// Issue #39 — `hook.mjs user-prompt` (path B, the <memory-context> blocks) must not search on a
// prompt that carries no topic by construction. Path A (scripts/user-prompt-search.js) has
// rejected these shapes since v2.43 through `shouldSkip`; path B ran both of its arms on them,
// so `continue`, `继续` or a bare slash command pulled whatever row happened to share the word.
// The events arm also had no length floor of its own, so `1` reached the events search.
//
// Every "emits nothing" case carries a PREMISE: the same prompt, handed straight to the two
// search functions path B calls, returns rows. Without it a case would pass on a corpus that
// simply does not match, which proves nothing about the gate.
//
// Spawned hook, hermetic sandbox: HOME + CLAUDE_PROJECT_DIR inside mkdtemp, every
// CLAUDE_MEM_/MEM_ variable stripped, no LLM binary.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { saveEvent } from '../lib/activity.mjs';
import { keyContextIdsFileName } from '../lib/injected-ids.mjs';
import { searchRelevantMemories } from '../hook-memory.mjs';
import { searchInjectableEvents } from '../lib/events-injection.mjs';
import { upsFtsQuery } from '../lib/ups-query.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');
const CC_SESSION = 'cc-ups-b';
const PROJECT = 'upsb--proj';

let BASE_ENV;

beforeAll(() => {
  BASE_ENV = { ...process.env };
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    CLAUDE_CODE_PATH: join(tmpdir(), 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
    MEM_QUIET_HOOKS: '1',
    MEM_NO_AUTO_ADOPT: '1',
  });
  delete BASE_ENV.CLAUDE_PROJECT_DIR;
  delete BASE_ENV.PWD;
});

describe('path B front door (issue #39)', () => {
  let tmpHome, projDir, dbPath, runtimeDir;
  const ids = {};

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-upsb-'));
    projDir = join(tmpHome, 'upsb', 'proj');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(tmpHome, '.claude-mem-lite');
    runtimeDir = join(dbDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    dbPath = join(dbDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (?, 'upsb-mem', ?, ?, ?, 'active')`,
    ).run(CC_SESSION, PROJECT, new Date(now).toISOString(), now);
    const obs = (key, title, narrative, minutesAgo) => {
      const epoch = now - minutesAgo * 60000;
      ids[key] = Number(
        db
          .prepare(
            `INSERT INTO observations (memory_session_id, project, type, title, narrative, lesson_learned,
               importance, compressed_into, created_at, created_at_epoch)
             VALUES ('upsb-mem', ?, 'decision', ?, ?, ?, 2, 0, ?, ?)`,
          )
          .run(PROJECT, title, narrative, narrative, new Date(epoch).toISOString(), epoch).lastInsertRowid,
      );
    };
    obs('deploy', 'Continue deployment only after the health check', 'continue deployment health check', 5);
    obs('cjk', '继续 部署 之前 先做 健康 检查', '继续 部署 健康 检查', 6);
    obs('release', '发版 前 先跑 ci 环境 测试', '发版 release checklist', 7);
    obs('converge', 'converge ledger deploy round', '/converge deploy runs one ledger round', 8);
    obs('push', 'git push origin main rejected by branch protection', 'git push origin main', 9);
    obs('stop', 'why the stop hook fires once per turn', 'why stop fires once per turn', 10);
    const ev = (key, title, body, minutesAgo) => {
      ids[key] = saveEvent(db, {
        project: PROJECT,
        event_type: 'bugfix',
        title,
        body,
        importance: 2,
        created_at_epoch: now - minutesAgo * 60000,
      });
    };
    ev('evDeploy', 'Continue command repeats stale deployment error', 'continue deployment health check', 5);
    ev('evOk', 'ok status from the health check is not proof', 'ok', 6);
    ev('evNext', 'next release checklist item', 'next', 7);
    ev('evOne', 'step 1 of the release checklist', 'step 1 recapture the baseline', 8);
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function fire(prompt) {
    return execFileSync(process.execPath, [HOOK_PATH, 'user-prompt'], {
      input: JSON.stringify({ session_id: CC_SESSION, prompt }),
      timeout: 20000,
      encoding: 'utf8',
      env: { ...BASE_ENV, HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir, CLAUDE_MEM_HOOK_RUNNING: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  // What path B's two searches return for this prompt, with no gate in front of them.
  function ungated(prompt) {
    const db = new Database(dbPath, { readonly: true });
    try {
      return {
        obs: searchRelevantMemories(db, prompt, PROJECT, [], { counterfactual: true }).map((r) => r.id),
        ev: searchInjectableEvents(db, { ftsQuery: upsFtsQuery(prompt), project: PROJECT }).map((r) => r.id),
      };
    } finally {
      db.close();
    }
  }

  it('control: a topical prompt reaches both arms (the injection path fires in this sandbox)', () => {
    const out = fire('deployment health check');
    expect(out).toContain('<memory-context relevance="high">');
    expect(out).toContain(`(#${ids.deploy})`);
    expect(out).toContain('<memory-context relevance="events">');
    expect(out).toContain(`E#${ids.evDeploy}`);
  });

  // FAILS IF: path B runs either arm on a no-topic shape — the pre-fix behaviour, where every
  // one of these emitted at least one block.
  it.each([
    ['continue', 'continuation'],
    ['继续', 'CJK continuation'],
    ['ok', 'confirmation'],
    ['next', 'continuation'],
    ['/converge deploy', 'slash command'],
    ['git push origin main', 'pure operation'],
    ['why did you stop', 'meta-pause question'],
  ])('%s (%s) emits no <memory-context> block, although the searches would match', (prompt) => {
    const premise = ungated(prompt);
    expect(premise.obs.length + premise.ev.length, 'premise: the corpus matches this prompt').toBeGreaterThan(
      0,
    );
    expect(fire(prompt)).not.toContain('<memory-context');
  });

  // FAILS IF: the events arm loses the length floor the observation arm applies. `1` is not a
  // shape, so it isolates the floor from the shape gate.
  it('`1` reaches neither arm: the events search now shares the observation floor', () => {
    const premise = ungated('1');
    expect(premise.obs, 'premise: the observation arm already floors `1`').toEqual([]);
    expect(premise.ev, 'premise: the events search alone matches `1`').toContain(ids.evOne);
    expect(fire('1')).not.toContain('<memory-context');
  });

  // FAILS IF: the fix borrows path A's CJK-weighted length gate. Path B admits 2-char CJK on
  // purpose (hook-memory.mjs searchRelevantMemories), and 发版 is not a shape.
  it('发版 still reaches the observation arm: path B keeps its 2-char CJK floor', () => {
    const out = fire('发版');
    expect(out).toContain('<memory-context relevance="high">');
    expect(out).toContain(`(#${ids.release})`);
  });

  // FAILS IF: the gate moves above the Key Context marker read. The marker's lifetime is
  // "24h with no prompt in this session", and a shape prompt is still a prompt.
  it('a shape prompt still stamps the Key Context marker', () => {
    const marker = join(runtimeDir, keyContextIdsFileName(PROJECT, CC_SESSION));
    writeFileSync(marker, JSON.stringify({ ids: [], session: CC_SESSION }));
    const old = new Date(Date.now() - 6 * 3600 * 1000);
    utimesSync(marker, old, old);
    fire('继续');
    expect(statSync(marker).mtimeMs).toBeGreaterThan(old.getTime() + 60000);
  });
});
