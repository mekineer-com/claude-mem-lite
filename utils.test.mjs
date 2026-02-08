import { describe, it, expect } from 'vitest';
import {
  jaccardSimilarity,
  truncate,
  typeIcon,
  sanitizeFtsQuery,
  clampImportance,
  computeRuleImportance,
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

  it('wraps simple tokens in double quotes', () => {
    expect(sanitizeFtsQuery('hello')).toBe('"hello"');
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
  });

  it('preserves hyphens within words', () => {
    expect(sanitizeFtsQuery('webpack-dev-server')).toBe('"webpack-dev-server"');
    expect(sanitizeFtsQuery('vue-router next-auth')).toBe('"vue-router" "next-auth"');
  });

  it('strips leading minus (FTS5 NOT operator)', () => {
    expect(sanitizeFtsQuery('-excluded term')).toBe('"excluded" "term"');
    expect(sanitizeFtsQuery('term -other')).toBe('"term" "other"');
  });

  it('strips FTS5 special characters', () => {
    expect(sanitizeFtsQuery('test{foo}')).toBe('"test" "foo"');
    expect(sanitizeFtsQuery('test(bar)')).toBe('"test" "bar"');
    expect(sanitizeFtsQuery('test[baz]')).toBe('"test" "baz"');
    expect(sanitizeFtsQuery('a^b~c*d:e')).toBe('"a" "b" "c" "d" "e"');
  });

  it('filters out FTS5 boolean keywords', () => {
    expect(sanitizeFtsQuery('hello AND world')).toBe('"hello" "world"');
    expect(sanitizeFtsQuery('hello OR world')).toBe('"hello" "world"');
    expect(sanitizeFtsQuery('NOT something')).toBe('"something"');
    expect(sanitizeFtsQuery('hello NEAR world')).toBe('"hello" "world"');
  });

  it('is case-insensitive for keywords', () => {
    expect(sanitizeFtsQuery('hello and world')).toBe('"hello" "world"');
    expect(sanitizeFtsQuery('hello or world')).toBe('"hello" "world"');
  });

  it('escapes double quotes in tokens', () => {
    expect(sanitizeFtsQuery('say "hello"')).toBe('"say" """hello"""');
  });

  it('returns null when all tokens are keywords or special chars', () => {
    expect(sanitizeFtsQuery('AND OR NOT')).toBeNull();
    expect(sanitizeFtsQuery('---')).toBeNull();
    expect(sanitizeFtsQuery('[]{}()')).toBeNull();
  });

  it('handles mixed hyphens and operators', () => {
    expect(sanitizeFtsQuery('-next-auth error')).toBe('"next-auth" "error"');
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
