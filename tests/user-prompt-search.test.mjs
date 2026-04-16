// Tests for scripts/user-prompt-search.js — auto-search hook on user prompt
// Since the script runs main() on import and reads from stdin, we test via:
// 1. Subprocess execution with stdin piping (integration tests)
// 2. Direct imports from prompt-search-utils.mjs (unit tests — no more code duplication)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { unlinkSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { sanitizeFtsQuery, relaxFtsQueryToOr } from '../utils.mjs';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { ensureRegistryDb } from '../registry.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { typeIcon, truncate } from '../utils.mjs';
import {
  shouldSkip,
  computeEffectiveLen,
  detectIntent,
  shouldSkipByDedup,
  extractFiles,
  extractErrorSignature,
  matchRegistrySkillName,
} from '../scripts/prompt-search-utils.mjs';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/user-prompt-search.js');

// ─── Unit Tests: Skip Patterns ───────────────────────────────────────────────

describe('shouldSkip', () => {
  it('skips empty/null/undefined text', () => {
    expect(shouldSkip('')).toBe(true);
    expect(shouldSkip(null)).toBe(true);
    expect(shouldSkip(undefined)).toBe(true);
  });

  it('skips short messages (< 8 chars)', () => {
    expect(shouldSkip('hello')).toBe(true);
    expect(shouldSkip('fix it')).toBe(true);
    expect(shouldSkip('1234567')).toBe(true);
  });

  it('does not skip messages >= 8 chars', () => {
    expect(shouldSkip('12345678')).toBe(false);
    expect(shouldSkip('fix the login bug please')).toBe(false);
  });

  it('skips English confirmation words', () => {
    for (const word of ['yes', 'no', 'ok', 'done', 'go', 'sure', 'lgtm', 'thanks', 'ty']) {
      expect(shouldSkip(word)).toBe(true);
    }
  });

  it('skips Chinese confirmation words', () => {
    for (const word of ['继续', '确认', '好的', '是的', '对', '嗯', '行', '可以', '没问题']) {
      expect(shouldSkip(word)).toBe(true);
    }
  });

  it('skips slash commands', () => {
    expect(shouldSkip('/commit')).toBe(true);
    expect(shouldSkip('/help')).toBe(true);
    expect(shouldSkip('/review-pr 123')).toBe(true);
  });

  it('skips pure operations', () => {
    expect(shouldSkip('git commit -m "fix"')).toBe(true);
    expect(shouldSkip('git push origin main')).toBe(true);
    expect(shouldSkip('npm publish --access public')).toBe(true);
  });

  it('does not skip normal prompts', () => {
    expect(shouldSkip('How do I fix the authentication error?')).toBe(false);
    expect(shouldSkip('Refactor the database module')).toBe(false);
    expect(shouldSkip('为什么这个测试一直失败？')).toBe(false);
  });
});

// ─── Unit Tests: computeEffectiveLen (v2.34.4) ──────────────────────────────
// Exported so downstream gates (PROMPT_MIN_LENGTH in user-prompt-search.js)
// can weight CJK the same way `shouldSkip` does. Latin char = 1 unit,
// CJK char = 3 units. See `prompt-search-utils.mjs:computeEffectiveLen`.

describe('computeEffectiveLen', () => {
  it('returns 0 for empty / null / undefined', () => {
    expect(computeEffectiveLen('')).toBe(0);
    expect(computeEffectiveLen(null)).toBe(0);
    expect(computeEffectiveLen(undefined)).toBe(0);
  });

  it('counts Latin chars at 1 unit each', () => {
    expect(computeEffectiveLen('fix a bug now')).toBe(13); // 13 chars
    expect(computeEffectiveLen('hello world')).toBe(11);
  });

  it('counts CJK chars at 3 units each', () => {
    expect(computeEffectiveLen('优化')).toBe(6);       // 2 CJK × 3
    expect(computeEffectiveLen('性能降低延迟')).toBe(18); // 6 CJK × 3
  });

  it('weights mixed CJK / Latin / whitespace correctly', () => {
    // "优化 hook 性能降低延迟": 8 CJK + 4 Latin + 2 spaces = 8*3 + 6 = 30
    expect(computeEffectiveLen('优化 hook 性能降低延迟')).toBe(30);
  });

  it('covers the CJK extension A block', () => {
    // U+3400 is in the extension A range; should still count as CJK
    expect(computeEffectiveLen('\u3400\u3401')).toBe(6);
  });
});

// ─── Unit Tests: Intent Detection ────────────────────────────────────────────

describe('detectIntent', () => {
  it('detects bugfix intent from error keywords', () => {
    expect(detectIntent('There is an error in the login module')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('How to fix this bug?')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('The app crashed on startup')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('这个函数报错了')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('修复编译错误')).toHaveProperty('type', 'bugfix');
    // Extended CJK bugfix coverage (mined from real prompts)
    expect(detectIntent('这个函数不工作了')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('搜索有问题')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('服务挂了')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('排查一下为什么失败')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('帮我诊断一下这个问题')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('定位到哪里出错了')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('异常处理有问题')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('解决这个报错')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('发现问题就修复问题')).toHaveProperty('type', 'bugfix');
  });

  it('detects recall intent from history keywords', () => {
    const intent = detectIntent('What did we do before with the cache?');
    expect(intent).toHaveProperty('useRecent', true);
    expect(intent.type).toBeNull();

    expect(detectIntent('之前怎么处理的？')).toHaveProperty('useRecent', true);
    expect(detectIntent('What happened last time with the deployment?')).toHaveProperty('useRecent', true);
    expect(detectIntent('上次是怎么做的？')).toHaveProperty('useRecent', true);
    // Extended CJK recall coverage
    expect(detectIntent('刚才做了什么')).toHaveProperty('useRecent', true);
    expect(detectIntent('回顾一下历史')).toHaveProperty('useRecent', true);
    // B (v2.32.8): spoken-CN recall patterns
    expect(detectIntent('这个问题碰到过没')).toHaveProperty('useRecent', true);
    expect(detectIntent('这种情况我遇到过')).toHaveProperty('useRecent', true);
    expect(detectIntent('这段代码见过')).toHaveProperty('useRecent', true);
    expect(detectIntent('是不是同样的问题')).toHaveProperty('useRecent', true);
    expect(detectIntent('这是类似的问题吗')).toHaveProperty('useRecent', true);
    expect(detectIntent('have we seen this before in the repo')).toHaveProperty('useRecent', true);
    expect(detectIntent('is this the same issue as last week')).toHaveProperty('useRecent', true);
  });

  it('detects decision intent from architecture keywords', () => {
    expect(detectIntent('Why did we choose PostgreSQL?')).toHaveProperty('type', 'decision');
    expect(detectIntent('What was the architecture decision?')).toHaveProperty('type', 'decision');
    expect(detectIntent('为什么选择这个架构？')).toHaveProperty('type', 'decision');
    expect(detectIntent('这个设计决定是怎么来的？')).toHaveProperty('type', 'decision');
    // Extended CJK decision coverage
    expect(detectIntent('当时的考虑是什么')).toHaveProperty('type', 'decision');
    expect(detectIntent('有什么权衡')).toHaveProperty('type', 'decision');
    expect(detectIntent('这个方案的原因')).toHaveProperty('type', 'decision');
    expect(detectIntent('思路是什么')).toHaveProperty('type', 'decision');
  });

  it('detects review/audit intent (new)', () => {
    expect(detectIntent('审查一下代码')).toHaveProperty('type', 'discovery');
    expect(detectIntent('代码审核一下')).toHaveProperty('type', 'discovery');
    expect(detectIntent('检查一下安全性')).toHaveProperty('type', 'discovery');
    expect(detectIntent('code review this PR')).toHaveProperty('type', 'discovery');
    expect(detectIntent('audit the dependency list')).toHaveProperty('type', 'discovery');
  });

  it('returns null for prompts with no matching intent', () => {
    expect(detectIntent('Update the README documentation')).toBeNull();
    expect(detectIntent('deploy to staging server')).toBeNull();
    expect(detectIntent('看一下这个文件')).toBeNull();
  });

  it('detects refactor intent', () => {
    expect(detectIntent('Refactor the database module')).toHaveProperty('type', 'refactor');
    expect(detectIntent('重构数据库模块')).toHaveProperty('type', 'refactor');
    expect(detectIntent('clean up the old code')).toHaveProperty('type', 'refactor');
    // Extended CJK refactor coverage
    expect(detectIntent('把这个函数拆分一下')).toHaveProperty('type', 'refactor');
    expect(detectIntent('提取成独立模块')).toHaveProperty('type', 'refactor');
    expect(detectIntent('简化这段逻辑')).toHaveProperty('type', 'refactor');
    expect(detectIntent('解耦这两个模块')).toHaveProperty('type', 'refactor');
    expect(detectIntent('清理无用代码')).toHaveProperty('type', 'refactor');
  });

  it('test intent wins over refactor for "Refactor the test suite"', () => {
    // "test" matches first (higher priority) — surfacing test-related bugfix memories
    expect(detectIntent('Refactor the test suite')).toHaveProperty('type', 'bugfix');
  });

  it('detects implementation intent', () => {
    expect(detectIntent('Add a new button to the dashboard')).toHaveProperty('type', null);
    expect(detectIntent('implement user registration')).toHaveProperty('type', null);
    expect(detectIntent('实现用户注册功能')).toHaveProperty('type', null);
    // Extended CJK implementation coverage
    expect(detectIntent('开发一个新功能')).toHaveProperty('type', null);
    expect(detectIntent('写一个工具函数')).toHaveProperty('type', null);
    expect(detectIntent('做一个缓存层')).toHaveProperty('type', null);
    expect(detectIntent('创建新的API接口')).toHaveProperty('type', null);
  });

  it('detects test intent as bugfix type', () => {
    expect(detectIntent('run the unit tests')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('单元测试失败了')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('the spec for parser is failing')).toHaveProperty('type', 'bugfix');
  });

  it('detects performance intent', () => {
    expect(detectIntent('the API is very slow')).toHaveProperty('type', 'discovery');
    expect(detectIntent('optimize database performance')).toHaveProperty('type', 'discovery');
    expect(detectIntent('性能优化方案')).toHaveProperty('type', 'discovery');
    // Extended CJK performance coverage
    expect(detectIntent('页面卡顿')).toHaveProperty('type', 'discovery');
    expect(detectIntent('请求超时了')).toHaveProperty('type', 'discovery');
    expect(detectIntent('内存泄漏')).toHaveProperty('type', 'discovery');
    expect(detectIntent('优化搜索排序逻辑')).toHaveProperty('type', 'discovery');
    expect(detectIntent('加速构建流程')).toHaveProperty('type', 'discovery');
  });

  it('detects schema/database intent as decision type', () => {
    expect(detectIntent('update the database schema')).toHaveProperty('type', 'decision');
    expect(detectIntent('add a migration for users table')).toHaveProperty('type', 'decision');
    expect(detectIntent('数据库迁移脚本')).toHaveProperty('type', 'decision');
  });

  it('prioritizes first match (bugfix over decision over recall)', () => {
    // "fix" matches bugfix, "before" matches recall — bugfix wins (first in list)
    const intent = detectIntent('Fix the error we saw before');
    expect(intent).toHaveProperty('type', 'bugfix');
  });

  it('prioritizes decision over recall (为什么...之前 is a decision question)', () => {
    // "why" matches decision, "before" matches recall — decision wins (higher priority)
    const intent = detectIntent('Why did we decide on this design before?');
    expect(intent).toHaveProperty('type', 'decision');
    // CJK: "为什么" matches decision, "之前" matches recall — decision wins
    const cjkIntent = detectIntent('为什么之前选了这个方案？');
    expect(cjkIntent).toHaveProperty('type', 'decision');
  });
});

// ─── Unit Tests: Error Signature Extraction (v2.32.8) ──────────────────────

describe('extractErrorSignature', () => {
  it('returns null for empty / non-string / text without errors', () => {
    expect(extractErrorSignature(null)).toBeNull();
    expect(extractErrorSignature('')).toBeNull();
    expect(extractErrorSignature('just a plain prompt with no error')).toBeNull();
  });

  it('extracts TypeError with message', () => {
    const sig = extractErrorSignature("TypeError: Cannot read properties of undefined (reading 'foo')");
    expect(sig).not.toBeNull();
    expect(sig.className).toBe('TypeError');
    expect(sig.errorCode).toBeNull();
    expect(sig.message).toContain('Cannot read properties of undefined');
    expect(sig.signature).toMatch(/^TypeError /);
  });

  it('extracts Node-style bracketed error code', () => {
    const sig = extractErrorSignature('Error [ERR_MODULE_NOT_FOUND]: Cannot find module lib/foo.mjs');
    expect(sig).not.toBeNull();
    expect(sig.className).toBe('Error');
    expect(sig.errorCode).toBe('ERR_MODULE_NOT_FOUND');
    expect(sig.signature).toContain('ERR_MODULE_NOT_FOUND');
  });

  it('rejects bare "Error: ..." without a typed class or code (noise gate)', () => {
    // Intent-based FTS path will handle generic "Error:" mentions.
    // Only typed classes or Error+[CODE] produce a signature.
    expect(extractErrorSignature('Error: something bad happened')).toBeNull();
  });

  it('extracts AssertionError', () => {
    const sig = extractErrorSignature("AssertionError: expected 'a' to equal 'b'");
    expect(sig.className).toBe('AssertionError');
    expect(sig.signature).toContain('AssertionError');
    expect(sig.signature).toContain('expected');
  });

  it('extracts ValueError (Python)', () => {
    const sig = extractErrorSignature('ValueError: invalid literal for int() with base 10');
    expect(sig.className).toBe('ValueError');
    expect(sig.signature).toContain('invalid literal');
  });

  it('extracts ReferenceError with variable', () => {
    const sig = extractErrorSignature('ReferenceError: foo is not defined');
    expect(sig.className).toBe('ReferenceError');
    expect(sig.message).toBe('foo is not defined');
  });

  it('skips lowercase or malformed "error"', () => {
    // Not a typed exception — intent-based search will catch these
    expect(extractErrorSignature('there is an error somewhere')).toBeNull();
    expect(extractErrorSignature('bug in the code')).toBeNull();
  });

  it('captures first named error when multiple appear', () => {
    const text = 'Saw TypeError: bad input\nLater also ValueError: wrong type';
    const sig = extractErrorSignature(text);
    expect(sig.className).toBe('TypeError');
  });

  it('truncates long messages to 80 chars in signature', () => {
    const longMsg = 'x'.repeat(300);
    const sig = extractErrorSignature(`TypeError: ${longMsg}`);
    expect(sig).not.toBeNull();
    // signature = "TypeError " + slice(0,80) → 10 + 80 = 90 chars
    expect(sig.signature.length).toBeLessThanOrEqual(91);
    expect(sig.message.length).toBeLessThanOrEqual(200); // message cap
  });

  it('normalizes whitespace in message', () => {
    const sig = extractErrorSignature('SyntaxError:  Unexpected   token    here');
    expect(sig.message).toBe('Unexpected token here');
  });

  it('includes errorCode when present', () => {
    const sig = extractErrorSignature('FsError [ERR_NOT_FOUND]: file x missing');
    expect(sig).not.toBeNull();
    expect(sig.errorCode).toBe('ERR_NOT_FOUND');
    expect(sig.signature).toContain('ERR_NOT_FOUND');
  });
});

// ─── Unit Tests: File Path Detection ─────────────────────────────────────────

describe('extractFiles', () => {
  it('extracts file paths from text', () => {
    const files = extractFiles('Check the changes in src/server.mjs and utils.ts');
    expect(files).toContain('src/server.mjs');
    expect(files).toContain('utils.ts');
  });

  it('handles multiple file extensions', () => {
    const files = extractFiles('Update config.json and styles.css');
    expect(files).toContain('config.json');
    expect(files).toContain('styles.css');
  });

  it('filters HTTP URLs starting with "http"', () => {
    // The regex captures the path portion after "://", so "example.com/api.html"
    // is extracted (doesn't start with "http"). The filter only catches matches
    // that literally start with "http".
    const files = extractFiles('See http://docs.com/api.html and config.json');
    // "http://docs.com/api.html" — the regex extracts "http://docs.com/api.html"
    // which starts with "http" and is filtered. But the regex [\w./-]+ doesn't match ":"
    // so it actually extracts "docs.com/api.html" (after "://")
    expect(files).toContain('config.json');
  });

  it('excludes URL paths from file detection', () => {
    // URLs should not be extracted as file paths — they pollute file-recall queries
    const files = extractFiles('Check https://example.com/api.html');
    expect(files).toEqual([]);
  });

  it('excludes paths with // (protocol-like)', () => {
    const files = extractFiles('See //cdn.example.com/lib.js for details');
    expect(files).toEqual([]);
  });

  it('returns empty array when no files found', () => {
    expect(extractFiles('No files mentioned here')).toEqual([]);
  });

  it('handles nested paths', () => {
    const files = extractFiles('Look at packages/core/src/index.ts');
    expect(files).toContain('packages/core/src/index.ts');
  });
});

// ─── Unit Tests: Registry Skill Name Matching ──────────────────────────────

describe('matchRegistrySkillName', () => {
  const skillNames = new Set(['humanizer', 'tdd-workflows', 'code-review-expert', 'audit-website']);

  it('matches exact skill name in prompt', () => {
    expect(matchRegistrySkillName('用 humanizer 处理这段文字', skillNames)).toBe('humanizer');
  });

  it('matches skill name as word boundary', () => {
    expect(matchRegistrySkillName('run the tdd-workflows agent', skillNames)).toBe('tdd-workflows');
  });

  it('returns null when no match', () => {
    expect(matchRegistrySkillName('fix the database bug', skillNames)).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(matchRegistrySkillName('Use Humanizer on this text', skillNames)).toBe('humanizer');
  });

  it('does not match partial names embedded in other words', () => {
    expect(matchRegistrySkillName('audit the code', skillNames)).toBeNull();
  });

  it('returns longest match when multiple skills could match', () => {
    const names = new Set(['code-review', 'code-review-expert']);
    expect(matchRegistrySkillName('use code-review-expert', names)).toBe('code-review-expert');
  });
});

// ─── Unit Tests: Output Format ───────────────────────────────────────────────

function formatResults(rows) {
  if (!rows || rows.length === 0) return null;

  const lines = ['[mem] Related memories:'];
  for (const r of rows) {
    const icon = typeIcon(r.type);
    const title = truncate(r.title || '', 70);
    const lesson = r.lesson_learned ? ` — ${truncate(r.lesson_learned, 50)}` : '';
    lines.push(`#${r.id} ${icon} ${title}${lesson}`);
  }
  return lines.join('\n');
}

describe('formatResults', () => {
  it('returns null for empty/null results', () => {
    expect(formatResults([])).toBeNull();
    expect(formatResults(null)).toBeNull();
  });

  it('formats results with correct header', () => {
    const output = formatResults([
      { id: 1, type: 'bugfix', title: 'Fixed login crash', lesson_learned: null },
    ]);
    expect(output).toContain('[mem] Related memories:');
  });

  it('includes #ID icon and title per row', () => {
    const output = formatResults([
      { id: 42, type: 'bugfix', title: 'Fixed login crash', lesson_learned: null },
    ]);
    expect(output).toMatch(/#42/);
    expect(output).toContain('Fixed login crash');
  });

  it('appends lesson when present', () => {
    const output = formatResults([
      { id: 1, type: 'discovery', title: 'DB patterns', lesson_learned: 'Always use transactions' },
    ]);
    expect(output).toContain('Always use transactions');
  });

  it('handles multiple results', () => {
    const output = formatResults([
      { id: 1, type: 'bugfix', title: 'Bug A', lesson_learned: null },
      { id: 2, type: 'decision', title: 'Decision B', lesson_learned: null },
      { id: 3, type: 'discovery', title: 'Discovery C', lesson_learned: 'Lesson here' },
    ]);
    const lines = output.split('\n');
    expect(lines.length).toBe(4); // header + 3 results
    expect(lines[0]).toBe('[mem] Related memories:');
    expect(lines[1]).toContain('#1');
    expect(lines[2]).toContain('#2');
    expect(lines[3]).toContain('#3');
    expect(lines[3]).toContain('Lesson here');
  });
});

// ─── Integration Tests: Subprocess Execution ─────────────────────────────────
// These tests run the actual script as a subprocess with a test database

const TEST_DB_PATH = join(import.meta.dirname, '.tmp-test-prompt-search.db');
const COOLDOWN_FILE = '/tmp/.claude-mem-prompt-ctx';

function createFileDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
}

function cleanupTestFiles() {
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
  // Remove cooldown file to avoid test interference
  try { if (existsSync(COOLDOWN_FILE)) unlinkSync(COOLDOWN_FILE); } catch {}
}

/**
 * Run the user-prompt-search script with piped JSON input.
 * Uses CLAUDE_MEM_DIR env to point at test DB.
 *
 * Implementation note: this uses spawn() with manual stdin piping rather than
 * execFile()+`input` option. The `input` option is only supported by the SYNC
 * variants (execFileSync, spawnSync) — on async execFile it is silently ignored,
 * stdin stays empty, readStdin() times out after 2s, and the script returns empty.
 * An earlier revision of this helper had that bug, which caused every subprocess
 * test to vacuously pass (they all asserted empty stdout) and wait ~2s each.
 */
function runScript(hookData, extraEnv = {}) {
  const testDir = resolve(import.meta.dirname, '.tmp-prompt-search-dir');
  try { mkdirSync(testDir, { recursive: true }); } catch {}

  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: testDir,
        CLAUDE_PROJECT_DIR: '/test/project',
        PWD: '/test/project',
        // v2.34.3: default the top-|rel| gate off for integration tests so
        // fixtures seeding 1–2 observations (FTS score magnitudes can't reach
        // production-calibrated floor of 50 on sparse corpora) still exercise
        // their pre-gate semantics. Tests that exercise the gate itself pass
        // explicit CLAUDE_MEM_UPS_TOP_MIN overrides.
        CLAUDE_MEM_UPS_TOP_MIN: '0',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Safety timeout — script should never hang, but if it does, kill it
    // to avoid stalling the test suite.
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);

    proc.on('exit', () => {
      clearTimeout(killTimer);
      resolvePromise({ stdout, stderr });
    });
    proc.on('error', () => {
      clearTimeout(killTimer);
      resolvePromise({ stdout, stderr });
    });

    proc.stdin.write(JSON.stringify(hookData));
    proc.stdin.end();
  });
}

describe('user-prompt-search subprocess integration', () => {
  let db;
  let testDir;

  beforeEach(() => {
    cleanupTestFiles();
    // Remove cooldown file before each test
    try { if (existsSync(COOLDOWN_FILE)) unlinkSync(COOLDOWN_FILE); } catch {}
    // Create a test directory with a DB (clean slate — rmSync first to prevent stale WAL data)
    testDir = resolve(import.meta.dirname, '.tmp-prompt-search-dir');
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'claude-mem-lite.db');
    db = createFileDb(dbPath);
    insertSession(db, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });

  afterEach(() => {
    try { db.close(); } catch {}
    // Clean up test directory
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    cleanupTestFiles();
  });

  it('skips short messages and produces no output', async () => {
    const { stdout } = await runScript({ prompt: 'hi' });
    expect(stdout).toBe('');
  });

  it('skips confirmation words', async () => {
    const { stdout } = await runScript({ prompt: 'yes' });
    expect(stdout).toBe('');
  });

  it('skips slash commands', async () => {
    const { stdout } = await runScript({ prompt: '/commit please' });
    expect(stdout).toBe('');
  });

  it('skips when CLAUDE_MEM_HOOK_RUNNING is set', async () => {
    const { stdout } = await runScript(
      { prompt: 'How do I fix the authentication error in the login module?' },
      { CLAUDE_MEM_HOOK_RUNNING: '1' },
    );
    expect(stdout).toBe('');
  });

  it('produces no output when no matching observations exist', async () => {
    const { stdout } = await runScript({
      prompt: 'How do I implement the new feature for data visualization?',
    });
    expect(stdout).toBe('');
  });

  it('accepts both "prompt" and "user_prompt" fields', async () => {
    // Both should be accepted (the script checks hookData.prompt || hookData.user_prompt)
    const { stdout: out1 } = await runScript({ prompt: 'yes' });
    expect(out1).toBe('');
    const { stdout: out2 } = await runScript({ user_prompt: 'ok' });
    expect(out2).toBe('');
  });

  it('silently handles invalid JSON input', async () => {
    // Directly pipe invalid JSON — script should JSON.parse fail and return silently
    const { stdout } = await new Promise((resolvePromise) => {
      const proc = spawn(process.execPath, [SCRIPT_PATH], {
        env: { ...process.env, CLAUDE_MEM_DIR: testDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      proc.on('exit', () => { clearTimeout(killTimer); resolvePromise({ stdout, stderr }); });
      proc.on('error', () => { clearTimeout(killTimer); resolvePromise({ stdout, stderr }); });
      proc.stdin.write('not valid json');
      proc.stdin.end();
    });
    expect(stdout).toBe('');
  });

  it('skips task-notification protocol messages', async () => {
    const { stdout } = await runScript({
      prompt: '<task-notification>some internal protocol message that is long enough</task-notification>',
    });
    expect(stdout).toBe('');
  });

  // R1: LOW_SIGNAL title filtering — degraded titles from hook-llm fallback
  // (Modified X, Worked on X, Reviewed N files:) must not appear in injection output.
  // Both seed obs use type='bugfix' so detectIntent's type filter doesn't
  // eliminate them — the only thing that should filter "Modified X" is the R1 title clause.
  it('R1: filters "Modified X" titles from [mem] Related memories output', async () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Modified authentication.mjs',
      text: 'authentication middleware token expiry validation refresh fix bug',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Resolved authentication middleware token expiry',
      text: 'authentication middleware token expiry validation refresh fix bug',
      importance: 3,
    });
    // Ensure WAL writes are visible to subprocess
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript({
      prompt: 'how do I fix the authentication middleware token expiry validation',
    });
    expect(stdout).toContain('Resolved authentication middleware token expiry');
    expect(stdout).not.toContain('Modified authentication.mjs');
  });

  // v2.34.3: top-|rel| sanity gate. BM25_MIN_SCORE filters per-row; this floor
  // gates the entire FTS set. Noise prompts produce OR-fallback leakage where
  // every hit shares one tangential stem — per-row filtering leaves them all.
  // When the BEST match is weak, the whole prompt is probably noise. Tests
  // exercise env-var wiring (CLAUDE_MEM_UPS_TOP_MIN); the empirical default
  // of 50 is justified in CHANGELOG against measured distribution.
  it('v2.34.3 top-|rel| gate: fires when floor exceeds top relevance', async () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Resolved authentication middleware token expiry',
      text: 'authentication middleware token expiry validation refresh bug',
      importance: 3,
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript(
      { prompt: 'how do I fix the authentication middleware token expiry validation' },
      { CLAUDE_MEM_UPS_TOP_MIN: '1e9' },
    );
    expect(stdout).toBe('');
  });

  it('v2.34.3 top-|rel| gate: env override to 0 lets weak matches through', async () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Resolved authentication middleware token expiry',
      text: 'authentication middleware token expiry validation refresh bug',
      importance: 3,
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript(
      { prompt: 'how do I fix the authentication middleware token expiry validation' },
      { CLAUDE_MEM_UPS_TOP_MIN: '0' },
    );
    expect(stdout).toContain('Resolved authentication middleware token expiry');
  });

  it('v2.34.3 top-|rel| gate: file-recall bypasses the gate', async () => {
    // Obs on a specific file — the prompt mentions that file by name,
    // so searchByFile returns it regardless of FTS score. Gate should not
    // touch file-recall rows even when set to an absurdly high floor.
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Touched auth-config.mjs settings',
      text: 'auth config path adjustment',
      importance: 1,
      filesModified: JSON.stringify(['auth-config.mjs']),
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript(
      { prompt: 'what changed in auth-config.mjs recently please explain' },
      { CLAUDE_MEM_UPS_TOP_MIN: '1e9' },
    );
    expect(stdout).toContain('Touched auth-config.mjs settings');
  });
});

// ─── DB Query Function Tests ─────────────────────────────────────────────────
// Test the FTS search, file search, and recent search functions
// using in-memory DBs directly

describe('search query functions (in-memory DB)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { db.close(); });

  // Replicate searchByFts logic for direct testing
  function searchByFts(ftsQuery, project, limit, typeFilter) {
    const processed = sanitizeFtsQuery(ftsQuery);
    if (!processed) return [];

    const cutoff = Date.now() - 60 * 86400000;
    const typeClause = typeFilter ? `AND o.type = '${typeFilter}'` : '';
    const sql = `
      SELECT o.id, o.type, o.title, o.lesson_learned,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8) as relevance
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project = ?
        AND o.importance >= 1
        AND o.created_at_epoch > ?
        AND COALESCE(o.compressed_into, 0) = 0
        ${typeClause}
      ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
      LIMIT ?
    `;

    let rows = db.prepare(sql).all(processed, project, cutoff, limit);

    if (rows.length === 0) {
      const orQuery = relaxFtsQueryToOr(processed);
      if (orQuery) {
        try { rows = db.prepare(sql).all(orQuery, project, cutoff, limit); } catch {}
      }
    }

    return rows;
  }

  it('finds observations via FTS5 search', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed authentication timeout', text: 'authentication module had a timeout issue',
    });
    const rows = searchByFts('authentication timeout', 'test--project', 5, null);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toContain('authentication');
  });

  it('filters by type', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug in parser', text: 'parser token error',
    });
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Parser pattern', text: 'parser pattern discovery',
    });
    const bugOnly = searchByFts('parser', 'test--project', 5, 'bugfix');
    expect(bugOnly.every(r => r.type === 'bugfix')).toBe(true);
  });

  it('returns empty for no matches', () => {
    const rows = searchByFts('xyznonexistent', 'test--project', 5, null);
    expect(rows.length).toBe(0);
  });

  it('OR fallback finds results when AND fails', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Database schema migration', text: 'database schema migration patterns',
    });
    // "database xyznotexist" as AND won't match, OR fallback should find "database"
    const rows = searchByFts('database xyznotexist', 'test--project', 5, null);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('excludes compressed observations', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active observation', text: 'searchable content alpha',
    });
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed observation', text: 'searchable content alpha',
      compressedInto: 999,
    });
    const rows = searchByFts('alpha', 'test--project', 10, null);
    expect(rows.every(r => r.title !== 'Compressed observation')).toBe(true);
  });

  // Test searchByFile logic
  it('finds observations by file name in files_modified', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Updated schema', text: 'schema change',
      filesModified: '["src/schema.mjs"]',
    });
    const cutoff = Date.now() - 60 * 86400000;
    const rows = db.prepare(`
      SELECT id, type, title, lesson_learned
      FROM observations
      WHERE project = ?
        AND importance >= 1
        AND COALESCE(compressed_into, 0) = 0
        AND created_at_epoch > ?
        AND (files_modified LIKE ? OR files_read LIKE ?)
      ORDER BY created_at_epoch DESC
      LIMIT 5
    `).all('test--project', cutoff, '%schema.mjs%', '%schema.mjs%');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toBe('Updated schema');
  });

  // Test searchRecent logic
  it('returns recent observations ordered by epoch DESC', () => {
    for (let i = 0; i < 5; i++) {
      insertObs(db, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Obs ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const cutoff = Date.now() - 60 * 86400000;
    const rows = db.prepare(`
      SELECT id, type, title, lesson_learned
      FROM observations
      WHERE project = ?
        AND importance >= 1
        AND COALESCE(compressed_into, 0) = 0
        AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC
      LIMIT 3
    `).all('test--project', cutoff);

    expect(rows.length).toBe(3);
    // Most recent should be first (highest epochOffset)
    expect(rows[0].title).toBe('Obs 4');
  });
});

// ─── Unit Tests: Result Dedup Cooldown ──────────────────────────────────────

describe('result-dedup cooldown', () => {
  const testDir = resolve(import.meta.dirname, '.tmp-dedup-test');

  beforeEach(() => {
    try { mkdirSync(testDir, { recursive: true }); } catch {}
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('skips injection when >80% overlap with previously injected', () => {
    const injectedFile = join(testDir, '.claude-mem-injected-dedup1');
    writeFileSync(injectedFile, JSON.stringify({ ids: [1,2,3,4,5], ts: Date.now() }));
    expect(shouldSkipByDedup([1,2,3,4,6], injectedFile)).toBe(true);
  });

  it('allows injection when ≤80% overlap', () => {
    const injectedFile = join(testDir, '.claude-mem-injected-dedup2');
    writeFileSync(injectedFile, JSON.stringify({ ids: [1,2,3,4,5], ts: Date.now() }));
    expect(shouldSkipByDedup([1,2,6,7,8], injectedFile)).toBe(false);
  });

  it('allows injection when no previous injections exist', () => {
    const injectedFile = join(testDir, '.claude-mem-injected-nonexistent');
    expect(shouldSkipByDedup([1,2,3], injectedFile)).toBe(false);
  });

  it('allows injection when previous injections are stale (>5min)', () => {
    const injectedFile = join(testDir, '.claude-mem-injected-stale');
    writeFileSync(injectedFile, JSON.stringify({ ids: [1,2,3,4,5], ts: Date.now() - 400_000 }));
    expect(shouldSkipByDedup([1,2,3,4,5], injectedFile)).toBe(false);
  });

  it('skips when session injection limit reached', () => {
    const injectedFile = join(testDir, '.claude-mem-injected-limit');
    writeFileSync(injectedFile, JSON.stringify({ ids: [99], ts: Date.now(), count: 15 }));
    expect(shouldSkipByDedup([1,2,3], injectedFile)).toBe(true);
  });
});

// ─── T3 (v2.31): BM25 threshold + prompt-length gate ───────────────────────
// Purpose: suppress injection when top BM25 magnitude is below floor, or when
// prompt is too short to carry meaningful search signal. See Task 3 in
// docs/plans/2026-04-14-mem-v2.31-mvp.md.
//
// Implementation note: `runScript()` (defined above) hardcodes
// CLAUDE_MEM_DIR = '.tmp-prompt-search-dir'. We mirror that path exactly so the
// subprocess reads the same DB we seed here, rather than opening a different
// file. An earlier draft used a separate '.tmp-ups-t3-dir' and every test
// vacuously saw empty stdout because the subprocess was opening an empty DB.
describe('user-prompt-search T3: BM25 threshold + prompt-length gate', () => {
  let db;
  let testDir;

  beforeEach(() => {
    cleanupTestFiles();
    try { if (existsSync(COOLDOWN_FILE)) unlinkSync(COOLDOWN_FILE); } catch {}
    testDir = resolve(import.meta.dirname, '.tmp-prompt-search-dir');
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'claude-mem-lite.db');
    db = createFileDb(dbPath);
    insertSession(db, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    cleanupTestFiles();
  });

  it('suppresses injection when top score is below BM25 threshold', async () => {
    // Seed a loosely-related low-importance observation whose text shares
    // exactly one stem ("implement") with the test prompt. Without a BM25
    // threshold this triggers the OR-fallback and produces a tiny-magnitude
    // match (|rel| ~ 3e-6) that leaks as noise injection. With the gate
    // (default 1e-5) this must be suppressed.
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'implementing user auth',
      text: 'implement authentication',
      importance: 1,
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript({
      prompt: 'how do I implement a deployment pipeline in Go',
    });
    expect(stdout.trim()).toBe('');
  });

  it('injects when a high-relevance row exists', async () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'chose Redis over Memcached for rate limit',
      text: 'Redis chosen because persistence rate limit TTL 60 seconds cache invalidation',
      lessonLearned: 'Redis chosen because persistence; rate limit TTL = 60s',
      importance: 3,
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript({
      prompt: 'why did we pick Redis for rate limiting',
    });
    expect(stdout).toMatch(/Redis/i);
  });

  it('skips medium-short Latin prompts (13 chars) — exercises PROMPT_MIN_LENGTH gate', async () => {
    // 'fix a bug now' is 13 chars, effectiveLen 13 (all Latin): passes
    // shouldSkip (>= 8) but fails PROMPT_MIN_LENGTH (< 15). Seed a
    // high-relevance bugfix observation that WOULD match the prompt stems
    // ("fix", "bug") if the gate weren't there — so the only thing
    // suppressing injection is the length gate itself. Mutation-resistant.
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'fix bug in authentication flow',
      text: 'fix bug authentication login crash root cause race condition',
      lessonLearned: 'fix bug by serializing auth requests',
      importance: 3,
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript({ prompt: 'fix a bug now' });
    expect(stdout.trim()).toBe('');
  });

  it('admits CJK-heavy prompts below raw 15 chars — exercises computeEffectiveLen weighting', async () => {
    // v2.34.4: PROMPT_MIN_LENGTH gate moved from raw char count to
    // CJK-weighted effectiveLen. "优化 hook 性能降低延迟" is 14 raw chars
    // (would fail the old `trim().length < 15` gate) but effectiveLen 30
    // (8 CJK × 3 + 6 Latin/space), so it now reaches FTS.
    //
    // Mutation probe: if the gate reverts to raw char count this test fails
    // because the 14-char prompt would be blocked before FTS runs and stdout
    // would be empty. The seeded bugfix uses "优化" + "性能" which the CJK
    // LIKE fallback (nlp.mjs extractCjkLikePatterns) extracts from both the
    // prompt and the observation text — guaranteeing a retrieval hit when
    // the gate lets the prompt through.
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: '优化 hook 性能降低调用延迟',
      text: 'hook 性能优化 降低 post-tool-use 的调用延迟 race condition',
      lessonLearned: '优化 hook 调度减少同步 IO 阻塞，性能延迟下降明显',
      importance: 3,
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript({ prompt: '优化 hook 性能降低延迟' });
    expect(stdout).toMatch(/优化|性能/);
  });

  it('skips extremely short prompts via shouldSkip', async () => {
    // 'a' is rejected by shouldSkip (effectiveLen 1 < 8) before reaching
    // PROMPT_MIN_LENGTH. Kept as independent coverage of the older gate.
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'x', importance: 3,
    });
    db.pragma('wal_checkpoint(FULL)');
    const { stdout } = await runScript({ prompt: 'a' });
    expect(stdout.trim()).toBe('');
  });
});

// ─── T4 (v2.31): Skill pointer (no raw-body injection) ─────────────────────
// Purpose: the registry-skill auto-load block must NEVER emit the full skill
// body to stdout (previously up to 16KB). It may emit a single pointer line
// containing the skill name so Claude can decide to invoke via SkillTool.
// See Task 4 in docs/plans/2026-04-14-mem-v2.31-mvp.md.
//
// Seeding strategy: filesystem + registry DB. `loadSkillContent` (old code)
// path-confines against `homedir()/.claude-mem-lite/managed/`, so to make
// the OLD code actually emit the body (i.e. a true RED-phase failing test)
// we must place a real file under the real homedir managed dir. We use a
// per-pid/per-timestamp nonce to avoid collision with any genuine user
// skills, and the afterEach cleanup removes it.
describe('user-prompt-search T4: registry skill pointer (no body injection)', () => {
  let db;
  let testDir;
  let managedSkillDir;
  let skillName;

  /**
   * Seed a registered skill with a large body under the real homedir managed
   * dir (required by loadSkillContent's path confinement) plus a registry
   * row pointing at it. Returns the skill name for use in the prompt.
   */
  function seedRegistrySkill({ registryDbPath, bodyBytes }) {
    const nonce = `test-skill-large-${process.pid}-${Date.now()}`;
    const skillDir = join(homedir(), '.claude-mem-lite', 'managed', nonce);
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, 'A'.repeat(bodyBytes));

    const rdb = ensureRegistryDb(registryDbPath);
    try {
      rdb.prepare(`
        INSERT INTO resources (name, type, status, source, local_path, invocation_name)
        VALUES (?, 'skill', 'active', 'user', ?, ?)
      `).run(nonce, skillPath, nonce);
    } finally {
      rdb.close();
    }
    return { skillName: nonce, skillDir };
  }

  beforeEach(() => {
    cleanupTestFiles();
    try { if (existsSync(COOLDOWN_FILE)) unlinkSync(COOLDOWN_FILE); } catch {}
    testDir = resolve(import.meta.dirname, '.tmp-prompt-search-dir');
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    mkdirSync(testDir, { recursive: true });
    // runtime/ needed so setSkillCooldown can write (doesn't affect assertion,
    // but keeps the path clean; write is try/catch-guarded anyway).
    mkdirSync(join(testDir, 'runtime'), { recursive: true });
    const dbPath = join(testDir, 'claude-mem-lite.db');
    db = createFileDb(dbPath);
    insertSession(db, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    managedSkillDir = null;
    skillName = null;
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    // Always clean up the homedir-seeded skill fixture
    if (managedSkillDir) {
      try { rmSync(managedSkillDir, { recursive: true, force: true }); } catch {}
    }
    cleanupTestFiles();
  });

  it('never emits raw skill bodies — at most a one-line pointer', async () => {
    const registryDbPath = join(testDir, 'resource-registry.db');
    const seeded = seedRegistrySkill({ registryDbPath, bodyBytes: 10000 });
    managedSkillDir = seeded.skillDir;
    skillName = seeded.skillName;
    db.pragma('wal_checkpoint(FULL)');

    const prompt = `please use the ${skillName} skill to help me with this task`;
    const { stdout } = await runScript({ prompt });

    // HARD constraint: the 10KB body must not appear in stdout under any
    // circumstance. A run of 100+ 'A' characters can only come from the body.
    expect(stdout).not.toMatch(/A{100,}/);

    // SOFT constraint: if the hook DOES emit something (the pointer line),
    // it must be short and reference the skill by name so Claude can act.
    if (stdout.trim()) {
      expect(stdout.length).toBeLessThan(500);
      expect(stdout).toContain(skillName);
    }
  });
});
