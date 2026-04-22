// 3-way equivalence sync test for LOW_SIGNAL patterns.
//
// Before method β: utils.mjs regex / scoring-sql.mjs NOT LIKE / pre-tool-recall.js
// inline SQL were hand-mirrored via "keep in sync" comments. This test gives CI
// teeth to catch drift by running the same 40+ title samples through all three
// paths and asserting they agree on every sample.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { LOW_SIGNAL_PATTERNS, buildLowSignalRegex, buildNotLowSignalSql } from '../lib/low-signal-patterns.mjs';
import { LOW_SIGNAL_TITLE } from '../utils.mjs';
import { notLowSignalTitleClause } from '../scoring-sql.mjs';

// Sample titles that cover every pattern + a set of legitimate titles that
// must NOT be flagged. Seeded to make the test deterministic and exhaustive
// w.r.t. the 12 patterns.
const SAMPLES = [
  // Should match (LOW_SIGNAL = true)
  { t: 'Modified install.mjs',                              low: true },
  { t: 'Modified hook-llm.mjs, utils.mjs +3 more',          low: true },
  { t: 'Worked on schema.mjs',                              low: true },
  { t: 'Reviewed 7 files: a.mjs, b.mjs',                    low: true },
  { t: 'Reviewed 12 files: x.mjs',                          low: true },
  { t: 'Codebase exploration: projects--mem schema, FTS5',  low: true },
  { t: 'Codebase exploration of session hook generation',   low: true },
  { t: 'Error while working on tests/foo.test.mjs',         low: true },
  { t: 'Error in tests/bar.test.mjs:42',                    low: true },
  { t: 'Error: hook.mjs, hook-episode.mjs: 145|proj|raw',   low: true },
  { t: '# This is a raw shell stdout dump',                 low: true },
  { t: 'node cli.mjs doctor',                               low: true },
  { t: 'npm install --save',                                low: true },
  { t: 'npx some-tool run',                                 low: true },
  { t: '(no description) — fallback',                       low: true },
  { t: 'gh release list ... (error)',                       low: true },
  { t: 'bash command failed (error)',                       low: true },

  // Should NOT match (legitimate titles — real lessons/bugfixes/decisions)
  { t: 'doctor dep checks: use import probe not path check', low: false },
  { t: 'title dedup must happen at basename layer',          low: false },
  { t: 'hook-update SOURCE_FILES drift',                     low: false },
  { t: 'FTS5 external-content delete trigger needs orig values', low: false },
  { t: 'handoff injection misread as user message',          low: false },
  { t: 'rebuildVector wrote vectors to wrong table/column',  low: false },
  { t: 'Heterogeneous hook events get heterogeneous context budgets', low: false },
  { t: 'pre-tool-recall Edit fallback must stack filters',   low: false },
  { t: 'Batch A: CLI↔MCP parity fields',                     low: false },
  { t: 'dev-drift detection: symlink/plain mix',             low: false },
  { t: 'Fix weak regex in makeEntryDesc',                    low: false },
  { t: 'v2.34.1 UX audit — 4 fixes',                         low: false },
  { t: 'Version bump 2.34.5 → 2.34.6',                       low: false },
  { t: 'measure signal-content of blocked set',              low: false },

  // Edge cases
  { t: '',                                                   low: false },  // empty should be benign
  { t: 'Error out of memory — genuine crash report',         low: true },   // "Error: " prefix catches this
  // wait, "Error out" doesn't match any pattern (no colon). Let me re-check.
];

// Fix: "Error out of memory" — no pattern matches (no colon or 'in '/'while working').
// Correct the edge case.
SAMPLES[SAMPLES.length - 1] = { t: 'Error out of memory — genuine crash report', low: false };

describe('LOW_SIGNAL patterns — 3-way equivalence', () => {
  let db;

  // Build an in-memory DB with a `titles(title)` table seeded with SAMPLES,
  // then run the SQL NOT LIKE clause against it to check equivalence.
  function sqlSignalsMatch(title) {
    if (!db) {
      db = new Database(':memory:');
      db.exec('CREATE TABLE t (title TEXT)');
    }
    db.prepare('DELETE FROM t').run();
    db.prepare('INSERT INTO t(title) VALUES (?)').run(title);
    // title is LOW_SIGNAL iff NOT (notLowSignalTitleClause) evaluates true
    const row = db.prepare(`SELECT NOT ${notLowSignalTitleClause('t')} AS is_low FROM t`).get();
    return row.is_low === 1;
  }

  function moduleSqlMatches(title) {
    if (!db) {
      db = new Database(':memory:');
      db.exec('CREATE TABLE t (title TEXT)');
    }
    db.prepare('DELETE FROM t').run();
    db.prepare('INSERT INTO t(title) VALUES (?)').run(title);
    const row = db.prepare(`SELECT NOT ${buildNotLowSignalSql('t')} AS is_low FROM t`).get();
    return row.is_low === 1;
  }

  it('utils.mjs regex agrees with ground-truth labels on all samples', () => {
    for (const { t, low } of SAMPLES) {
      const matched = LOW_SIGNAL_TITLE.test(t);
      expect(matched).toBe(low);
    }
  });

  it('scoring-sql.mjs NOT LIKE agrees with ground-truth labels on all samples', () => {
    for (const { t, low } of SAMPLES) {
      expect(sqlSignalsMatch(t)).toBe(low);
    }
  });

  it('low-signal-patterns.mjs buildNotLowSignalSql agrees with ground-truth labels', () => {
    for (const { t, low } of SAMPLES) {
      expect(moduleSqlMatches(t)).toBe(low);
    }
  });

  it('low-signal-patterns.mjs buildLowSignalRegex agrees with utils.mjs regex', () => {
    const modRegex = buildLowSignalRegex();
    for (const { t } of SAMPLES) {
      expect(modRegex.test(t)).toBe(LOW_SIGNAL_TITLE.test(t));
    }
  });

  it('utils.mjs regex ↔ scoring-sql.mjs SQL give identical verdicts (symmetry guard)', () => {
    for (const { t } of SAMPLES) {
      const regexSaysLow = LOW_SIGNAL_TITLE.test(t);
      const sqlSaysLow = sqlSignalsMatch(t);
      expect(sqlSaysLow).toBe(regexSaysLow);
    }
  });

  it('scripts/pre-tool-recall.js derives from lib/low-signal-patterns.mjs (no inline SQL)', () => {
    // β refactor: pre-tool-recall should import buildNotLowSignalSql, NOT
    // maintain its own hardcoded NOT LIKE list. This guards against regression
    // back to the drift-prone inline pattern.
    const src = readFileSync('scripts/pre-tool-recall.js', 'utf8');
    expect(src).toContain("import { buildNotLowSignalSql }");
    expect(src).toContain("from '../lib/low-signal-patterns.mjs'");

    // Verify NO stray "o.title NOT LIKE 'Xxx %'" hardcoded patterns remain.
    // (A single call site using buildNotLowSignalSql('o') is allowed — that
    // produces runtime SQL, not a source-file literal.)
    const inlineHits = src.match(/o\.title NOT LIKE '[^']+'/g);
    expect(inlineHits).toBeNull();
  });

  it('all 12 patterns from LOW_SIGNAL_PATTERNS are covered by at least one sample', () => {
    // Coverage guard — if we add a pattern, ensure a sample exercises it
    const coverage = new Set();
    for (const { t, low } of SAMPLES) {
      if (!low) continue;
      for (const { regex } of LOW_SIGNAL_PATTERNS) {
        if (new RegExp(regex).test(t)) coverage.add(regex);
      }
    }
    expect(coverage.size).toBe(LOW_SIGNAL_PATTERNS.length);
  });
});
