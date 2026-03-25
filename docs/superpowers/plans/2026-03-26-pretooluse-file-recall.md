# PreToolUse File Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject relevant file lessons into Claude's context just-in-time before Edit/Write, and improve SessionStart context format from passive observations to actionable rules.

**Architecture:** A new standalone PreToolUse hook script (`scripts/pre-tool-recall.js`) queries the DB for file-related lessons with `lesson_learned` and outputs them before Claude edits. The existing PostToolUse file-history injection in `hook.mjs` is removed (replaced by the better-timed PreToolUse). `hook.mjs` SessionStart splits "Key Context" into "File Lessons" + "Key Context" sections.

**Tech Stack:** Node.js ESM, better-sqlite3 (readonly), vitest

**Spec:** `docs/superpowers/specs/2026-03-26-pretooluse-file-recall-design.md`

---

## File Map

| File | Operation | Responsibility |
|------|-----------|----------------|
| `scripts/pre-tool-recall.js` | **Create** | Standalone PreToolUse hook: parse stdin, cooldown, DB query, stdout output |
| `tests/pre-tool-recall.test.mjs` | **Create** | Unit + integration tests for the new script |
| `hooks/hooks.json` | Modify | Add PreToolUse section |
| `hook.mjs` | Modify | Remove PostToolUse file-history hints (lines 228-249) |
| `hook.mjs` | Modify | Split Key Context into File Lessons + Key Context (lines 650-669) |
| `install.mjs` | Modify | Remove PreToolUse cleanup code, add PreToolUse hook registration |
| `package.json` | Modify | Add `scripts/pre-tool-recall.js` to `files` array |

---

### Task 1: Create `scripts/pre-tool-recall.js`

**Files:**
- Create: `scripts/pre-tool-recall.js`

- [ ] **Step 1: Create the script with full implementation**

```javascript
#!/usr/bin/env node
// claude-mem-lite: PreToolUse file recall — injects lessons before Edit/Write
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os
// Safety: readonly DB, exit 0 always, 3s timeout

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';

const DB_PATH = join(homedir(), '.claude-mem-lite', 'claude-mem-lite.db');
const RUNTIME_DIR = join(homedir(), '.claude-mem-lite', 'runtime');
const COOLDOWN_PATH = join(RUNTIME_DIR, 'pre-recall-cooldown.json');
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const STALE_MS = 10 * 60 * 1000;   // 10 minutes cleanup threshold

// ─── Helpers ────────────────────────────────────────────────────────────────

function inferProject() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const base = basename(dir);
  const parent = basename(join(dir, '..'));
  let project = (parent && parent !== '.' && parent !== '/')
    ? `${parent}--${base}` : base;
  project = project.replace(/[^a-zA-Z0-9_.-]/g, '-') || 'unknown';
  return project;
}

function readCooldown() {
  try { return JSON.parse(readFileSync(COOLDOWN_PATH, 'utf8')); } catch { return {}; }
}

function writeCooldown(data) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    // Clean stale entries
    const now = Date.now();
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (now - v < STALE_MS) cleaned[k] = v;
    }
    writeFileSync(COOLDOWN_PATH, JSON.stringify(cleaned));
  } catch { /* silent */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  // Skip if recursive hook
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) process.exit(0);

  // Skip if DB doesn't exist
  if (!existsSync(DB_PATH)) process.exit(0);

  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  // Parse event
  let filePath;
  try {
    const event = JSON.parse(input);
    filePath = event.tool_input?.file_path;
  } catch { process.exit(0); }

  if (!filePath) process.exit(0);

  // Cooldown check (full path as key)
  const cooldown = readCooldown();
  const now = Date.now();
  if (cooldown[filePath] && (now - cooldown[filePath]) < COOLDOWN_MS) {
    process.exit(0);
  }

  // Open DB readonly
  const Database = (await import('better-sqlite3')).default;
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
  } catch { process.exit(0); }

  try {
    const project = inferProject();
    const fname = basename(filePath);
    // Escape LIKE wildcards
    const escaped = fname.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;

    // 60-day lookback to avoid surfacing ancient observations
    const cutoff = Date.now() - 60 * 86400000;

    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 2
        AND o.lesson_learned IS NOT NULL
        AND o.lesson_learned != ''
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
      ORDER BY o.created_at_epoch DESC
      LIMIT 2
    `).all(project, cutoff, filePath, likePattern);

    if (rows.length > 0) {
      const fbase = fname;
      console.log(`[mem] Lessons for ${fbase}:`);
      for (const r of rows) {
        const lesson = r.lesson_learned.length > 120
          ? r.lesson_learned.slice(0, 117) + '...'
          : r.lesson_learned;
        console.log(`  #${r.id} [${r.type}] ${lesson}`);
      }
      // Update cooldown
      cooldown[filePath] = now;
      writeCooldown(cooldown);
    }
  } catch {
    // Silent failure — never block editing
  } finally {
    try { db.close(); } catch {}
  }
} catch {
  // Top-level catch — exit 0 no matter what
}
```

- [ ] **Step 2: Verify script has no syntax errors**

Run: `node --check scripts/pre-tool-recall.js`
Expected: no output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add scripts/pre-tool-recall.js
git commit -m "feat: add PreToolUse file recall script"
```

---

### Task 2: Write tests for `pre-tool-recall.js`

**Files:**
- Create: `tests/pre-tool-recall.test.mjs`

- [ ] **Step 1: Write unit + integration tests**

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

// Helper: run script with mocked env
async function runScript(input, env = {}) {
  const { stdout, stderr } = await execFileAsync('node', [SCRIPT_PATH], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env, CLAUDE_MEM_HOOK_RUNNING: '' },
    timeout: 5000,
  });
  return { stdout, stderr };
}

describe('pre-tool-recall', () => {
  // Note: integration tests that hit the real DB are hard to isolate
  // because the script reads DB_PATH from hardcoded homedir.
  // We test the logic via unit-style assertions where possible.

  describe('input parsing', () => {
    it('exits silently on invalid JSON', async () => {
      const { stdout } = await execFileAsync('node', [SCRIPT_PATH], {
        input: 'not json',
        env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '' },
        timeout: 5000,
      });
      expect(stdout).toBe('');
    });

    it('exits silently when tool_input.file_path is missing', async () => {
      const { stdout } = await runScript({ tool_name: 'Edit', tool_input: {} });
      expect(stdout).toBe('');
    });

    it('exits silently when CLAUDE_MEM_HOOK_RUNNING is set', async () => {
      const { stdout } = await execFileAsync('node', [SCRIPT_PATH], {
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/foo.mjs' } }),
        env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
        timeout: 5000,
      });
      expect(stdout).toBe('');
    });
  });

  describe('cooldown', () => {
    const RUNTIME_DIR = join(tmpdir(), 'pre-recall-test-' + process.pid);
    const COOLDOWN_PATH = join(RUNTIME_DIR, 'pre-recall-cooldown.json');

    beforeEach(() => {
      mkdirSync(RUNTIME_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(RUNTIME_DIR, { recursive: true, force: true });
    });

    it('cooldown JSON uses full file path as key', () => {
      const data = { '/path/to/schema.mjs': Date.now() };
      writeFileSync(COOLDOWN_PATH, JSON.stringify(data));
      const parsed = JSON.parse(readFileSync(COOLDOWN_PATH, 'utf8'));
      expect(parsed['/path/to/schema.mjs']).toBeDefined();
    });

    it('different files with same basename have separate cooldowns', () => {
      const data = {
        '/src/utils.mjs': Date.now(),
        '/lib/utils.mjs': Date.now() - 600000, // expired
      };
      writeFileSync(COOLDOWN_PATH, JSON.stringify(data));
      const parsed = JSON.parse(readFileSync(COOLDOWN_PATH, 'utf8'));
      expect(Object.keys(parsed)).toHaveLength(2);
    });
  });

  describe('DB query pattern', () => {
    it('uses observation_files junction table with correct filters', () => {
      const db = createTestDb();
      insertSession(db, { id: 'sess-1' });

      // Insert obs with lesson + high importance
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'FTS5 broke after schema change',
        type: 'bugfix',
        importance: 2,
        lessonLearned: 'Verify FTS5 integrity after schema changes',
        filesModified: '["schema.mjs"]',
      });

      // Insert obs without lesson (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Edited schema.mjs',
        type: 'change',
        importance: 2,
        lessonLearned: null,
        filesModified: '["schema.mjs"]',
      });

      // Insert obs with low importance (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Minor tweak',
        type: 'change',
        importance: 1,
        lessonLearned: 'Some lesson',
        filesModified: '["schema.mjs"]',
      });

      // Insert compressed obs (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Old compressed',
        type: 'bugfix',
        importance: 3,
        lessonLearned: 'Important lesson',
        filesModified: '["schema.mjs"]',
        compressedInto: 999,
      });

      // Insert superseded obs (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Superseded obs',
        type: 'bugfix',
        importance: 3,
        lessonLearned: 'Old lesson',
        filesModified: '["schema.mjs"]',
        supersededAt: new Date().toISOString(),
      });

      // Run the exact query from pre-tool-recall.js
      const cutoff = Date.now() - 60 * 86400000;
      const rows = db.prepare(`
        SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
        FROM observations o
        JOIN observation_files of2 ON of2.obs_id = o.id
        WHERE o.project = ?
          AND o.importance >= 2
          AND o.lesson_learned IS NOT NULL
          AND o.lesson_learned != ''
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND o.created_at_epoch > ?
          AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        ORDER BY o.created_at_epoch DESC
        LIMIT 2
      `).all('test', cutoff, 'schema.mjs', '%schema.mjs');

      expect(rows).toHaveLength(1);
      expect(rows[0].lesson_learned).toBe('Verify FTS5 integrity after schema changes');

      db.close();
    });

    it('matches both full path and basename via LIKE', () => {
      const db = createTestDb();
      insertSession(db, { id: 'sess-1' });

      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Fix in utils',
        type: 'bugfix',
        importance: 2,
        lessonLearned: 'Check CJK boundary',
        filesModified: '["/mnt/data/projects/mem/utils.mjs"]',
      });

      // Match via basename LIKE pattern
      const cutoff = Date.now() - 60 * 86400000;
      const rows = db.prepare(`
        SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
        FROM observations o
        JOIN observation_files of2 ON of2.obs_id = o.id
        WHERE o.project = ?
          AND o.importance >= 2
          AND o.lesson_learned IS NOT NULL
          AND o.lesson_learned != ''
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND o.created_at_epoch > ?
          AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        ORDER BY o.created_at_epoch DESC
        LIMIT 2
      `).all('test', cutoff, '/mnt/data/projects/mem/utils.mjs', '%utils.mjs');

      expect(rows).toHaveLength(1);
      expect(rows[0].lesson_learned).toBe('Check CJK boundary');

      db.close();
    });
  });

  describe('output format', () => {
    it('formats lessons correctly', () => {
      const lesson = 'Verify FTS5 integrity after schema changes';
      const output = `[mem] Lessons for schema.mjs:\n  #1 [bugfix] ${lesson}\n`;
      expect(output).toContain('[mem] Lessons for schema.mjs:');
      expect(output).toContain('#1 [bugfix]');
    });

    it('truncates long lessons at 120 chars', () => {
      const longLesson = 'A'.repeat(200);
      const truncated = longLesson.length > 120
        ? longLesson.slice(0, 117) + '...'
        : longLesson;
      expect(truncated).toHaveLength(120);
      expect(truncated.endsWith('...')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/pre-tool-recall.test.mjs`
Expected: All tests pass. The DB query pattern tests use in-memory DB with `createTestDb()`.

- [ ] **Step 3: Commit**

```bash
git add tests/pre-tool-recall.test.mjs
git commit -m "test: add PreToolUse file recall tests"
```

---

### Task 3: Add PreToolUse to hooks.json

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 1: Add PreToolUse section to hooks.json**

Add after the `"SessionStart"` block and before `"PostToolUse"`:

```json
"PreToolUse": [
  {
    "matcher": "Edit|Write|NotebookEdit",
    "hooks": [
      {
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-recall.js\"",
        "timeout": 3
      }
    ]
  }
],
```

- [ ] **Step 2: Validate JSON syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Run existing plugin-manifest tests**

Run: `npx vitest run tests/plugin-manifest.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat: add PreToolUse hook for Edit/Write/NotebookEdit"
```

---

### Task 4: Remove PostToolUse file-history hints from hook.mjs

**Files:**
- Modify: `hook.mjs:228-249`

- [ ] **Step 1: Remove the file-history block**

Replace lines 228-249 in `hook.mjs`:
```javascript
    // Proactive file history: show past observations for files being edited
    // Uses recallForFile for importance>=2 with lesson context
    if (EDIT_TOOLS.has(tool_name) && files.length > 0) {
      const d = getDb();
      if (d) {
        for (const f of files) {
          if (episode.fileHistoryShown?.includes(f)) continue;
          try {
            const recalled = recallForFile(d, f, project);
            if (recalled.length > 0) {
              const hints = recalled.map(r => {
                const lesson = r.lesson_learned ? ` | ${r.lesson_learned}` : '';
                return `  #${r.id} [${r.type}] ${truncate(r.title, 60)}${lesson}`;
              }).join('\n');
              process.stdout.write(`[claude-mem-lite] History for ${basename(f)}:\n${hints}\n`);
            }
          } catch (e) { debugCatch(e, 'fileHistory'); }
          if (!episode.fileHistoryShown) episode.fileHistoryShown = [];
          episode.fileHistoryShown.push(f);
        }
      }
    }
```

With a comment:
```javascript
    // File history injection moved to PreToolUse hook (scripts/pre-tool-recall.js)
    // — injects lessons BEFORE edits instead of after. See spec 2026-03-26.
```

- [ ] **Step 2: Remove `recallForFile` import**

`recallForFile` is imported at hook.mjs line 31 alongside `searchRelevantMemories`. This was its only call site. Change:
```javascript
import { searchRelevantMemories, recallForFile } from './hook-memory.mjs';
```
To:
```javascript
import { searchRelevantMemories } from './hook-memory.mjs';
```

- [ ] **Step 3: Check for `fileHistoryShown` test references**

The removed code set `episode.fileHistoryShown`. Check if any tests assert on this property:
Run: `grep -rn "fileHistoryShown" tests/`
If found, remove those assertions or update them — `fileHistoryShown` is no longer set on episodes.

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run tests/e2e.test.mjs tests/hook-episode.test.mjs`
Expected: PASS (fix any failures from `fileHistoryShown` removal first)

- [ ] **Step 5: Commit**

```bash
git add hook.mjs
git commit -m "refactor: move file-history injection to PreToolUse hook"
```

---

### Task 5: Split "Key Context" into "File Lessons" + "Key Context"

**Files:**
- Modify: `hook.mjs:650-669`

- [ ] **Step 1: Replace the Key Context rendering block**

Current code at `hook.mjs:650-669`:
```javascript
    // Key context: top high-importance observations for CLAUDE.md persistence
    const keyObs = db.prepare(`
      SELECT id, type, title, lesson_learned FROM observations
      WHERE project = ? AND COALESCE(compressed_into, 0) = 0
        AND COALESCE(importance, 1) >= 2
      ORDER BY created_at_epoch DESC LIMIT 5
    `).all(project);
    if (keyObs.length > 0) {
      summaryLines.push('### Key Context');
      for (const o of keyObs) {
        const clean = (o.title || '(untitled)')
          .replace(/ → (?:ERROR: )?\{".*$/, '')
          .replace(/ → (?:ERROR: )?\{[^}]*\.{3}$/, '');
        const lesson = o.lesson_learned ? ` — ${truncate(o.lesson_learned, 60)}` : '';
        summaryLines.push(`- [${o.type || 'discovery'}] ${truncate(clean, 80)} (#${o.id})${lesson}`);
      }
      summaryLines.push('');
    }
```

Replace with:
```javascript
    // Key context: top high-importance observations for CLAUDE.md persistence
    // Split into "File Lessons" (actionable, has lesson + file) and "Key Context" (informational)
    const keyObs = db.prepare(`
      SELECT o.id, o.type, o.title, o.lesson_learned, o.files_modified FROM observations o
      WHERE o.project = ? AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
        AND COALESCE(o.importance, 1) >= 2
      ORDER BY o.created_at_epoch DESC LIMIT 10
    `).all(project);

    if (keyObs.length > 0) {
      const fileLessons = [];
      const keyContext = [];

      for (const o of keyObs) {
        const clean = (o.title || '(untitled)')
          .replace(/ → (?:ERROR: )?\{".*$/, '')
          .replace(/ → (?:ERROR: )?\{[^}]*\.{3}$/, '');
        const hasLesson = o.lesson_learned && o.lesson_learned.trim();
        const hasFiles = o.files_modified && o.files_modified !== '[]';

        if (hasLesson && hasFiles) {
          try {
            const files = JSON.parse(o.files_modified);
            const fname = basename(Array.isArray(files) && files.length > 0 ? files[0] : '');
            if (fname) {
              fileLessons.push(`- ${fname}: ${truncate(o.lesson_learned, 100)} (#${o.id})`);
              continue;
            }
          } catch {}
        }
        const lesson = hasLesson ? ` — ${truncate(o.lesson_learned, 60)}` : '';
        keyContext.push(`- [${o.type || 'discovery'}] ${truncate(clean, 80)} (#${o.id})${lesson}`);
      }

      if (fileLessons.length > 0) {
        summaryLines.push('### File Lessons');
        summaryLines.push(...fileLessons.slice(0, 5));
        summaryLines.push('');
      }
      if (keyContext.length > 0) {
        summaryLines.push('### Key Context');
        summaryLines.push(...keyContext.slice(0, 5));
        summaryLines.push('');
      }
    }
```

**Deliberate changes from current query:**
- Added `o.superseded_at IS NULL` filter (current query lacks this — superseded obs shouldn't appear in context)
- Increased `LIMIT 5 → 10` to have enough rows for both sections (each capped at 5 via slice)
- Added `o.files_modified` to SELECT (needed for File Lessons classification)

Note: requires `basename` import at top of hook.mjs — verify it's already imported from `'path'`.

- [ ] **Step 2: Verify `basename` is imported**

Run: `grep "import.*basename.*from.*path" hook.mjs`
If not found, add to the existing path import.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/e2e.test.mjs tests/handoff.test.mjs`
Expected: PASS. If `handoff-simulation.test.mjs` has a simulated Key Context query, it may need `superseded_at IS NULL` added to stay in sync.

- [ ] **Step 4: Commit**

```bash
git add hook.mjs
git commit -m "feat: split Key Context into File Lessons + Key Context sections"
```

---

### Task 6: Update install.mjs — remove PreToolUse cleanup, add registration

**Files:**
- Modify: `install.mjs:456-468`

- [ ] **Step 1: Add PreToolUse hook registration**

At `install.mjs:453` (after `memUserPrompt` definition), add:

```javascript
  const memPreToolUse = {
    matcher: 'Edit|Write|NotebookEdit',
    hooks: [
      {
        type: 'command',
        command: `node "${join(SCRIPTS_PATH, 'pre-tool-recall.js')}"`,
        timeout: 3
      }
    ]
  };
```

Note: `SCRIPTS_PATH` should already be defined earlier in install.mjs. Verify with `grep -n SCRIPTS_PATH install.mjs`.

- [ ] **Step 2: Add PreToolUse to the registration loop**

Change line 456:
```javascript
  for (const [event, config] of [['PostToolUse', memPostToolUse], ['SessionStart', memSessionStart], ['Stop', memStop], ['UserPromptSubmit', memUserPrompt]]) {
```

To:
```javascript
  for (const [event, config] of [['PreToolUse', memPreToolUse], ['PostToolUse', memPostToolUse], ['SessionStart', memSessionStart], ['Stop', memStop], ['UserPromptSubmit', memUserPrompt]]) {
```

- [ ] **Step 3: Remove PreToolUse cleanup code**

Replace lines 461-465:
```javascript
  // Clean up stale PreToolUse hook from previous versions
  if (Array.isArray(settings.hooks.PreToolUse)) {
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(cfg => !isMemHook(cfg));
    if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  }
```

With nothing (delete these lines entirely).

- [ ] **Step 4: Update the ok() message**

Change line 468:
```javascript
  ok('Hooks configured (PostToolUse, SessionStart, Stop, UserPromptSubmit)');
```
To:
```javascript
  ok('Hooks configured (PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit)');
```

- [ ] **Step 5: Run install lifecycle tests**

Run: `npx vitest run tests/install-lifecycle.test.mjs`
Expected: PASS. May need to update assertions that check for specific hook counts or types.

- [ ] **Step 6: Commit**

```bash
git add install.mjs
git commit -m "feat: register PreToolUse hook in direct-install path"
```

---

### Task 7: Add `pre-tool-recall.js` to package.json files array

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add to files array**

In `package.json`, add `"scripts/pre-tool-recall.js"` to the `"files"` array, after the existing `"scripts/user-prompt-search.js"` entry.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add pre-tool-recall.js to package files"
```

---

### Task 8: Full test suite + version bump

**Files:**
- Modify: `package.json` (version)
- Modify: `.claude-plugin/plugin.json` (version)
- Modify: `.claude-plugin/marketplace.json` (version)
- Modify: `CLAUDE.md` (version)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All 35+ test files pass, 1090+ tests pass.

- [ ] **Step 2: Run lint**

Run: `npx eslint scripts/pre-tool-recall.js tests/pre-tool-recall.test.mjs`
Expected: No errors

- [ ] **Step 3: Bump version from 2.24.2 to 2.25.0**

This is a feature release (new PreToolUse hook). Bump in:
- `package.json`: `"version": "2.24.2"` → `"version": "2.25.0"`
- `.claude-plugin/plugin.json`: `"version": "2.24.2"` → `"version": "2.25.0"`
- `.claude-plugin/marketplace.json`: `"version": "2.24.2"` → `"version": "2.25.0"`
- `CLAUDE.md`: `- **Version**: 2.24.2` → `- **Version**: 2.25.0`

- [ ] **Step 4: Commit, tag, and push**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CLAUDE.md
git commit -m "feat(hooks): add PreToolUse file recall + actionable Key Context — v2.25.0"
git tag v2.25.0
git push origin main && git push origin v2.25.0
```

- [ ] **Step 5: Create GitHub Release**

```bash
gh release create v2.25.0 --title "v2.25.0" --notes "..."
```
