// Regression tests (round-5 audit): a query token that can never match the FTS
// index must not become a REQUIRED AND term, which silently zeroes strict FTS.
//
// Two query-construction bugs in nlp.mjs, both surfaced by this build's real
// tokenizer behaviour (verified via fts5vocab, SQLite 3.53.1): unicode61
// indexes an ENTIRE CJK run as ONE token — it does NOT split each CJK char.
// CJK text is made searchable because the write path stores the content PLUS
// its space-separated overlapping bigrams.
//
//   [MED] nlp.mjs sanitizeFtsQuery — a pure-CJK run with no dictionary word was
//         pushed VERBATIM as the whole unsegmented token alongside its bigrams,
//         all AND-joined. The whole sub-run token ("同义词扩展") is stored as
//         NEITHER the longer whole-run token NOR any 2-char bigram, so the
//         strict AND was unsatisfiable → strict FTS returned 0 for every
//         out-of-dictionary CJK term; only relaxFtsQueryToOr salvaged recall.
//   [LOW] nlp.mjs ftsToken — a token with zero index-able chars (emoji 💥,
//         symbols ★☆✦) was phrase-quoted ("💥") into a required AND term that
//         can never match. A multi-token query is rescued by the OR fallback,
//         but a lone-emoji query (one token) has no OR recovery.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { sanitizeFtsQuery, relaxFtsQueryToOr } from '../nlp.mjs';

// Exact production tokenizer config (schema.mjs events_fts / observations_fts).
const TOKENIZE = "unicode61 remove_diacritics 2 tokenchars '_-'";

describe('sanitizeFtsQuery — unmatchable-token strict-AND regressions (round-5)', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(content, tokenize="${TOKENIZE}")`);
  });
  afterEach(() => db.close());

  const matchCount = (q) => db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(q).c;

  it('[MED] out-of-dictionary pure-CJK term: strict AND matches the stored row', () => {
    // Real write-path shape: content + space-separated overlapping bigrams.
    // "同义词扩展" is a sub-run of the content; the index holds it only via the
    // longer whole-run token and via 同义/义词/词扩/扩展 — never as itself.
    const stored =
      '我们给检索加了同义词扩展功能 我们 们给 给检 检索 索加 加了 了同 同义 义词 词扩 扩展 展功 功能';
    db.prepare('INSERT INTO t(content) VALUES (?)').run(stored);

    const strict = sanitizeFtsQuery('同义词扩展');
    expect(strict).not.toBeNull();
    // The whole unsegmented token must NOT survive as a required term — it can
    // match neither the stored full-run token nor the stored bigrams.
    expect(strict.split(/\s+/)).not.toContain('同义词扩展');
    // Strict (AND) now matches via the bigrams the index actually holds.
    expect(matchCount(strict)).toBe(1);
    // The OR fallback still matches too (recall was previously ONLY here).
    expect(matchCount(relaxFtsQueryToOr(strict))).toBe(1);
  });

  it('[MED] mixed-script token stays WHOLE (latin literal anchor preserved)', () => {
    // Must NOT bigram the CJK suffix of a latin+CJK token — the latin portion
    // is a strong literal anchor; bigramming over-recalls onto unrelated docs.
    const out = sanitizeFtsQuery('xyzAbc不存在');
    expect(out).toContain('xyzAbc不存在');
    // No standalone CJK-suffix bigram leaked as a separate token.
    const terms = out.split(/\s+/);
    expect(terms).not.toContain('存在');
    expect(terms).not.toContain('不存');
  });

  it('[LOW] emoji token is dropped, not phrase-quoted into a required term', () => {
    db.prepare('INSERT INTO t(content) VALUES (?)').run('payment timeout regression');
    const strict = sanitizeFtsQuery('payment 💥 timeout');
    expect(strict).not.toBeNull();
    // No unmatchable "💥" required term poisoning the AND.
    expect(strict).not.toContain('💥');
    // Strict AND still matches the row on the real words alone.
    expect(matchCount(strict)).toBe(1);
  });

  it('[LOW] pure non-indexable query produces no unsatisfiable term (returns null)', () => {
    // Single non-indexable token → nothing to search → null. There is no OR
    // recovery for a one-token query, so an unmatchable "💥🔥" would be a dead
    // end; null lets the caller skip FTS instead.
    expect(sanitizeFtsQuery('💥🔥')).toBeNull();
    expect(sanitizeFtsQuery('★☆✦')).toBeNull();
  });

  it('[R1] keeps non-Latin/non-Han script tokens (Cyrillic/Greek/kana/Hangul/Thai/accented)', () => {
    // The drop filter must gate on any Unicode letter/number (\p{L}/\p{N}), NOT an ASCII+Han
    // allowlist: unicode61 indexes every script's letters, so the allowlist silently killed
    // search for all non-Latin/non-Han scripts (round-5 review regression).
    for (const q of ['привет', 'λόγος', 'テスト', '한국어', 'สวัสดี', 'café']) {
      expect(sanitizeFtsQuery(q), `${q} must survive sanitization (it IS FTS-indexable)`).not.toBeNull();
    }
    // ...while true symbols/emoji are still dropped.
    expect(sanitizeFtsQuery('💥')).toBeNull();
    expect(sanitizeFtsQuery('★☆')).toBeNull();
    // a mixed script+emoji query keeps the letters, drops the emoji.
    expect(sanitizeFtsQuery('привет 💥')).toBe('"привет"');
  });
});
