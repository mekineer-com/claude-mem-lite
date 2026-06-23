// Intent-based skill recommendation — Phase 1 (shadow).
// See docs/superpowers/specs/2026-06-23-skill-recommendation-loop-design.md
//
// Phase-1 invariant: shadow AND live only LOG. Neither emits to stdout nor writes
// invocations/recommend_count. Live injection is Phase 2. `off` skips all work.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { searchResources } from './registry-retriever.mjs';

const VALID_MODES = new Set(['shadow', 'live', 'off']);

/** Recommendation mode from env; default 'shadow', unknown → 'shadow'. */
export function getRecommendMode() {
  const raw = (process.env.CLAUDE_MEM_RECOMMEND_MODE || 'shadow').toLowerCase().trim();
  return VALID_MODES.has(raw) ? raw : 'shadow';
}

// Provisional gate thresholds — calibrated from shadow data before Phase 2 (spec §8).
// relevance is raw bm25 (negative; more negative = better). Candidate must clear |floor|.
export const RECO_BM25_FLOOR = -1.5;     // require row.relevance <= -1.5
export const RECO_MARGIN = 0.5;          // require candidates[1].relevance - candidates[0].relevance >= 0.5
export const RECO_COOLDOWN_MS = 300_000; // 5 min, mirrors T4 SKILL_COOLDOWN_MS

// Lazy runtime-path resolution: read CLAUDE_MEM_DIR at call time (mirrors schema.mjs:13
// DB_DIR formula) so tests sandbox via env without ESM-cache gymnastics, and prod reads
// the same dir as the rest of the app.
function recoRuntimeDir() {
  return join(process.env.CLAUDE_MEM_DIR || join(homedir(), '.claude-mem-lite'), 'runtime');
}

const TOKEN_SPLIT = /[^a-z0-9一-鿿]+/;

/** Installed skills (quality_tier='installed') matching the prompt, best-first. */
export function fetchInstalledSkillCandidates(rdb, promptText, limit = 10) {
  if (!rdb || !promptText) return [];
  let rows;
  try { rows = searchResources(rdb, promptText, { type: 'skill', limit }); }
  catch { return []; }
  return rows.filter(r => r.quality_tier === 'installed');
}

/**
 * True when an intent tag matches a prompt token. Tags of length >= 3 match as a token
 * PREFIX (plural/inflection tolerant: "test" → "tests"/"testing"; rejects mid-word hits
 * like "latest"); shorter tags ("qa","go","db") require an exact token to avoid noise.
 */
export function intentMatch(promptText, candidate) {
  const tags = String(candidate.intent_tags || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (tags.length === 0) return false;
  const tokens = String(promptText).toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
  return tags.some(tag => tokens.some(tok => (tag.length >= 3 ? tok.startsWith(tag) : tok === tag)));
}

/**
 * 4-gate precision filter. relevance is raw bm25 (negative; more negative = better).
 * Gates in order: absolute floor → top1/top2 margin → intent token match → session cooldown.
 */
export function applyGate(candidates, promptText, cooldownSet) {
  if (!candidates || candidates.length === 0) return { verdict: 'BLOCK', reason: 'no_candidate', candidate: null };
  const top = candidates[0];
  if (!(top.relevance <= RECO_BM25_FLOOR)) return { verdict: 'BLOCK', reason: 'below_floor', candidate: top };
  if (candidates.length >= 2) {
    const margin = candidates[1].relevance - top.relevance; // positive when top is clearly better
    if (!(margin >= RECO_MARGIN)) return { verdict: 'BLOCK', reason: 'low_margin', candidate: top };
  }
  if (!intentMatch(promptText, top)) return { verdict: 'BLOCK', reason: 'intent_mismatch', candidate: top };
  if (cooldownSet && cooldownSet.has(String(top.name).toLowerCase())) return { verdict: 'BLOCK', reason: 'cooldown', candidate: top };
  return { verdict: 'PASS', reason: 'pass', candidate: top };
}

function recoCooldownFile(project) { return join(recoRuntimeDir(), `.skill-reco-cooldown-${project}`); }

/** Read live (non-expired) cooldown entries for a project: {nameLower: epochMs}. */
export function getRecoCooldown(project) {
  try {
    const data = JSON.parse(readFileSync(recoCooldownFile(project), 'utf8'));
    const now = Date.now(); const cleaned = {};
    for (const [k, v] of Object.entries(data)) if (now - v < RECO_COOLDOWN_MS) cleaned[k] = v;
    return cleaned;
  } catch { return {}; }
}

/** Stamp a skill name into the project's cooldown (atomic tmp+rename, mirrors T4). */
export function setRecoCooldown(project, name) {
  try {
    const dir = recoRuntimeDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data = getRecoCooldown(project);
    data[String(name).toLowerCase()] = Date.now();
    const tmp = recoCooldownFile(project) + `.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, recoCooldownFile(project));
  } catch { /* silent — cooldown best-effort */ }
}

function today() { return new Date().toISOString().slice(0, 10); }
function shadowDir() { return join(recoRuntimeDir(), 'recommendations'); }

function appendShadow(row) {
  try {
    const dir = shadowDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${today()}.jsonl`), JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch { /* shadow sink must never crash the hook */ }
}

export function logShadowReco(project, rec) { appendShadow({ ts: new Date().toISOString(), kind: 'reco', project, ...rec }); }
export function logShadowAdoption(project, rec) { appendShadow({ ts: new Date().toISOString(), kind: 'adopt', project, ...rec }); }

/** Yield parsed shadow rows from the last `days` daily shards. */
export function* readShadowLog(days = 7) {
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    let raw;
    try { raw = readFileSync(join(shadowDir(), `${d}.jsonl`), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) { if (!line) continue; try { yield JSON.parse(line); } catch { /* skip malformed */ } }
  }
}

/** Aggregate the would-be funnel for the flip decision (spec §8). */
export function computeFunnel(days = 7) {
  const stats = { reco: 0, pass: 0, blockByReason: {}, adopt: 0, passSkills: {}, adoptSkills: {} };
  const bump = (obj, k) => { if (k) obj[k] = (obj[k] || 0) + 1; };
  for (const row of readShadowLog(days)) {
    if (row.kind === 'reco') {
      stats.reco++;
      if (row.verdict === 'PASS') { stats.pass++; bump(stats.passSkills, row.skill); }
      else bump(stats.blockByReason, row.reason);
    } else if (row.kind === 'adopt') { stats.adopt++; bump(stats.adoptSkills, row.skill); }
  }
  return stats;
}

/**
 * Phase-1 shadow orchestrator: retrieve → gate → log → cooldown on PASS.
 * Emits NOTHING and writes NO live telemetry. `off` → no-op. Returns the verdict.
 */
export function recommendSkill(rdb, promptText, project, opts = {}) {
  const mode = getRecommendMode();
  if (mode === 'off') return { verdict: 'OFF', reason: 'off', candidate: null };
  let candidates = [];
  try { candidates = fetchInstalledSkillCandidates(rdb, promptText); } catch { /* ignore */ }
  const cooldownSet = new Set(Object.keys(getRecoCooldown(project)));
  const result = applyGate(candidates, promptText, cooldownSet);
  logShadowReco(project, {
    mode, verdict: result.verdict, reason: result.reason,
    skill: result.candidate ? result.candidate.name : null,
    relevance: result.candidate ? result.candidate.relevance : null,
    ncand: candidates.length,
    // #8259: UserPromptSubmit injection cite-recall was 25.8% until gated on explicit
    // signal. Record signal-presence so the Phase-2 flip can test whether live injection
    // should gate on it (the decisive lever per that lesson). Shadow does not gate on it.
    hasSignal: opts.hasSignal ?? null,
  });
  // Simulate live cooldown timing so the shadow funnel reflects real injection cadence.
  if (result.verdict === 'PASS') setRecoCooldown(project, result.candidate.name);
  return result;
}

/** PostToolUse adoption probe — Skill is the only visible adoption signal (mem_use is pre-filtered). */
export function recordSkillAdoption(toolName, toolInput, project) {
  if (getRecommendMode() === 'off') return;
  if (toolName !== 'Skill') return;
  const skill = toolInput && typeof toolInput === 'object' ? toolInput.skill : null;
  if (!skill) return;
  logShadowAdoption(project, { skill: String(skill).toLowerCase() });
}

/** Human-readable funnel for `registry recommend-stats`. */
export function formatFunnel(s) {
  const blocks = Object.entries(s.blockByReason).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `    ${k}: ${v}`).join('\n') || '    (none)';
  const overlap = Object.keys(s.passSkills).filter(k => s.adoptSkills[k])
    .map(k => `${k}(pass ${s.passSkills[k]}/adopt ${s.adoptSkills[k]})`).join(', ') || '(none)';
  const passRate = s.reco ? (100 * s.pass / s.reco).toFixed(1) : '0.0';
  return [
    'shadow recommendation funnel:',
    `  reco=${s.reco}  pass=${s.pass} (${passRate}% of reco)  adopt=${s.adopt}`,
    `  block reasons:\n${blocks}`,
    `  PASS∩adopt (coarse precision proxy): ${overlap}`,
  ].join('\n');
}
