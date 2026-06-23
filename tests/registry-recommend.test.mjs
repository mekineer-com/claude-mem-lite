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
  replayGate, computeSweep, formatSweep,
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
  // CJK bridge: pure-中文 prompts have no word boundaries and intent_tags are English, so a
  // Chinese prompt structurally failed gate 3 until CJK_INTENT_MAP injects English equivalents.
  it('matches an English intent_tag from a pure-CJK prompt (测试→test)', () => { expect(intentMatch('帮我写测试', cand('tdd', -3, 'test,tdd'))).toBe(true); });
  it('bridges other CJK intents (部署→deploy)', () => { expect(intentMatch('准备部署到生产', cand('deployer', -3, 'deploy,release'))).toBe(true); });
  it('does not bridge-match an unrelated tag from incidental CJK', () => { expect(intentMatch('今天天气不错', cand('deployer', -3, 'deploy,release'))).toBe(false); });
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
  it('renders matched precision + targeting lift when session data is present', () => {
    const out = formatFunnel({
      reco: 4, pass: 2, blockByReason: {}, adopt: 3, passSkills: { tdd: 2 }, adoptSkills: { tdd: 2 },
      sessions: 3, matched: { pass: 2, adopt: 1, precision: 0.5 },
      lift: { tdd: { passSessions: 2, hitSessions: 1, adoptGivenPass: 0.5, baseRate: 0.6667, lift: 0.75 } },
    });
    expect(out).toContain('sessions=3');
    expect(out).toContain('1/2 (50%)');
    expect(out).toContain('lift 0.75');
  });
  it('omits the matched/lift block for a session-less (back-compat) funnel object', () => {
    const out = formatFunnel({ reco: 1, pass: 0, blockByReason: {}, adopt: 0, passSkills: {}, adoptSkills: {} });
    expect(out).not.toContain('matched precision');
  });
});

const SEED_TDD = `INSERT INTO resources (name,type,source,file_hash,status,local_path,quality_tier,trigger_patterns,keywords,intent_tags,capability_summary,use_cases)
  VALUES ('tdd','skill','preinstalled','h','active','/p','installed','write failing test tdd red green','test tdd vitest','test,tdd','tdd skill','writing tests')`;

describe('session-keyed shadow rows (B1)', () => {
  withSandbox();
  const prevMode = process.env.CLAUDE_MEM_RECOMMEND_MODE;
  afterAll(() => { if (prevMode === undefined) delete process.env.CLAUDE_MEM_RECOMMEND_MODE; else process.env.CLAUDE_MEM_RECOMMEND_MODE = prevMode; });
  it('threads session id into both reco and adopt rows so they can be paired', () => {
    process.env.CLAUDE_MEM_RECOMMEND_MODE = 'shadow';
    const db = createRegistryTestDb(); db.prepare(SEED_TDD).run();
    recommendSkill(db, 'please write tdd tests for the parser', 'pb1', { sessionId: 'sess-A', hasSignal: true });
    recordSkillAdoption('Skill', { skill: 'tdd' }, 'pb1', 'sess-A');
    const rows = [...readShadowLog(1)].filter(x => x.project === 'pb1');
    const reco = rows.find(x => x.kind === 'reco');
    const adopt = rows.find(x => x.kind === 'adopt');
    expect(reco.session).toBe('sess-A');
    expect(adopt.session).toBe('sess-A');
    db.close();
  });
});

describe('reco join key = invocation slug (matched-precision regression)', () => {
  withSandbox();
  const prevMode = process.env.CLAUDE_MEM_RECOMMEND_MODE;
  afterAll(() => { if (prevMode === undefined) delete process.env.CLAUDE_MEM_RECOMMEND_MODE; else process.env.CLAUDE_MEM_RECOMMEND_MODE = prevMode; });
  // Real-world bug: the registry stores name='superpowers-tdd' but the Skill tool — and thus the
  // adoption row — uses the slug 'superpowers:test-driven-development'. Logging top.name made the
  // in-session PASS→adopt join compare name vs slug, so matched precision was a guaranteed 0 for
  // every namespaced/aliased skill, masking real targeting signal. Fixtures elsewhere use
  // name==slug, so only an invocation_name≠name fixture catches this.
  it('logs the candidate invocation_name (slug) so reco pairs with the adoption row', () => {
    process.env.CLAUDE_MEM_RECOMMEND_MODE = 'shadow';
    const db = createRegistryTestDb();
    db.prepare(`INSERT INTO resources (name,invocation_name,type,source,file_hash,status,local_path,quality_tier,trigger_patterns,keywords,intent_tags,capability_summary,use_cases)
      VALUES ('superpowers-tdd','superpowers:test-driven-development','skill','preinstalled','h','active','/p','installed','write failing test tdd red green','test tdd vitest','test,tdd','tdd skill','writing tests')`).run();
    recommendSkill(db, 'please write tdd tests for the parser', 'pjk', { sessionId: 'sk' });
    recordSkillAdoption('Skill', { skill: 'superpowers:test-driven-development' }, 'pjk', 'sk');
    const rows = [...readShadowLog(1)].filter(x => x.project === 'pjk');
    const reco = rows.find(x => x.kind === 'reco');
    const adopt = rows.find(x => x.kind === 'adopt');
    expect(reco.skill).toBe('superpowers:test-driven-development'); // was 'superpowers-tdd' (the bug)
    expect(reco.skill).toBe(adopt.skill); // keys align → matched precision can now pair
    db.close();
  });
});

describe('computeFunnel matched precision + lift (B2)', () => {
  withSandbox();
  it('pairs in-session PASS→adopt and computes per-skill targeting lift', () => {
    // s1: gate would PASS tdd, Claude adopts tdd  → matched hit
    logShadowReco('pf', { session: 's1', verdict: 'PASS', reason: 'pass', skill: 'tdd', relevance: -10, ncand: 2 });
    logShadowAdoption('pf', { session: 's1', skill: 'tdd' });
    // s2: gate would PASS tdd, Claude adopts qa instead → matched miss for tdd
    logShadowReco('pf', { session: 's2', verdict: 'PASS', reason: 'pass', skill: 'tdd', relevance: -10, ncand: 2 });
    logShadowAdoption('pf', { session: 's2', skill: 'qa' });
    // s3: no reco, Claude adopts tdd organically → raises tdd's base rate
    logShadowAdoption('pf', { session: 's3', skill: 'tdd' });
    const f = computeFunnel(1);
    expect(f.sessions).toBe(3);
    expect(f.matched.pass).toBe(2);
    expect(f.matched.adopt).toBe(1);
    expect(f.matched.precision).toBeCloseTo(0.5, 5);
    // tdd: adopted-given-pass = 1/2 = 0.5; base rate = adopted in 2/3 sessions = 0.667; lift = 0.75
    expect(f.lift.tdd.lift).toBeCloseTo(0.75, 2);
    // qa never PASSed → absent from the lift table (lift is over gate decisions, not adoptions)
    expect(f.lift.qa).toBeUndefined();
  });
});

describe('reco row replay vector (B3)', () => {
  withSandbox();
  const prevMode = process.env.CLAUDE_MEM_RECOMMEND_MODE;
  afterAll(() => { if (prevMode === undefined) delete process.env.CLAUDE_MEM_RECOMMEND_MODE; else process.env.CLAUDE_MEM_RECOMMEND_MODE = prevMode; });
  it('logs top2 relevance + intent/cooldown bits so the gate can be replayed offline', () => {
    process.env.CLAUDE_MEM_RECOMMEND_MODE = 'shadow';
    const db = createRegistryTestDb();
    db.prepare(SEED_TDD).run();
    db.prepare(`INSERT INTO resources (name,type,source,file_hash,status,local_path,quality_tier,trigger_patterns,keywords,intent_tags,capability_summary,use_cases)
      VALUES ('tdd2','skill','preinstalled','h2','active','/p','installed','write failing test tdd','test tdd','test,tdd','another tdd skill','writing tests')`).run();
    recommendSkill(db, 'please write tdd tests', 'pv', { sessionId: 'sv' });
    const reco = [...readShadowLog(1)].filter(x => x.kind === 'reco' && x.project === 'pv')[0];
    expect(typeof reco.intentTop).toBe('boolean');
    expect(reco.cooldownTop).toBe(false);
    expect(reco.rel2 === null || typeof reco.rel2 === 'number').toBe(true);
    db.close();
  });
});

describe('replayGate (B3 offline threshold replay)', () => {
  const row = (relevance, rel2, intentTop = true, cooldownTop = false) => ({ relevance, rel2, intentTop, cooldownTop });
  it('PASS when top clears floor, margin ok, intent matched, not cooled', () => { expect(replayGate(row(-10, -5), -8, 1)).toBe('PASS'); });
  it('BLOCK below_floor at a stricter floor', () => { expect(replayGate(row(-6, -2), -8, 1)).toBe('BLOCK'); });
  it('BLOCK low_margin when top2 is within margin', () => { expect(replayGate(row(-10, -9.5), -8, 1)).toBe('BLOCK'); });
  it('single candidate (rel2 null) skips the margin gate', () => { expect(replayGate(row(-10, null), -8, 1)).toBe('PASS'); });
  it('BLOCK on intent mismatch or cooldown regardless of thresholds', () => {
    expect(replayGate(row(-10, -5, false, false), -8, 1)).toBe('BLOCK');
    expect(replayGate(row(-10, -5, true, true), -8, 1)).toBe('BLOCK');
  });
  it('null relevance always BLOCKs', () => { expect(replayGate(row(null, null), -8, 1)).toBe('BLOCK'); });
});

describe('computeSweep (B3 ROC over thresholds)', () => {
  withSandbox();
  it('replays the gate per (floor,margin) and joins adoptions for matched precision', () => {
    // sx: strong tdd vector, adopted
    logShadowReco('psw', { session: 'sx', verdict: 'PASS', reason: 'pass', skill: 'tdd', relevance: -10, rel2: -5, intentTop: true, cooldownTop: false, ncand: 2 });
    logShadowAdoption('psw', { session: 'sx', skill: 'tdd' });
    // sy: weak qa vector (rel -3), not adopted — only clears a loose floor
    logShadowReco('psw', { session: 'sy', verdict: 'BLOCK', reason: 'below_floor', skill: 'qa', relevance: -3, rel2: null, intentTop: true, cooldownTop: false, ncand: 1 });
    const grid = computeSweep(1, [-8, -2], [0]);
    const strict = grid.find(g => g.floor === -8 && g.margin === 0);
    const loose = grid.find(g => g.floor === -2 && g.margin === 0);
    expect(strict.pass).toBe(1); expect(strict.matchAdopt).toBe(1); expect(strict.precision).toBeCloseTo(1, 5);
    expect(loose.pass).toBe(2); expect(loose.matchAdopt).toBe(1); expect(loose.precision).toBeCloseTo(0.5, 5);
  });
});

describe('formatSweep', () => {
  it('renders each grid cell with pass count and matched precision', () => {
    const out = formatSweep([{ floor: -8, margin: 0, pass: 3, matchPass: 3, matchAdopt: 2, precision: 2 / 3 }]);
    expect(out).toContain('floor=-8'); expect(out).toContain('pass=3'); expect(out).toContain('67%');
  });
});
