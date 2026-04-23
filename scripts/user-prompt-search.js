#!/usr/bin/env node
// claude-mem-lite: Auto-search memory on user prompt
// Runs as UserPromptSubmit hook — injects relevant memories before Claude sees the prompt
// Lightweight: only imports schema.mjs and utils.mjs, no MCP SDK

import { ensureDb, DB_DIR, REGISTRY_DB_PATH } from '../schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, OBS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE, notLowSignalTitleClause, noisePenaltyClause } from '../utils.mjs';
import { writeFileSync, readFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { shouldSkip, computeEffectiveLen, detectIntent, shouldSkipByDedup, extractFiles, extractErrorSignature, DEDUP_STALE_MS, matchRegistrySkillName } from './prompt-search-utils.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────

const INJECTED_IDS_FILE = join(DB_DIR, 'runtime', `.claude-mem-injected-${inferProject()}`);
const MAX_RESULTS = 5;
const LOOKBACK_MS = 60 * 86400000; // 60 days

// T3 (v2.31): per-row BM25 magnitude floor. OBS_BM25 (in scoring-sql.mjs)
// returns the raw bm25() value — negative, smaller = better. Multiplied by
// decay × type-quality × (0.5+0.5·importance), sign stays negative. We
// compare against Math.abs(relevance).
//
// v2.34.3 note: the historic comment claimed |rel| falls in 3e-6..5e-5 range.
// Re-measured against real data (see v2.34.3 CHANGELOG probe), actual scores
// span ~6..133 across SIGNAL / META / NOISE prompts — the scoring expression
// was revised in later versions and this constant was never retuned. 1e-5 now
// acts as a NULL-rel guard, not a real noise filter. The primary noise gate
// is TOP_REL_FLOOR below, which drops the whole FTS set when the best match
// is weak.
const BM25_MIN_SCORE = Number(process.env.CLAUDE_MEM_UPS_BM25_MIN || 1e-5);
// CJK-weighted minimum length for the prompt. Catches medium-short Latin
// prompts ("run tests", "fix bug now") that survive `shouldSkip`'s weaker 8-unit
// floor but carry too few tokens to justify an FTS lookup.
// v2.34.4: applied to `computeEffectiveLen(prompt)`, not raw char count — a
// 14-char CJK prompt ("优化 hook 性能降低延迟") scores 30 effective units and
// now reaches FTS, matching shouldSkip's CJK-weighted gate rather than silently
// failing the raw-char one.
const PROMPT_MIN_LENGTH = 15;

// v2.33.1: follow-up prompts ("前面那个", "继续 X", "再看看 Y") are short by
// nature but semantically depend on prior turns. Once a session has injected
// memory at least once, relax gates so short follow-ups still get recall.
// Detection: INJECTED_IDS_FILE count > 0 within DEDUP_STALE_MS window.
const FOLLOWUP_PROMPT_MIN_LENGTH = 8;
const FOLLOWUP_BM25_MIN_SCORE = Number(process.env.CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP || 5e-6);

// v2.34.3: top-|rel| sanity gate. BM25_MIN_SCORE filters per-row; this floor
// gates the entire FTS set. Noise prompts ("today's date", "current time")
// produce OR-fallback leakage where every hit shares one tangential stem and
// per-row filtering leaves all of them through. When the best match scores
// below this floor, the whole FTS result set is dropped.
//
// Empirical distribution (v2.34.3 probe, 12 prompts):
//   SIGNAL top-|rel|   60..133
//   NOISE  top-|rel|   25..48
//   WEAK-META          6.86..33
// Default 50 sits in the clean 48→60 gap. Env override for project tuning.
// Error-signature hits (sigRows) and file-recall (fileRows) bypass this gate —
// both are precision passes with independent relevance signal.
//
// Note: no follow-up halving (unlike PROMPT_MIN_LENGTH / BM25_MIN_SCORE).
// Those lower the length/per-row bar to let short context-dependent prompts
// through, but the top-|rel| gap is an absolute distribution separator —
// lowering it in follow-up mode re-admits the 37..48 noise band that the
// gate exists to drop.
const TOP_REL_FLOOR = Number(process.env.CLAUDE_MEM_UPS_TOP_MIN || 50);

// v2.43.x: OR-fallback raw BM25 magnitude floor. The composite TOP_REL_FLOOR
// above gates on `bm25 × importance × type_quality × decay × noise_penalty`.
// For importance=3 bugfix obs, those multipliers compound to ~6×, so a modest
// BM25 of -17..-22 can clear a composite floor of 50 via inflation alone.
// When the FTS query relaxes to OR (AND returned 0), a single strongly-
// matching stem on a big multi-topic prompt leaks through — observed
// failure mode: broad Chinese prompts surfacing unrelated importance=3
// bugfix obs whose concepts share exactly one stem with the prompt.
//
// Empirical OR-mode distribution (11-prompt probe, 2026-04-23):
//   real signal      top-|bm25_raw| ≥ 41
//   broad/meta noise top-|bm25_raw| ≤ 22
//   below threshold  top-|bm25_raw| < 12
// Default 30 sits in the clean 22→41 gap. AND mode bypasses this gate —
// AND's all-stems-must-match constraint is already a precision signal,
// and there are legitimate AND hits (GOOD-narrow probe: bm25_raw=19.3,
// rel=81) that we must not drop.
//
// CLAUDE_MEM_UPS_TOP_MIN=0 disables this too: on small test corpora (1–2
// seeded obs) absolute BM25 magnitudes collapse to near-zero (observed
// |bm25|≈4e-6) because FTS5 IDF normalization needs a real document
// distribution. The existing TOP_REL_FLOOR knob already encodes the
// "seed-mode: kill absolute floors" semantic for integration tests, so
// we piggy-back on it rather than introducing a second override env.
const OR_TOP_BM25_FLOOR = TOP_REL_FLOOR === 0
  ? 0
  : Number(process.env.CLAUDE_MEM_UPS_OR_BM25_MIN || 30);

function isFollowUpSession() {
  try {
    const raw = readFileSync(INJECTED_IDS_FILE, 'utf8');
    const { ts, count = 0 } = JSON.parse(raw);
    if (!ts || Date.now() - ts > DEDUP_STALE_MS) return false;
    return count > 0;
  } catch { return false; }
}

// ─── DB Query Functions ─────────────────────────────────────────────────────

// Returns { rows, mode } where mode is 'AND' (initial pass), 'OR' (fallback
// after AND returned 0), or null (no FTS query / sanitize rejected). Callers
// use `mode` to apply OR-specific gates — see OR_TOP_BM25_FLOOR rationale.
// Each row includes `bm25_raw` (pre-multiplier bm25 magnitude) alongside the
// composite `relevance`, so callers can distinguish raw-match strength from
// importance/type/decay inflation.
function searchByFts(db, queryText, project, limit, typeFilter) {
  const ftsQuery = sanitizeFtsQuery(queryText);
  if (!ftsQuery) return { rows: [], mode: null };

  const cutoff = Date.now() - LOOKBACK_MS;

  const typeClause = typeFilter ? 'AND o.type = ?' : '';
  const now = Date.now();
  // R1: notLowSignalTitleClause() excludes hook-llm degraded titles
  // ("Modified X", "Worked on X", "Reviewed N files:", raw error logs).
  // v26 P0: noise penalty shrinks relevance magnitude for obs with high
  // inject:access ratio (auto-injected often, never cited/opened). See
  // docs/p0-injection-noise-baseline.txt.
  const sql = `
    SELECT o.id, o.type, o.title, o.lesson_learned,
           ${OBS_BM25} as bm25_raw,
           ${OBS_BM25}
             * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${TYPE_DECAY_CASE}))
             * ${TYPE_QUALITY_CASE}
             * (0.5 + 0.5 * COALESCE(o.importance, 1))
             * ${noisePenaltyClause('o')} as relevance
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ?
      AND o.project = ?
      AND o.importance >= 1
      AND o.created_at_epoch > ?
      AND COALESCE(o.compressed_into, 0) = 0
      AND ${notLowSignalTitleClause('o')}
      ${typeClause}
    ORDER BY relevance
    LIMIT ?
  `;

  const params = [now, ftsQuery, project, cutoff];
  if (typeFilter) params.push(typeFilter);
  params.push(limit);

  let rows = db.prepare(sql).all(...params);
  let mode = 'AND';

  // OR fallback if AND query returned nothing
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      params[1] = orQuery;
      rows = db.prepare(sql).all(...params);
      mode = 'OR';
    }
  }

  return { rows, mode };
}

function searchByFile(db, files, project, limit) {
  if (files.length === 0) return [];

  const cutoff = Date.now() - LOOKBACK_MS;
  const results = [];

  for (const file of files.slice(0, 3)) {
    const basename = file.split('/').pop();
    if (!basename || basename.length < 2) continue;
    const escaped = basename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;

    // R1: exclude LOW_SIGNAL degraded titles from file-level recall.
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 1
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        AND ${notLowSignalTitleClause('o')}
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(project, cutoff, file, likePattern, limit);

    results.push(...rows);
  }

  // Deduplicate by id
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

// v2.34.5 Gap 1: prompts-table fallback. When observations-based paths
// (FTS / file-recall / sigRows / recent) all return empty, scan the user's
// own past prompts — meta/UX/"did we discuss this" questions often match
// prior prompts even when no observation was saved. Uses a simpler BM25
// ranking with no scoring multipliers and no top-|rel| gate (prompts are
// sparser and more surface-form than observations; the gate would rarely
// fire and mostly kill real hits).
function searchByUserPrompts(db, queryText, project, limit) {
  const ftsQuery = sanitizeFtsQuery(queryText);
  if (!ftsQuery) return [];

  const cutoff = Date.now() - LOOKBACK_MS;
  const sql = `
    SELECT up.id, up.prompt_text, up.created_at_epoch,
           bm25(user_prompts_fts) as relevance
    FROM user_prompts_fts
    JOIN user_prompts up ON up.id = user_prompts_fts.rowid
    JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
    WHERE user_prompts_fts MATCH ?
      AND s.project = ?
      AND up.created_at_epoch > ?
    ORDER BY relevance
    LIMIT ?
  `;

  let rows = db.prepare(sql).all(ftsQuery, project, cutoff, limit);

  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      try { rows = db.prepare(sql).all(orQuery, project, cutoff, limit); } catch {}
    }
  }

  return rows;
}

function searchRecent(db, project, limit) {
  const cutoff = Date.now() - LOOKBACK_MS;
  // R1: exclude LOW_SIGNAL degraded titles from "recent" recall intent
  // (e.g. when user asks "what did I do earlier"). Unqualified alias because
  // this query selects directly from observations with no join.
  return db.prepare(`
    SELECT id, type, title, lesson_learned
    FROM observations
    WHERE project = ?
      AND importance >= 1
      AND COALESCE(compressed_into, 0) = 0
      AND created_at_epoch > ?
      AND ${notLowSignalTitleClause('')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, cutoff, limit);
}

// ─── stdin Reader ───────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      reject(new Error('timeout'));
    }, 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      // Cap at 64KB — user prompts shouldn't be huge
      if (data.length > 65536) {
        process.stdin.destroy();
        clearTimeout(timeout);
        resolve(data.slice(0, 65536));
      }
    });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
    process.stdin.on('error', err => { clearTimeout(timeout); reject(err); });
    process.stdin.resume();
  });
}

// ─── Format Output ──────────────────────────────────────────────────────────

// Phase A (v2.31.3+): drop lesson suffix when MEM_QUIET_HOOKS=1; users on invited-memory
// path can mem_get the ID for full detail.
const QUIET_HOOKS = process.env.MEM_QUIET_HOOKS === '1';

function formatResults(rows) {
  if (!rows || rows.length === 0) return null;

  const lines = ['[mem] FYI — Related memories (continue your task):'];
  for (const r of rows) {
    const icon = typeIcon(r.type);
    const title = truncate(r.title || '', 70);
    const lesson = !QUIET_HOOKS && r.lesson_learned ? ` — ${truncate(r.lesson_learned, 50)}` : '';
    lines.push(`#${r.id} ${icon} ${title}${lesson}`);
  }
  return lines.join('\n');
}

// v2.34.5 Gap 1: distinct header signals to Claude that these are prior
// *user questions*, not codebase lessons — helps the reader interpret the
// row correctly (surface-form match, not a saved insight). Truncate to 80
// chars (slightly longer than obs titles because prompts carry more context).
function formatPromptResults(rows) {
  if (!rows || rows.length === 0) return null;
  const lines = ['[mem] FYI — Past similar questions (continue your task):'];
  for (const r of rows) {
    const text = truncate((r.prompt_text || '').replace(/\s+/g, ' '), 80);
    lines.push(`P#${r.id} 💬 ${text}`);
  }
  return lines.join('\n');
}

// ─── Registry Skill Pointer (T4 v2.31) ─────────────────────────────────────
// Formerly "auto-load": we used to read the full SKILL.md body (up to 16KB)
// and inject it into stdout on keyword match. Now we only emit a short
// pointer line so Claude can decide to invoke via SkillTool. The cooldown
// and match mechanics below are unchanged.

const SKILL_COOLDOWN_FILE = join(DB_DIR, 'runtime', `.skill-cooldown-${inferProject()}`);
const SKILL_COOLDOWN_MS = 300_000; // 5 minutes

function loadManagedSkillNames() {
  if (!existsSync(REGISTRY_DB_PATH)) return new Set();
  try {
    const rdb = new Database(REGISTRY_DB_PATH, { readonly: true });
    rdb.pragma('busy_timeout = 500');
    try {
      const rows = rdb.prepare(`
        SELECT name FROM resources
        WHERE status = 'active' AND local_path LIKE '%/.claude-mem-lite/managed/%'
      `).all();
      return new Set(rows.map(r => r.name.toLowerCase()));
    } finally { rdb.close(); }
  } catch { return new Set(); }
}

function getSkillCooldown() {
  try {
    const raw = readFileSync(SKILL_COOLDOWN_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (now - v < SKILL_COOLDOWN_MS) cleaned[k] = v;
    }
    return cleaned;
  } catch { return {}; }
}

function setSkillCooldown(name) {
  try {
    const data = getSkillCooldown();
    data[name] = Date.now();
    const tmp = SKILL_COOLDOWN_FILE + `.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, SKILL_COOLDOWN_FILE);
  } catch { /* silent */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Prevent recursion from background claude -p calls
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) return;

  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw); } catch { return; }

  const promptText = hookData.prompt || hookData.user_prompt;
  if (!promptText || typeof promptText !== 'string') return;

  // Skip internal protocol messages
  if (promptText.startsWith('<task-notification>')) return;

  // Skip short/confirmation/slash-command/simple-op prompts
  if (shouldSkip(promptText)) return;

  // T3 (v2.31): additional raw-length gate on top of shouldSkip's CJK-weighted
  // effective-length check. Suppresses medium-short Latin prompts ("run tests",
  // "fix bug now") that carry too few content tokens for a meaningful FTS lookup.
  // v2.33.1: follow-up prompts in an already-active session get a lower gate —
  // short continuations ("前面那个?", "does it work?") depend on prior context.
  const followUp = isFollowUpSession();
  const promptMinLen = followUp ? FOLLOWUP_PROMPT_MIN_LENGTH : PROMPT_MIN_LENGTH;
  if (computeEffectiveLen(promptText.trim()) < promptMinLen) return;
  const bm25Floor = followUp ? FOLLOWUP_BM25_MIN_SCORE : BM25_MIN_SCORE;

  let db;
  try {
    db = ensureDb();
  } catch { return; }

  try {
    const project = inferProject();
    const intent = detectIntent(promptText);
    let rows = [];

    // A (v2.32.8): precision pass for named errors. When the prompt contains
    // a typed exception signature (TypeError/ValueError/ReferenceError/...),
    // seed results with exact-match bugfix observations before the intent-
    // based FTS flow runs. These hits are the most directly relevant and
    // take priority slots in the merged output.
    const errSig = extractErrorSignature(promptText);
    const sigRows = errSig
      ? searchByFts(db, errSig.signature, project, 2, 'bugfix').rows.filter(r =>
          typeof r.relevance === 'number' && Math.abs(r.relevance) >= bm25Floor
        )
      : [];

    if (intent?.useRecent) {
      // Recall intent: show recent observations
      rows = searchRecent(db, project, intent.limit);
    } else {
      // FTS search: use the prompt as query, optionally type-filtered
      const files = extractFiles(promptText);
      let ftsResult = searchByFts(db, promptText, project, intent?.limit || MAX_RESULTS, intent?.type || null);
      // Fallback: if typed search returned nothing, retry without type filter
      if (ftsResult.rows.length === 0 && intent?.type) {
        ftsResult = searchByFts(db, promptText, project, intent.limit || MAX_RESULTS, null);
      }
      let ftsRows = ftsResult.rows;
      const ftsMode = ftsResult.mode;
      const fileRows = files.length > 0 ? searchByFile(db, files, project, 2) : [];

      // T3 (v2.31): BM25 magnitude threshold — drop FTS hits whose relevance
      // magnitude doesn't clear the floor. This targets OR-fallback leakage
      // where a single-stem match surfaces tangential observations. Only FTS
      // rows carry a `relevance` column; file-recall rows (searchByFile) have
      // no relevance and are always kept — file-scoped recall is presumed
      // intentional and has its own relevance signal (the file name match).
      ftsRows = ftsRows.filter(r =>
        typeof r.relevance === 'number' && Math.abs(r.relevance) >= bm25Floor
      );

      // v2.43.x: OR-mode raw-BM25 floor. In OR-fallback mode the composite
      // TOP_REL_FLOOR below is inflated by importance × type_quality × decay
      // multipliers — a weak single-stem hit on an importance=3 bugfix obs
      // can reach composite rel=66 while raw |bm25|=19. Gate on raw bm25
      // magnitude for OR mode only; AND mode's all-stems-match constraint
      // is a precision signal and routinely produces legitimate AND hits
      // below raw |bm25|=20 that we do not want to drop (see GOOD-narrow
      // probe). Skip gate when OR_TOP_BM25_FLOOR is set to 0 (test hook).
      if (ftsMode === 'OR' && OR_TOP_BM25_FLOOR > 0 && ftsRows.length > 0) {
        const topBm25 = Math.abs(ftsRows[0].bm25_raw || 0);
        if (topBm25 < OR_TOP_BM25_FLOOR) ftsRows = [];
      }

      // v2.34.3: top-|rel| sanity gate. Per-row filtering above leaves noise
      // prompts intact when many rows share a weak stem (all in 25..48 range).
      // If the best remaining FTS match is below the top floor, drop the
      // whole FTS set — noise prompts should produce no FTS injection.
      // Query orders by `relevance` ASC; negative values → ftsRows[0] has the
      // largest magnitude (strongest match) in this scoring expression.
      if (ftsRows.length > 0 && Math.abs(ftsRows[0].relevance) < TOP_REL_FLOOR) {
        ftsRows = [];
      }

      // Merge: FTS results first, then file results, deduplicated
      const seen = new Set(ftsRows.map(r => r.id));
      rows = [...ftsRows];
      for (const r of fileRows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          rows.push(r);
        }
      }
      rows = rows.slice(0, MAX_RESULTS);
    }

    // A (v2.32.8): prepend error-signature hits (higher precision), dedup, cap.
    if (sigRows.length > 0) {
      const sigIds = new Set(sigRows.map(r => r.id));
      rows = [...sigRows, ...rows.filter(r => !sigIds.has(r.id))].slice(0, MAX_RESULTS);
    }

    // v2.34.5 Gap 1: if observations-based search drew a blank, try the
    // user_prompts corpus. Only fires when `rows` is empty (obs hits
    // suppress the fallback to avoid noise). Namespace prompt IDs with
    // a "P" prefix so shouldSkipByDedup's Set comparison doesn't collide
    // with future observation IDs.
    let promptRows = [];
    if (rows.length === 0) {
      promptRows = searchByUserPrompts(db, promptText, project, 3);
    }

    const candidateIds = rows.length > 0
      ? rows.map(r => r.id)
      : promptRows.map(r => `P${r.id}`);
    const dedupSkip = shouldSkipByDedup(candidateIds, INJECTED_IDS_FILE);

    const output = !dedupSkip
      ? (rows.length > 0 ? formatResults(rows) : formatPromptResults(promptRows))
      : null;
    if (output) {
      process.stdout.write(output + '\n');
      // Write injected IDs for dedup with hook.mjs handleUserPrompt + self-dedup
      try {
        let prevCount = 0;
        try {
          const prev = JSON.parse(readFileSync(INJECTED_IDS_FILE, 'utf8'));
          if (prev.ts && Date.now() - prev.ts < DEDUP_STALE_MS) prevCount = prev.count || 0;
        } catch {}
        writeFileSync(INJECTED_IDS_FILE, JSON.stringify({
          ids: candidateIds,
          ts: Date.now(),
          count: prevCount + 1,
        }));
      } catch {}
      // v26 P0: bump injection_count for obs-based emits only (prompt-corpus
      // rows have "P<id>" string IDs; skip those — they live in user_prompts).
      // Per-row try/catch: observations_au trigger reinserts FTS on any UPDATE
      // (project_non_obvious.md); an FTS corruption on one row must not abort
      // counter bumps for other rows.
      if (rows.length > 0) {
        try {
          const now = Date.now();
          const bumpStmt = db.prepare(
            'UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1, last_injected_at = ? WHERE id = ?'
          );
          for (const r of rows) {
            try { bumpStmt.run(now, r.id); } catch {}
          }
        } catch {}
      }
    }

    // ─── L1: Registry skill pointer (T4 v2.31) ──────────────────────────
    // Previously this block injected the full skill body (up to 16KB) on
    // keyword match, silently inflating every matched prompt. We now emit a
    // single pointer line so Claude can decide to invoke via SkillTool on
    // demand — the cooldown and match preconditions stay identical.
    try {
      const skillNames = loadManagedSkillNames();
      const matched = matchRegistrySkillName(promptText, skillNames);
      if (matched) {
        const cooldown = getSkillCooldown();
        if (!cooldown[matched]) {
          process.stdout.write(
            `\n[mem] Skill "${matched}" may apply — invoke via SkillTool or run: claude-mem-lite registry show ${matched}\n`
          );
          setSkillCooldown(matched);
        }
      }
    } catch { /* silent — never block on registry failure */ }
  } catch {
    // Hooks must never break Claude Code — swallow all errors
  } finally {
    try { db.close(); } catch {}
  }
}

main();
