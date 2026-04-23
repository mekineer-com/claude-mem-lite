import { describe, it, expect } from 'vitest';
import { SYNONYM_MAP, SYNONYM_PAIRS, DISPATCH_SYNONYMS, CJK_COMPOUNDS } from '../synonyms.mjs';

describe('unified synonyms', () => {
  describe('SYNONYM_MAP', () => {
    it('is a Map', () => {
      expect(SYNONYM_MAP).toBeInstanceOf(Map);
    });

    it('is bidirectional for abbreviation pairs', () => {
      expect(SYNONYM_MAP.get('db')).toContain('database');
      expect(SYNONYM_MAP.get('database')).toContain('db');
    });

    it('is bidirectional for semantic equivalents', () => {
      expect(SYNONYM_MAP.get('bug')).toContain('error');
      expect(SYNONYM_MAP.get('error')).toContain('bug');
    });

    it('has CJK cross-language pairs', () => {
      expect(SYNONYM_MAP.has('数据库')).toBe(true);
      expect(SYNONYM_MAP.get('数据库')).toContain('database');
      expect(SYNONYM_MAP.get('数据库')).toContain('db');
    });

    it('values are Sets (not arrays)', () => {
      const dbSynonyms = SYNONYM_MAP.get('db');
      expect(dbSynonyms).toBeInstanceOf(Set);
    });

    it('is case-insensitive (keys are lowercase)', () => {
      // All keys should be lowercase
      for (const key of SYNONYM_MAP.keys()) {
        if (/^[a-zA-Z]+$/.test(key)) {
          expect(key).toBe(key.toLowerCase());
        }
      }
    });
  });

  describe('SYNONYM_PAIRS', () => {
    it('is an array of [string, string] tuples', () => {
      expect(Array.isArray(SYNONYM_PAIRS)).toBe(true);
      expect(SYNONYM_PAIRS.length).toBeGreaterThan(50);
      for (const pair of SYNONYM_PAIRS) {
        expect(pair).toHaveLength(2);
        expect(typeof pair[0]).toBe('string');
        expect(typeof pair[1]).toBe('string');
      }
    });

    it('contains expected abbreviation pairs', () => {
      const dbPair = SYNONYM_PAIRS.find(([a, b]) => a === 'db' || b === 'db');
      expect(dbPair).toBeTruthy();
    });

    it('contains CJK pairs', () => {
      const cjkPair = SYNONYM_PAIRS.find(([a]) => /[\u4e00-\u9fff]/.test(a));
      expect(cjkPair).toBeTruthy();
    });
  });

  describe('DISPATCH_SYNONYMS', () => {
    it('is a plain object', () => {
      expect(typeof DISPATCH_SYNONYMS).toBe('object');
      expect(DISPATCH_SYNONYMS).not.toBeNull();
    });

    it('has broader groupings for dispatch', () => {
      expect(DISPATCH_SYNONYMS.test).toBeDefined();
      expect(DISPATCH_SYNONYMS.test.length).toBeGreaterThan(5);
    });

    it('has English intent keys', () => {
      expect(DISPATCH_SYNONYMS.fix).toBeDefined();
      expect(DISPATCH_SYNONYMS.deploy).toBeDefined();
      expect(DISPATCH_SYNONYMS.db).toBeDefined();
    });

    it('has Chinese intent keys', () => {
      expect(DISPATCH_SYNONYMS['测试']).toBeDefined();
      expect(DISPATCH_SYNONYMS['修复']).toBeDefined();
      expect(DISPATCH_SYNONYMS['部署']).toBeDefined();
    });

    it('values are arrays of strings', () => {
      for (const [key, val] of Object.entries(DISPATCH_SYNONYMS)) {
        expect(Array.isArray(val), `${key} should be an array`).toBe(true);
        for (const v of val) {
          expect(typeof v, `${key} values should be strings`).toBe('string');
        }
      }
    });
  });

  describe('React hook API bridge (recall fix for hard_negative_precision q32)', () => {
    it('bridges hooks ↔ useEffect, useState, useCallback, useMemo, useRef, useContext', () => {
      const hooks = SYNONYM_MAP.get('hooks');
      expect(hooks, 'hooks must exist in SYNONYM_MAP').toBeDefined();
      for (const api of ['useeffect', 'usestate', 'usecallback', 'usememo', 'useref', 'usecontext']) {
        expect(hooks, `hooks should bridge to ${api}`).toContain(api);
      }
    });

    it('bridges hook ↔ hooks (singular/plural) for tokens like react-hook-form', () => {
      expect(SYNONYM_MAP.get('hook')).toContain('hooks');
      expect(SYNONYM_MAP.get('hooks')).toContain('hook');
    });

    it('expandToken("hooks") yields an OR group containing useEffect', async () => {
      const { expandToken } = await import('../nlp.mjs');
      const expanded = expandToken('hooks');
      expect(expanded.startsWith('(')).toBe(true);
      expect(expanded).toMatch(/useeffect/i);
    });
  });

  describe('CJK_COMPOUNDS', () => {
    it('is a Set', () => {
      expect(CJK_COMPOUNDS).toBeInstanceOf(Set);
    });

    it('contains common CJK compound words', () => {
      expect(CJK_COMPOUNDS.has('数据库')).toBe(true);
      expect(CJK_COMPOUNDS.has('测试')).toBe(true);
      expect(CJK_COMPOUNDS.has('部署')).toBe(true);
    });

    it('contains multi-character compounds only', () => {
      for (const word of CJK_COMPOUNDS) {
        expect(word.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
