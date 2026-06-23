import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getRecommendMode, RECO_BM25_FLOOR, RECO_MARGIN,
  fetchInstalledSkillCandidates, intentMatch, applyGate,
  getRecoCooldown, setRecoCooldown,
  logShadowReco, logShadowAdoption, computeFunnel,
  recommendSkill, recordSkillAdoption, formatFunnel, readShadowLog,
} from '../registry-recommend.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';

// Point CLAUDE_MEM_DIR at a fresh sandbox dir for the enclosing describe. Works WITHOUT
// ESM cache-busting because registry-recommend.mjs resolves its runtime path lazily
// (reads CLAUDE_MEM_DIR at call time). Keeps the real ~/.claude-mem-lite untouched (§8.V3/V4).
function withSandbox() {
  const prevDir = process.env.CLAUDE_MEM_DIR;
  let tmp;
  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'reco-')); process.env.CLAUDE_MEM_DIR = tmp; });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CLAUDE_MEM_DIR; else process.env.CLAUDE_MEM_DIR = prevDir;
  });
}

describe('getRecommendMode', () => {
  const prev = process.env.CLAUDE_MEM_RECOMMEND_MODE;
  afterEach(() => { if (prev === undefined) delete process.env.CLAUDE_MEM_RECOMMEND_MODE; else process.env.CLAUDE_MEM_RECOMMEND_MODE = prev; });
  it('defaults to shadow when unset', () => { delete process.env.CLAUDE_MEM_RECOMMEND_MODE; expect(getRecommendMode()).toBe('shadow'); });
  it('honors live/off and normalizes case/space', () => {
    process.env.CLAUDE_MEM_RECOMMEND_MODE = '  LIVE '; expect(getRecommendMode()).toBe('live');
    process.env.CLAUDE_MEM_RECOMMEND_MODE = 'off'; expect(getRecommendMode()).toBe('off');
  });
  it('falls back to shadow on unknown value', () => { process.env.CLAUDE_MEM_RECOMMEND_MODE = 'banana'; expect(getRecommendMode()).toBe('shadow'); });
  it('exposes negative floor + positive margin', () => { expect(RECO_BM25_FLOOR).toBeLessThan(0); expect(RECO_MARGIN).toBeGreaterThan(0); });
});

function cand(name, relevance, intent_tags = name, quality_tier = 'installed') {
  return { name, relevance, intent_tags, quality_tier };
}

describe('intentMatch', () => {
  it('matches a tag as a token prefix (plural-tolerant)', () => { expect(intentMatch('please write tests for foo', cand('tdd', -3, 'test,tdd'))).toBe(true); });
  it('does not match incidental superstrings', () => { expect(intentMatch('grab the latest build', cand('tdd', -3, 'test'))).toBe(false); });
  it('false when candidate has no intent tags', () => { expect(intentMatch('write tests', cand('x', -3, ''))).toBe(false); });
});

describe('applyGate', () => {
  const prompt = 'write unit tests for the parser';
  it('BLOCK no_candidate on empty', () => { expect(applyGate([], prompt, new Set())).toMatchObject({ verdict: 'BLOCK', reason: 'no_candidate' }); });
  it('BLOCK below_floor when weak', () => { expect(applyGate([cand('tdd', -0.5, 'test')], prompt, new Set())).toMatchObject({ verdict: 'BLOCK', reason: 'below_floor' }); });
  it('BLOCK low_margin when top2 close', () => { expect(applyGate([cand('tdd', -3.0, 'test'), cand('qa', -2.9, 'test')], prompt, new Set())).toMatchObject({ verdict: 'BLOCK', reason: 'low_margin' }); });
  it('BLOCK intent_mismatch', () => { expect(applyGate([cand('deployer', -3.0, 'deploy,release')], prompt, new Set())).toMatchObject({ verdict: 'BLOCK', reason: 'intent_mismatch' }); });
  it('BLOCK cooldown', () => { expect(applyGate([cand('tdd', -3.0, 'test')], prompt, new Set(['tdd']))).toMatchObject({ verdict: 'BLOCK', reason: 'cooldown' }); });
  it('PASS single strong on-intent', () => { expect(applyGate([cand('tdd', -3.0, 'test,tdd')], prompt, new Set())).toMatchObject({ verdict: 'PASS', candidate: { name: 'tdd' } }); });
  it('PASS with clear margin', () => { expect(applyGate([cand('tdd', -3.0, 'test'), cand('qa', -1.0, 'test')], prompt, new Set()).verdict).toBe('PASS'); });
});

describe('fetchInstalledSkillCandidates', () => {
  it('returns only installed skills from the retriever', () => {
    const db = createRegistryTestDb();
    db.prepare(`INSERT INTO resources (name,type,source,file_hash,status,local_path,quality_tier,trigger_patterns,keywords,intent_tags,capability_summary,use_cases)
      VALUES ('tdd-installed','skill','preinstalled','h','active','/p','installed','write failing test tdd','test tdd','test,tdd','tdd skill','testing')`).run();
    db.prepare(`INSERT INTO resources (name,type,source,file_hash,status,local_path,quality_tier,trigger_patterns,keywords,intent_tags,capability_summary,use_cases)
      VALUES ('tdd-community','skill','github','h','active','/p','community','write failing test tdd','test tdd','test,tdd','tdd skill','testing')`).run();
    const rows = fetchInstalledSkillCandidates(db, 'write tdd tests');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every(r => r.quality_tier === 'installed')).toBe(true);
    expect(rows.map(r => r.name)).toContain('tdd-installed');
    db.close();
  });
  it('returns [] on null db or empty prompt', () => { expect(fetchInstalledSkillCandidates(null, 'x')).toEqual([]); expect(fetchInstalledSkillCandidates({}, '')).toEqual([]); });
});

describe('reco cooldown', () => {
  withSandbox();
  it('round-trips set/get, case-insensitive', () => { setRecoCooldown('projX', 'TDD'); expect(Object.keys(getRecoCooldown('projX'))).toContain('tdd'); });
  it('returns {} for unknown project', () => { expect(getRecoCooldown('never-seen')).toEqual({}); });
});

describe('shadow log + funnel', () => {
  withSandbox();
  it('writes reco+adopt and aggregates a funnel', () => {
    logShadowReco('p', { mode: 'shadow', verdict: 'PASS', reason: 'pass', skill: 'tdd', relevance: -3, ncand: 2 });
    logShadowReco('p', { mode: 'shadow', verdict: 'BLOCK', reason: 'below_floor', skill: 'qa', relevance: -0.4, ncand: 1 });
    logShadowAdoption('p', { skill: 'tdd' });
    const f = computeFunnel(2);
    expect(f.reco).toBe(2); expect(f.pass).toBe(1); expect(f.blockByReason.below_floor).toBe(1);
    expect(f.adopt).toBe(1); expect(f.passSkills.tdd).toBe(1); expect(f.adoptSkills.tdd).toBe(1);
  });
  it('tolerates a missing log dir', () => { expect(typeof computeFunnel(1).reco).toBe('number'); });
});

describe('recommendSkill + recordSkillAdoption (shadow)', () => {
  withSandbox();
  const prevMode = process.env.CLAUDE_MEM_RECOMMEND_MODE;
  afterAll(() => { if (prevMode === undefined) delete process.env.CLAUDE_MEM_RECOMMEND_MODE; else process.env.CLAUDE_MEM_RECOMMEND_MODE = prevMode; });
  function seed(db) {
    db.prepare(`INSERT INTO resources (name,type,source,file_hash,status,local_path,quality_tier,trigger_patterns,keywords,intent_tags,capability_summary,use_cases)
      VALUES ('tdd','skill','preinstalled','h','active','/p','installed','write failing test tdd red green','test tdd vitest','test,tdd','tdd skill','writing tests')`).run();
  }
  it('shadow logs a reco and never writes invocations', () => {
    process.env.CLAUDE_MEM_RECOMMEND_MODE = 'shadow';
    const db = createRegistryTestDb(); seed(db);
    const before = db.prepare('SELECT COUNT(*) c FROM invocations').get().c;
    const r = recommendSkill(db, 'please write tdd tests for the parser', 'p1', { hasSignal: true });
    expect(['PASS', 'BLOCK']).toContain(r.verdict);
    expect(db.prepare('SELECT COUNT(*) c FROM invocations').get().c).toBe(before);
    expect(computeFunnel(1).reco).toBeGreaterThanOrEqual(1);
    const recoRows = [...readShadowLog(1)].filter(x => x.kind === 'reco' && x.project === 'p1');
    expect(recoRows.length).toBeGreaterThanOrEqual(1);
    expect(recoRows[0].hasSignal).toBe(true);
    db.close();
  });
  it('off mode is a no-op', () => {
    process.env.CLAUDE_MEM_RECOMMEND_MODE = 'off';
    const db = createRegistryTestDb(); seed(db);
    expect(recommendSkill(db, 'write tdd tests', 'p2').verdict).toBe('OFF');
    db.close();
  });
  it('recordSkillAdoption logs only for Skill', () => {
    process.env.CLAUDE_MEM_RECOMMEND_MODE = 'shadow';
    recordSkillAdoption('Bash', { command: 'ls' }, 'p3');
    recordSkillAdoption('Skill', { skill: 'tdd' }, 'p3');
    expect(computeFunnel(1).adoptSkills.tdd).toBeGreaterThanOrEqual(1);
  });
});

describe('formatFunnel', () => {
  it('renders counts, block reasons, precision proxy', () => {
    const out = formatFunnel({ reco: 10, pass: 4, blockByReason: { below_floor: 5, intent_mismatch: 1 }, adopt: 3, passSkills: { tdd: 4 }, adoptSkills: { tdd: 2, qa: 1 } });
    expect(out).toContain('reco=10'); expect(out).toContain('pass=4'); expect(out).toContain('below_floor'); expect(out).toContain('tdd');
  });
});
