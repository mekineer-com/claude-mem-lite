import { describe, it, expect, afterEach } from 'vitest';
import {
  jaccardSimilarity,
  truncate,
  typeIcon,
  sanitizeFtsQuery,
  clampImportance,
  computeRuleImportance,
  inferProject,
  detectBashSignificance,
  extractErrorKeywords,
  extractFilePaths,
  parseJsonFromLLM,
  isRelatedToEpisode,
  stripTestSuffix,
  makeEntryDesc,
  scrubSecrets,
  estimateTokens,
  computeMinHash,
  estimateJaccardFromMinHash,
  fmtDate,
  fmtTime,
  isoWeekKey,
} from './utils.mjs';

// ─── jaccardSimilarity ──────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 0 for null/undefined/empty inputs', () => {
    expect(jaccardSimilarity(null, 'test')).toBe(0);
    expect(jaccardSimilarity('test', null)).toBe(0);
    expect(jaccardSimilarity('', 'test')).toBe(0);
    expect(jaccardSimilarity(undefined, undefined)).toBe(0);
  });

  it('returns 1 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('is case insensitive', () => {
    expect(jaccardSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('returns 0 for completely disjoint sets', () => {
    expect(jaccardSimilarity('foo bar', 'baz qux')).toBe(0);
  });

  it('returns correct partial overlap', () => {
    // {a, b, c} ∩ {b, c, d} = {b, c}, union = {a, b, c, d}
    const sim = jaccardSimilarity('a b c', 'b c d');
    expect(sim).toBeCloseTo(0.5);
  });

  it('handles single-word strings', () => {
    expect(jaccardSimilarity('test', 'test')).toBe(1);
    expect(jaccardSimilarity('test', 'other')).toBe(0);
  });
});

// ─── truncate ───────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns empty string for falsy inputs', () => {
    expect(truncate(null)).toBe('');
    expect(truncate(undefined)).toBe('');
    expect(truncate('')).toBe('');
  });

  it('returns string unchanged if within limit', () => {
    expect(truncate('short', 80)).toBe('short');
  });

  it('truncates long strings with ellipsis', () => {
    const result = truncate('a'.repeat(100), 10);
    expect(result.length).toBe(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('replaces newlines with spaces', () => {
    expect(truncate('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('trims whitespace', () => {
    expect(truncate('  spaced  ')).toBe('spaced');
  });

  it('uses default max of 80', () => {
    const long = 'a'.repeat(100);
    const result = truncate(long);
    expect(result.length).toBe(80);
  });
});

// ─── typeIcon ───────────────────────────────────────────────────────────────

describe('typeIcon', () => {
  it('returns correct icons for known types', () => {
    expect(typeIcon('decision')).toBe('🟡');
    expect(typeIcon('bugfix')).toBe('🔴');
    expect(typeIcon('feature')).toBe('🟢');
    expect(typeIcon('refactor')).toBe('🔵');
    expect(typeIcon('discovery')).toBe('🔍');
    expect(typeIcon('change')).toBe('📝');
  });

  it('returns default icon for unknown type', () => {
    expect(typeIcon('unknown')).toBe('⚪');
    expect(typeIcon('')).toBe('⚪');
    expect(typeIcon(undefined)).toBe('⚪');
  });
});

// ─── sanitizeFtsQuery ───────────────────────────────────────────────────────

describe('sanitizeFtsQuery', () => {
  it('returns null for empty/null/undefined input', () => {
    expect(sanitizeFtsQuery(null)).toBeNull();
    expect(sanitizeFtsQuery(undefined)).toBeNull();
    expect(sanitizeFtsQuery('')).toBeNull();
  });

  it('returns bare tokens (single words unquoted)', () => {
    expect(sanitizeFtsQuery('hello')).toBe('hello');
    expect(sanitizeFtsQuery('hello world')).toBe('hello world');
  });

  it('preserves hyphens within words (quoted)', () => {
    expect(sanitizeFtsQuery('webpack-dev-server')).toBe('"webpack-dev-server"');
    expect(sanitizeFtsQuery('vue-router next-auth')).toBe('"vue-router" "next-auth"');
  });

  it('strips leading minus (FTS5 NOT operator)', () => {
    expect(sanitizeFtsQuery('-excluded term')).toBe('excluded term');
    expect(sanitizeFtsQuery('term -other')).toBe('term other');
  });

  it('strips FTS5 special characters', () => {
    // "test" now has synonym "spec", so any query containing "test" gets OR-expanded
    expect(sanitizeFtsQuery('test{foo}')).toBe('(test OR spec) AND foo');
    expect(sanitizeFtsQuery('test(bar)')).toBe('(test OR spec) AND bar');
    expect(sanitizeFtsQuery('test[baz]')).toBe('(test OR spec) AND baz');
    expect(sanitizeFtsQuery('a^b~c*d:e')).toBe('a b c d e');
  });

  it('filters out FTS5 boolean keywords', () => {
    expect(sanitizeFtsQuery('hello AND world')).toBe('hello world');
    expect(sanitizeFtsQuery('hello OR world')).toBe('hello world');
    expect(sanitizeFtsQuery('NOT something')).toBe('something');
    expect(sanitizeFtsQuery('hello NEAR world')).toBe('hello world');
  });

  it('is case-insensitive for keywords', () => {
    expect(sanitizeFtsQuery('hello and world')).toBe('hello world');
    expect(sanitizeFtsQuery('hello or world')).toBe('hello world');
  });

  it('quotes tokens with embedded special chars', () => {
    // Token "hello" has embedded quotes (non-alphanumeric) → gets quoted+escaped
    expect(sanitizeFtsQuery('say "hello"')).toBe('say """hello"""');
  });

  it('returns null when all tokens are keywords or special chars', () => {
    expect(sanitizeFtsQuery('AND OR NOT')).toBeNull();
    expect(sanitizeFtsQuery('---')).toBeNull();
    expect(sanitizeFtsQuery('[]{}()')).toBeNull();
  });

  it('handles mixed hyphens and operators', () => {
    // "next-auth" stays quoted (has hyphen), "error" expands via synonym map
    // Uses AND joiner because of parenthesized group
    // "error" now also has semantic synonym "bug" in addition to abbreviation "err"
    expect(sanitizeFtsQuery('-next-auth error')).toBe('"next-auth" AND (error OR err OR bug)');
  });

  it('expands abbreviation synonyms', () => {
    expect(sanitizeFtsQuery('K8s')).toBe('(K8s OR kubernetes)');
    expect(sanitizeFtsQuery('DB')).toBe('(DB OR database)');
    // Multi-token with synonym uses AND joiner
    expect(sanitizeFtsQuery('K8s deployment')).toBe('(K8s OR kubernetes) AND deployment');
  });

  it('expands full forms to abbreviations (bidirectional)', () => {
    expect(sanitizeFtsQuery('database')).toBe('(database OR db)');
    expect(sanitizeFtsQuery('kubernetes')).toBe('(kubernetes OR k8s)');
  });

  it('quotes multi-word synonyms', () => {
    // "ci" expands to (ci OR "continuous integration")
    expect(sanitizeFtsQuery('ci')).toBe('(ci OR "continuous integration")');
  });

  it('leaves tokens without synonyms unchanged', () => {
    expect(sanitizeFtsQuery('foobar')).toBe('foobar');
  });
});

// ─── clampImportance ────────────────────────────────────────────────────────

describe('clampImportance', () => {
  it('returns 1 for non-numeric inputs', () => {
    expect(clampImportance(undefined)).toBe(1);
    expect(clampImportance(null)).toBe(1);
    expect(clampImportance('high')).toBe(1);
    expect(clampImportance(NaN)).toBe(1);
  });

  it('clamps to [1, 3] range', () => {
    expect(clampImportance(0)).toBe(1);
    expect(clampImportance(-5)).toBe(1);
    expect(clampImportance(1)).toBe(1);
    expect(clampImportance(2)).toBe(2);
    expect(clampImportance(3)).toBe(3);
    expect(clampImportance(4)).toBe(3);
    expect(clampImportance(100)).toBe(3);
  });

  it('rounds floats', () => {
    expect(clampImportance(1.4)).toBe(1);
    expect(clampImportance(1.6)).toBe(2);
    expect(clampImportance(2.5)).toBe(3);
  });
});

// ─── computeRuleImportance ──────────────────────────────────────────────────

describe('computeRuleImportance', () => {
  const mkEpisode = (entries) => ({ entries });
  const mkEntry = (overrides = {}) => ({
    tool: 'Bash',
    files: [],
    bashSig: null,
    ...overrides,
  });

  it('returns 1 for routine entries', () => {
    const ep = mkEpisode([mkEntry({ tool: 'Edit', files: ['/src/foo.js'] })]);
    expect(computeRuleImportance(ep)).toBe(1);
  });

  it('returns 3 for test failure (isError + isTest)', () => {
    const ep = mkEpisode([mkEntry({
      bashSig: { isError: true, isTest: true, isBuild: false, isGit: false, isDeploy: false },
    })]);
    expect(computeRuleImportance(ep)).toBe(3);
  });

  it('returns 3 for build failure (isError + isBuild)', () => {
    const ep = mkEpisode([mkEntry({
      bashSig: { isError: true, isTest: false, isBuild: true, isGit: false, isDeploy: false },
    })]);
    expect(computeRuleImportance(ep)).toBe(3);
  });

  it('returns 3 for security files (.env)', () => {
    const ep = mkEpisode([mkEntry({ files: ['/project/.env'] })]);
    expect(computeRuleImportance(ep)).toBe(3);
  });

  it('returns 3 for security files (.pem, .key)', () => {
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/ssl/cert.pem'] })]))).toBe(3);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/ssl/private.key'] })]))).toBe(3);
  });

  it('returns 3 for auth-related files', () => {
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/src/auth.js'] })]))).toBe(3);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/config/credentials.json'] })]))).toBe(3);
  });

  it('returns 3 for migration files', () => {
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/db/migration_001.sql'] })]))).toBe(3);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/prisma/schema.prisma'] })]))).toBe(3);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/alembic/versions/abc.py'] })]))).toBe(3);
  });

  it('returns 2 for non-test/build errors', () => {
    const ep = mkEpisode([mkEntry({
      bashSig: { isError: true, isTest: false, isBuild: false, isGit: false, isDeploy: false },
    })]);
    expect(computeRuleImportance(ep)).toBe(2);
  });

  it('returns 2 for git operations', () => {
    const ep = mkEpisode([mkEntry({
      bashSig: { isError: false, isTest: false, isBuild: false, isGit: true, isDeploy: false },
    })]);
    expect(computeRuleImportance(ep)).toBe(2);
  });

  it('returns 2 for deploy operations', () => {
    const ep = mkEpisode([mkEntry({
      bashSig: { isError: false, isTest: false, isBuild: false, isGit: false, isDeploy: true },
    })]);
    expect(computeRuleImportance(ep)).toBe(2);
  });

  it('returns 2 for config file changes', () => {
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/app/vite.config.ts'] })]))).toBe(2);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/tsconfig.json'] })]))).toBe(2);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/Dockerfile'] })]))).toBe(2);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/docker-compose.yml'] })]))).toBe(2);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/package.json'] })]))).toBe(2);
    expect(computeRuleImportance(mkEpisode([mkEntry({ files: ['/config.yaml'] })]))).toBe(2);
  });

  it('takes the max across multiple entries', () => {
    const ep = mkEpisode([
      mkEntry({ tool: 'Edit', files: ['/src/foo.js'] }),  // importance=1
      mkEntry({ bashSig: { isError: true, isTest: false, isBuild: false, isGit: false, isDeploy: false } }),  // importance=2
    ]);
    expect(computeRuleImportance(ep)).toBe(2);
  });

  it('short-circuits on importance=3', () => {
    const ep = mkEpisode([
      mkEntry({ files: ['/project/.env'] }),  // importance=3, should break
      mkEntry({ tool: 'Edit', files: ['/src/foo.js'] }),  // would be 1
    ]);
    expect(computeRuleImportance(ep)).toBe(3);
  });

  it('handles entries with no bashSig or files', () => {
    const ep = mkEpisode([mkEntry()]);
    expect(computeRuleImportance(ep)).toBe(1);
  });
});

// ─── inferProject ────────────────────────────────────────────────────────────

describe('inferProject', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    // Restore only the keys we modify
    if (origEnv.CLAUDE_PROJECT_DIR !== undefined) process.env.CLAUDE_PROJECT_DIR = origEnv.CLAUDE_PROJECT_DIR;
    else delete process.env.CLAUDE_PROJECT_DIR;
    if (origEnv.PWD !== undefined) process.env.PWD = origEnv.PWD;
    else delete process.env.PWD;
  });

  it('returns parent--basename of CLAUDE_PROJECT_DIR if set', () => {
    process.env.CLAUDE_PROJECT_DIR = '/home/user/my-project';
    expect(inferProject()).toBe('user--my-project');
  });

  it('falls back to PWD if CLAUDE_PROJECT_DIR not set', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.PWD = '/workspace/other-project';
    expect(inferProject()).toBe('workspace--other-project');
  });

  it('falls back to cwd if neither env var set', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.PWD;
    const result = inferProject();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('disambiguates same-name dirs under different parents', () => {
    process.env.CLAUDE_PROJECT_DIR = '/work/app';
    const a = inferProject();
    process.env.CLAUDE_PROJECT_DIR = '/personal/app';
    const b = inferProject();
    expect(a).toBe('work--app');
    expect(b).toBe('personal--app');
    expect(a).not.toBe(b);
  });

  it('returns basename only for root-level directories', () => {
    process.env.CLAUDE_PROJECT_DIR = '/project';
    // dirname('/project') is '/', basename('/') is ''
    // When parent is empty or '/', should return just base
    const result = inferProject();
    expect(result).toBe('project');
  });
});

// ─── detectBashSignificance ──────────────────────────────────────────────────

describe('detectBashSignificance', () => {
  it('detects errors in response (requires length > 30)', () => {
    const result = detectBashSignificance(
      { command: 'npm test' },
      'Error: Cannot find module xyz at require (node:internal/modules/cjs:1234:56)'
    );
    expect(result.isError).toBe(true);
    expect(result.isSignificant).toBe(true);
  });

  it('ignores short error-like responses', () => {
    const result = detectBashSignificance({ command: 'ls' }, 'error');
    expect(result.isError).toBe(false);
  });

  it('detects test commands', () => {
    expect(detectBashSignificance({ command: 'npm test' }, 'ok').isTest).toBe(true);
    expect(detectBashSignificance({ command: 'npx vitest run' }, 'ok').isTest).toBe(true);
    expect(detectBashSignificance({ command: 'pytest tests/' }, 'ok').isTest).toBe(true);
    expect(detectBashSignificance({ command: 'jest --coverage' }, 'ok').isTest).toBe(true);
    expect(detectBashSignificance({ command: 'npx cypress run' }, 'ok').isTest).toBe(true);
    expect(detectBashSignificance({ command: 'npx playwright test' }, 'ok').isTest).toBe(true);
  });

  it('detects build commands', () => {
    expect(detectBashSignificance({ command: 'npm run build' }, 'ok').isBuild).toBe(true);
    expect(detectBashSignificance({ command: 'tsc --noEmit' }, 'ok').isBuild).toBe(true);
    expect(detectBashSignificance({ command: 'npx webpack' }, 'ok').isBuild).toBe(true);
    expect(detectBashSignificance({ command: 'cargo build' }, 'ok').isBuild).toBe(true);
    expect(detectBashSignificance({ command: 'make all' }, 'ok').isBuild).toBe(true);
  });

  it('detects git operations', () => {
    expect(detectBashSignificance({ command: 'git commit -m "msg"' }, 'ok').isGit).toBe(true);
    expect(detectBashSignificance({ command: 'git push origin main' }, 'ok').isGit).toBe(true);
    expect(detectBashSignificance({ command: 'git merge feat' }, 'ok').isGit).toBe(true);
    expect(detectBashSignificance({ command: 'git rebase main' }, 'ok').isGit).toBe(true);
  });

  it('does NOT detect non-mutation git commands', () => {
    expect(detectBashSignificance({ command: 'git status' }, 'ok').isGit).toBe(false);
    expect(detectBashSignificance({ command: 'git log' }, 'ok').isGit).toBe(false);
    expect(detectBashSignificance({ command: 'git diff' }, 'ok').isGit).toBe(false);
  });

  it('detects deploy commands', () => {
    expect(detectBashSignificance({ command: 'docker build .' }, 'ok').isDeploy).toBe(true);
    expect(detectBashSignificance({ command: 'kubectl apply -f k8s/' }, 'ok').isDeploy).toBe(true);
    expect(detectBashSignificance({ command: 'terraform plan' }, 'ok').isDeploy).toBe(true);
  });

  it('returns all false for ordinary commands', () => {
    const result = detectBashSignificance({ command: 'ls -la' }, 'file1 file2');
    expect(result.isError).toBe(false);
    expect(result.isTest).toBe(false);
    expect(result.isBuild).toBe(false);
    expect(result.isGit).toBe(false);
    expect(result.isDeploy).toBe(false);
    expect(result.isSignificant).toBe(false);
  });

  it('isSignificant is true when any flag is true', () => {
    expect(detectBashSignificance({ command: 'npm test' }, 'ok').isSignificant).toBe(true);
    expect(detectBashSignificance({ command: 'npm run build' }, 'ok').isSignificant).toBe(true);
  });

  it('handles missing command gracefully', () => {
    const result = detectBashSignificance({}, 'some output');
    expect(result.isTest).toBe(false);
    expect(result.isBuild).toBe(false);
  });

  it('detects multiple error patterns', () => {
    expect(detectBashSignificance({ command: 'x' }, 'ENOENT: no such file or directory, open').isError).toBe(true);
    expect(detectBashSignificance({ command: 'x' }, 'panic: runtime error: index out of range').isError).toBe(true);
    expect(detectBashSignificance({ command: 'x' }, 'Traceback (most recent call last): in foo.py').isError).toBe(true);
    expect(detectBashSignificance({ command: 'x' }, 'bash: command not found: nonexistent_tool').isError).toBe(true);
  });
});

// ─── extractErrorKeywords ────────────────────────────────────────────────────

describe('extractErrorKeywords', () => {
  it('extracts keywords from command', () => {
    const result = extractErrorKeywords('npm install express', 'Error: EACCES permission denied');
    expect(result).toContain('npm');
    expect(result).toContain('install');
    expect(result).toContain('express');
  });

  it('filters stop words from command', () => {
    const result = extractErrorKeywords('node require test', 'Error: module not found for express');
    // 'node' and 'require' are stop words
    expect(result).not.toContain('node');
    expect(result).not.toContain('require');
  });

  it('extracts keywords from error lines in response', () => {
    const response = 'Loading config...\nError: ModuleNotFoundError for package xyz\nDone.';
    const result = extractErrorKeywords('npm start', response);
    expect(result).toContain('modulenotfounderror');
  });

  it('filters short words from response (<=3 chars)', () => {
    const result = extractErrorKeywords('cmd', 'Error: a bc def ghij in module');
    // 'a' and 'bc' are <=3 chars, should be filtered from response tokens
    expect(result).not.toContain('a');
    expect(result).not.toContain('bc');
  });

  it('returns null for empty/trivial input', () => {
    expect(extractErrorKeywords('', 'ok')).toBeNull();
    // 'ls' is <= 2 chars so filtered from command
    expect(extractErrorKeywords('ls', 'file1 file2')).toBeNull();
  });

  it('limits to 6 keywords', () => {
    const response = 'Error: alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const result = extractErrorKeywords('aaa bbb ccc', response);
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('handles multi-line error responses', () => {
    const response = [
      'npm warn deprecated package@1.0',
      'Error: Cannot find module express',
      'at Function.Module._resolveFilename',
      'TypeError: undefined is not a function',
    ].join('\n');
    const result = extractErrorKeywords('npm start', response);
    expect(result).not.toBeNull();
    expect(result.length).toBeGreaterThan(0);
  });

  it('excludes numeric-only tokens from response', () => {
    const result = extractErrorKeywords('cmd', 'Error at line 1234 in module.js');
    expect(result).not.toContain('1234');
  });
});

// ─── extractFilePaths ────────────────────────────────────────────────────────

describe('extractFilePaths', () => {
  it('extracts file_path from input', () => {
    expect(extractFilePaths({ file_path: '/src/foo.js' })).toEqual(['/src/foo.js']);
  });

  it('extracts path from input', () => {
    expect(extractFilePaths({ path: '/src/bar.ts' })).toEqual(['/src/bar.ts']);
  });

  it('extracts filePath from input', () => {
    expect(extractFilePaths({ filePath: '/src/baz.py' })).toEqual(['/src/baz.py']);
  });

  it('extracts paths from Bash commands', () => {
    const result = extractFilePaths({ command: 'cat /etc/hosts && ls /home/user/project' });
    expect(result).toContain('/etc/hosts');
    expect(result).toContain('/home/user/project');
  });

  it('extracts paths with extensions from commands', () => {
    const result = extractFilePaths({ command: 'node /app/server.mjs' });
    expect(result).toContain('/app/server.mjs');
  });

  it('extracts extensionless paths (Makefile, Dockerfile)', () => {
    const result = extractFilePaths({ command: 'cat /project/Makefile' });
    expect(result).toContain('/project/Makefile');
  });

  it('filters /dev/, /proc/, /tmp/ paths', () => {
    const result = extractFilePaths({ command: 'cat /dev/null /proc/1/status /tmp/test /src/app.js' });
    expect(result).not.toContain('/dev/null');
    expect(result).not.toContain('/proc/1/status');
    expect(result).not.toContain('/tmp/test');
    expect(result).toContain('/src/app.js');
  });

  it('deduplicates paths', () => {
    const result = extractFilePaths({
      file_path: '/src/foo.js',
      command: 'cat /src/foo.js',
    });
    expect(result).toEqual(['/src/foo.js']);
  });

  it('returns empty array for no paths', () => {
    expect(extractFilePaths({})).toEqual([]);
    expect(extractFilePaths({ command: 'echo hello' })).toEqual([]);
  });

  it('combines all path sources', () => {
    const result = extractFilePaths({
      file_path: '/a/one.js',
      path: '/b/two.ts',
      filePath: '/c/three.py',
    });
    expect(result).toContain('/a/one.js');
    expect(result).toContain('/b/two.ts');
    expect(result).toContain('/c/three.py');
  });
});

// ─── parseJsonFromLLM ────────────────────────────────────────────────────────

describe('parseJsonFromLLM', () => {
  it('returns null for null/undefined/empty', () => {
    expect(parseJsonFromLLM(null)).toBeNull();
    expect(parseJsonFromLLM(undefined)).toBeNull();
    expect(parseJsonFromLLM('')).toBeNull();
  });

  it('parses valid JSON directly', () => {
    const obj = { type: 'bugfix', title: 'Fix login' };
    expect(parseJsonFromLLM(JSON.stringify(obj))).toEqual(obj);
  });

  it('parses JSON in fenced code block', () => {
    const text = 'Here is the result:\n```json\n{"type":"feature","title":"Add search"}\n```\nDone.';
    expect(parseJsonFromLLM(text)).toEqual({ type: 'feature', title: 'Add search' });
  });

  it('parses JSON in unfenced code block', () => {
    const text = 'Result:\n```\n{"type":"refactor","title":"Clean up"}\n```';
    expect(parseJsonFromLLM(text)).toEqual({ type: 'refactor', title: 'Clean up' });
  });

  it('extracts JSON object from mixed text', () => {
    const text = 'The observation is: {"type":"discovery","title":"Found pattern"} as shown above.';
    expect(parseJsonFromLLM(text)).toEqual({ type: 'discovery', title: 'Found pattern' });
  });

  it('returns null for unparseable text', () => {
    expect(parseJsonFromLLM('just plain text')).toBeNull();
    expect(parseJsonFromLLM('no json here {{')).toBeNull();
  });

  it('handles nested JSON objects', () => {
    const obj = { type: 'bugfix', meta: { severity: 'high' } };
    expect(parseJsonFromLLM(JSON.stringify(obj))).toEqual(obj);
  });

  it('handles JSON with arrays', () => {
    const obj = { concepts: ['auth', 'jwt'], facts: ['uses bcrypt'] };
    expect(parseJsonFromLLM(JSON.stringify(obj))).toEqual(obj);
  });
});

// ─── stripTestSuffix ─────────────────────────────────────────────────────────

describe('stripTestSuffix', () => {
  it('strips .test. suffix', () => {
    expect(stripTestSuffix('/src/auth.test.ts')).toBe('auth.ts');
  });

  it('strips .spec. suffix', () => {
    expect(stripTestSuffix('/tests/auth.spec.js')).toBe('auth.js');
  });

  it('strips .e2e. suffix', () => {
    expect(stripTestSuffix('/e2e/auth.e2e.ts')).toBe('auth.ts');
  });

  it('leaves non-test files unchanged', () => {
    expect(stripTestSuffix('/src/auth.ts')).toBe('auth.ts');
    expect(stripTestSuffix('/src/test-utils.js')).toBe('test-utils.js');
  });

  it('is case insensitive', () => {
    expect(stripTestSuffix('/src/auth.Test.ts')).toBe('auth.ts');
    expect(stripTestSuffix('/src/auth.SPEC.js')).toBe('auth.js');
  });
});

// ─── isRelatedToEpisode ──────────────────────────────────────────────────────

describe('isRelatedToEpisode', () => {
  const mkEpisode = (files) => ({ files });

  it('returns true when newFiles is empty', () => {
    expect(isRelatedToEpisode(mkEpisode(['/a/foo.js']), [])).toBe(true);
  });

  it('returns true when episode.files is empty', () => {
    expect(isRelatedToEpisode(mkEpisode([]), ['/b/bar.js'])).toBe(true);
  });

  it('returns true for same file', () => {
    expect(isRelatedToEpisode(mkEpisode(['/src/app.js']), ['/src/app.js'])).toBe(true);
  });

  it('returns true for same directory', () => {
    expect(isRelatedToEpisode(mkEpisode(['/src/foo.js']), ['/src/bar.js'])).toBe(true);
  });

  it('returns false for unrelated files in different directories', () => {
    expect(isRelatedToEpisode(mkEpisode(['/src/foo.js']), ['/test/bar.js'])).toBe(false);
  });

  it('returns true for test file ↔ source file siblings', () => {
    // auth.ts ↔ auth.test.ts (different directories)
    expect(isRelatedToEpisode(mkEpisode(['/src/auth.ts']), ['/tests/auth.test.ts'])).toBe(true);
    // auth.js ↔ auth.spec.js
    expect(isRelatedToEpisode(mkEpisode(['/src/auth.js']), ['/tests/auth.spec.js'])).toBe(true);
    // auth.ts ↔ auth.e2e.ts
    expect(isRelatedToEpisode(mkEpisode(['/src/auth.ts']), ['/e2e/auth.e2e.ts'])).toBe(true);
  });

  it('does not false-positive on unrelated test files', () => {
    // auth.ts ↔ login.test.ts (different base name)
    expect(isRelatedToEpisode(mkEpisode(['/src/auth.ts']), ['/tests/login.test.ts'])).toBe(false);
  });

  it('returns true if any file pair overlaps', () => {
    expect(isRelatedToEpisode(
      mkEpisode(['/src/a.js', '/lib/b.js']),
      ['/test/c.js', '/src/d.js']  // /src/ overlaps
    )).toBe(true);
  });

  it('handles deeply nested paths', () => {
    expect(isRelatedToEpisode(
      mkEpisode(['/a/b/c/foo.js']),
      ['/a/b/c/bar.js']
    )).toBe(true);
    expect(isRelatedToEpisode(
      mkEpisode(['/a/b/c/foo.js']),
      ['/a/b/d/bar.js']
    )).toBe(false);
  });
});

// ─── makeEntryDesc ───────────────────────────────────────────────────────────

describe('makeEntryDesc', () => {
  it('describes Edit tool', () => {
    const desc = makeEntryDesc('Edit', {
      file_path: '/src/app.js',
      old_string: 'const x = 1',
      new_string: 'const x = 2',
    }, '');
    expect(desc).toContain('app.js');
    expect(desc).toContain('const x = 1');
    expect(desc).toContain('const x = 2');
    expect(desc).toContain('→');
  });

  it('describes Write tool', () => {
    const desc = makeEntryDesc('Write', {
      file_path: '/src/new.js',
      content: 'hello world',
    }, '');
    expect(desc).toContain('Created');
    expect(desc).toContain('new.js');
    expect(desc).toContain('11 chars');
  });

  it('describes NotebookEdit tool', () => {
    const desc = makeEntryDesc('NotebookEdit', {
      new_source: 'import pandas as pd',
    }, '');
    expect(desc).toContain('Notebook cell');
    expect(desc).toContain('import pandas');
  });

  it('describes Bash tool without error', () => {
    const desc = makeEntryDesc('Bash', { command: 'ls -la' }, 'file1 file2');
    expect(desc).toContain('ls -la');
    expect(desc).toContain('file1 file2');
    expect(desc).not.toContain('ERROR');
  });

  it('describes Bash tool with error', () => {
    const longErr = 'Error: something went wrong in the module loader';
    const desc = makeEntryDesc('Bash', { command: 'npm start' }, longErr);
    expect(desc).toContain('npm start');
    expect(desc).toContain('ERROR');
  });

  it('describes Grep tool', () => {
    const desc = makeEntryDesc('Grep', { pattern: 'TODO' }, 'src/foo.js:10: TODO fix');
    expect(desc).toContain('Search');
    expect(desc).toContain('TODO');
  });

  it('describes LSP tool', () => {
    const desc = makeEntryDesc('LSP', { operation: 'goToDefinition', filePath: '/src/types.ts' }, '');
    expect(desc).toContain('goToDefinition');
    expect(desc).toContain('types.ts');
  });

  it('describes Task tool', () => {
    const desc = makeEntryDesc('Task', { description: 'Explore auth module' }, '');
    expect(desc).toContain('Explore auth module');
  });

  it('describes WebSearch tool', () => {
    const desc = makeEntryDesc('WebSearch', { query: 'react hooks' }, '');
    expect(desc).toContain('Web:');
    expect(desc).toContain('react hooks');
  });

  it('describes WebFetch tool', () => {
    const desc = makeEntryDesc('WebFetch', { url: 'https://example.com' }, '');
    expect(desc).toContain('Fetch:');
    expect(desc).toContain('example.com');
  });

  it('handles unknown tools', () => {
    const desc = makeEntryDesc('CustomTool', {}, 'some result');
    expect(desc).toContain('CustomTool:');
    expect(desc).toContain('some result');
  });

  it('handles missing input fields gracefully', () => {
    expect(() => makeEntryDesc('Edit', {}, '')).not.toThrow();
    expect(() => makeEntryDesc('Bash', {}, '')).not.toThrow();
    expect(() => makeEntryDesc('Write', {}, '')).not.toThrow();
  });
});

// ─── scrubSecrets ────────────────────────────────────────────────────────────

describe('scrubSecrets', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(scrubSecrets(null)).toBe('');
    expect(scrubSecrets(undefined)).toBe('');
    expect(scrubSecrets('')).toBe('');
  });

  it('passes through text with no secrets', () => {
    const text = 'normal log output with no secrets';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('scrubs key=value password assignments', () => {
    expect(scrubSecrets('password=hunter2')).toBe('password=***');
    expect(scrubSecrets('token=abc123xyz')).toBe('token=***');
    expect(scrubSecrets('api_key=sk-mykey123')).toBe('api_key=***');
    expect(scrubSecrets('API_SECRET=mysecretvalue')).toBe('API_SECRET=***');
  });

  it('scrubs key: value style assignments', () => {
    expect(scrubSecrets('password: hunter2')).toBe('password: ***');
    expect(scrubSecrets('auth_token: bearer123')).toBe('auth_token: ***');
  });

  it('scrubs AWS access keys', () => {
    expect(scrubSecrets('key is AKIAIOSFODNN7EXAMPLE')).toBe('key is ***');
  });

  it('scrubs OpenAI/Anthropic keys (sk-...)', () => {
    expect(scrubSecrets('using sk-proj-abc123def456ghi789jkl')).toBe('using ***');
  });

  it('scrubs GitHub tokens', () => {
    expect(scrubSecrets('token: ghp_' + 'a'.repeat(36))).toBe('token: ***');
    expect(scrubSecrets('github_pat_' + 'b'.repeat(40))).toBe('***');
  });

  it('scrubs GitLab tokens', () => {
    expect(scrubSecrets('glpat-' + 'x'.repeat(20))).toBe('***');
  });

  it('scrubs Slack tokens', () => {
    expect(scrubSecrets('xoxb-123456789-abcdefghij')).toBe('***');
    expect(scrubSecrets('xoxp-token-value-here')).toBe('***');
  });

  it('scrubs JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF';
    expect(scrubSecrets(`bearer ${jwt}`)).toBe('bearer ***');
  });

  it('scrubs PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    expect(scrubSecrets(`config: ${pem} done`)).toBe('config: ***PEM_KEY*** done');
  });

  it('scrubs long hex strings in key assignments', () => {
    const hex = 'a'.repeat(40);
    expect(scrubSecrets(`secret=${hex}`)).toBe('secret=***');
  });

  it('preserves key names while scrubbing values', () => {
    const result = scrubSecrets('password=secret123 token=abc user=john');
    expect(result).toContain('password=***');
    expect(result).toContain('token=***');
    expect(result).toContain('user=john'); // not a secret key
  });

  it('handles multiple secrets in one string', () => {
    const text = 'password=hunter2 and api_key=sk-secret123key456val';
    const result = scrubSecrets(text);
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('sk-secret123key456val');
  });

  it('scrubs database connection strings', () => {
    expect(scrubSecrets('postgresql://admin:secret@db.host:5432/mydb')).toBe('postgresql://***');
    expect(scrubSecrets('mongodb+srv://user:pass@cluster.net/db')).toBe('mongodb+srv://***');
    expect(scrubSecrets('mysql://root:password@localhost/app')).toBe('mysql://***');
    expect(scrubSecrets('redis://default:token@redis.cloud:6379')).toBe('redis://***');
  });

  it('scrubs npm tokens', () => {
    expect(scrubSecrets('npm_abcdefghijklmnopqrstuvwxyz0123456789AB')).toBe('***');
  });

  it('scrubs Stripe keys', () => {
    expect(scrubSecrets('sk_live_abcdefghijklmnopqrstuv')).toBe('***');
    expect(scrubSecrets('pk_test_abcdefghijklmnopqrstuv')).toBe('***');
  });
});

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns ceil(length/4) for normal text', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
  });

  it('returns 1 for empty string', () => {
    expect(estimateTokens('')).toBe(1); // ceil(0 || 1 / 4) = 1
  });

  it('returns 1 for null/undefined', () => {
    expect(estimateTokens(null)).toBe(1);
    expect(estimateTokens(undefined)).toBe(1);
  });

  it('handles long strings', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

// ─── computeMinHash ──────────────────────────────────────────────────────────

describe('computeMinHash', () => {
  it('returns consistent signatures for same text', () => {
    const sig1 = computeMinHash('fixed authentication bug in login flow');
    const sig2 = computeMinHash('fixed authentication bug in login flow');
    expect(sig1).toBe(sig2);
  });

  it('detects similar text (high estimated Jaccard)', () => {
    const sig1 = computeMinHash('fixed authentication bug in login flow');
    const sig2 = computeMinHash('fixed authentication bug in the login flow');
    const similarity = estimateJaccardFromMinHash(sig1, sig2);
    expect(similarity).toBeGreaterThan(0.5);
  });

  it('rejects dissimilar text (low estimated Jaccard)', () => {
    const sig1 = computeMinHash('fixed authentication bug in login flow');
    const sig2 = computeMinHash('database migration schema update for users table');
    const similarity = estimateJaccardFromMinHash(sig1, sig2);
    expect(similarity).toBeLessThan(0.3);
  });

  it('returns null for null/empty/undefined', () => {
    expect(computeMinHash(null)).toBeNull();
    expect(computeMinHash('')).toBeNull();
    expect(computeMinHash(undefined)).toBeNull();
  });

  it('returns null for text with only short words', () => {
    expect(computeMinHash('a b c')).toBeNull();
  });

  it('returns hex string of correct length', () => {
    const sig = computeMinHash('this is a test string with some words');
    expect(sig).not.toBeNull();
    expect(sig.length).toBe(64 * 8); // 64 hashes × 8 hex chars each
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });
});

// ─── estimateJaccardFromMinHash ─────────────────────────────────────────────

describe('estimateJaccardFromMinHash', () => {
  it('returns 1 for identical signatures', () => {
    const sig = computeMinHash('the quick brown fox jumps over lazy dog');
    expect(estimateJaccardFromMinHash(sig, sig)).toBe(1);
  });

  it('returns 0 for null inputs', () => {
    expect(estimateJaccardFromMinHash(null, 'abc')).toBe(0);
    expect(estimateJaccardFromMinHash('abc', null)).toBe(0);
    expect(estimateJaccardFromMinHash(null, null)).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(estimateJaccardFromMinHash('abcd', 'abcdef')).toBe(0);
  });

  it('returns 0 for empty strings', () => {
    expect(estimateJaccardFromMinHash('', '')).toBe(0);
  });
});

// ─── fmtDate ────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('returns empty string for falsy input', () => {
    expect(fmtDate('')).toBe('');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
  });

  it('formats ISO date to "Mon DD HH:MM"', () => {
    // Jan 15, 2026, 14:30 UTC
    const result = fmtDate(new Date(2026, 0, 15, 14, 30).toISOString());
    expect(result).toMatch(/Jan 15 14:30/);
  });
});

// ─── fmtTime ────────────────────────────────────────────────────────────────

describe('fmtTime', () => {
  it('returns empty string for falsy input', () => {
    expect(fmtTime('')).toBe('');
    expect(fmtTime(null)).toBe('');
  });

  it('formats ISO date to "HH:MM"', () => {
    const result = fmtTime(new Date(2026, 0, 15, 9, 5).toISOString());
    expect(result).toBe('09:05');
  });
});

// ─── isoWeekKey ─────────────────────────────────────────────────────────────

describe('isoWeekKey', () => {
  it('returns correct week for mid-year date', () => {
    // 2026-06-15 is a Monday, ISO week 25
    const epoch = new Date(2026, 5, 15).getTime();
    expect(isoWeekKey(epoch)).toBe('2026-W25');
  });

  it('handles Dec 31 that falls in week 1 of next year', () => {
    // 2025-12-31 is a Wednesday → ISO week 1 of 2026
    const epoch = new Date(2025, 11, 31).getTime();
    expect(isoWeekKey(epoch)).toBe('2026-W01');
  });

  it('handles Jan 1 that falls in last week of prev year', () => {
    // 2027-01-01 is a Friday → still ISO week 53 of 2026
    const epoch = new Date(2027, 0, 1).getTime();
    expect(isoWeekKey(epoch)).toBe('2026-W53');
  });

  it('handles Jan 4 (always in week 1)', () => {
    // Jan 4 is always in ISO week 1 by definition
    const epoch = new Date(2026, 0, 4).getTime();
    expect(isoWeekKey(epoch)).toBe('2026-W01');
  });

  it('pads week number to 2 digits', () => {
    const epoch = new Date(2026, 0, 5).getTime(); // W02
    expect(isoWeekKey(epoch)).toMatch(/W\d{2}$/);
  });
});
