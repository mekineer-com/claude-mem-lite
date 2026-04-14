#!/usr/bin/env node
// claude-mem-lite: Auto-search memory on user prompt
// Runs as UserPromptSubmit hook — injects relevant memories before Claude sees the prompt
// Lightweight: only imports schema.mjs and utils.mjs, no MCP SDK

import { ensureDb, DB_DIR, REGISTRY_DB_PATH } from '../schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, OBS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE, notLowSignalTitleClause } from '../utils.mjs';
import { writeFileSync, readFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { shouldSkip, detectIntent, shouldSkipByDedup, extractFiles, DEDUP_STALE_MS, matchRegistrySkillName } from './prompt-search-utils.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────

const INJECTED_IDS_FILE = join(DB_DIR, 'runtime', `.claude-mem-injected-${inferProject()}`);
const MAX_RESULTS = 5;
const LOOKBACK_MS = 60 * 86400000; // 60 days

// T3 (v2.31): BM25 magnitude threshold. OBS_BM25 (in scoring-sql.mjs) returns the
// raw bm25() value, which in SQLite FTS5 is always negative — lower = better match.
// The `relevance` column multiplies that negative bm25 by positive decay / type /
// importance weights, keeping the sign negative. "Stronger match" therefore means
// larger magnitude, so we compare against `Math.abs(relevance)`.
//
// Empirically (see Task 3 probe in docs/plans/2026-04-14-mem-v2.31-mvp.md):
//   - OR-fallback single-stem match: |rel| ~ 3e-6
//   - Multi-term AND match w/ importance+type boost: |rel| ~ 2e-5 .. 5e-5
// The plan's hinted default (3.5) was a guess that's six orders of magnitude too
// high for this codebase's scoring expression. 1e-5 suppresses OR-fallback noise
// while preserving real hits. Env-overridable for tuning without a redeploy.
const BM25_MIN_SCORE = Number(process.env.CLAUDE_MEM_UPS_BM25_MIN || 1e-5);
// Raw-character minimum length for the prompt. Additional to the CJK-weighted
// `shouldSkip()` effective-length gate; catches medium-short Latin prompts that
// survive `shouldSkip` but carry too few tokens to justify an FTS lookup.
const PROMPT_MIN_LENGTH = 15;

// ─── DB Query Functions ─────────────────────────────────────────────────────

function searchByFts(db, queryText, project, limit, typeFilter) {
  const ftsQuery = sanitizeFtsQuery(queryText);
  if (!ftsQuery) return [];

  const cutoff = Date.now() - LOOKBACK_MS;

  const typeClause = typeFilter ? 'AND o.type = ?' : '';
  const now = Date.now();
  // R1: notLowSignalTitleClause() excludes hook-llm degraded titles
  // ("Modified X", "Worked on X", "Reviewed N files:", raw error logs).
  const sql = `
    SELECT o.id, o.type, o.title, o.lesson_learned,
           ${OBS_BM25}
             * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${TYPE_DECAY_CASE}))
             * ${TYPE_QUALITY_CASE}
             * (0.5 + 0.5 * COALESCE(o.importance, 1)) as relevance
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

  // OR fallback if AND query returned nothing
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      params[1] = orQuery;
      rows = db.prepare(sql).all(...params);
    }
  }

  return rows;
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

function formatResults(rows) {
  if (!rows || rows.length === 0) return null;

  const lines = ['[mem] Related memories:'];
  for (const r of rows) {
    const icon = typeIcon(r.type);
    const title = truncate(r.title || '', 70);
    const lesson = r.lesson_learned ? ` — ${truncate(r.lesson_learned, 50)}` : '';
    lines.push(`#${r.id} ${icon} ${title}${lesson}`);
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
  if (promptText.trim().length < PROMPT_MIN_LENGTH) return;

  let db;
  try {
    db = ensureDb();
  } catch { return; }

  try {
    const project = inferProject();
    const intent = detectIntent(promptText);
    let rows = [];

    if (intent?.useRecent) {
      // Recall intent: show recent observations
      rows = searchRecent(db, project, intent.limit);
    } else {
      // FTS search: use the prompt as query, optionally type-filtered
      const files = extractFiles(promptText);
      let ftsRows = searchByFts(db, promptText, project, intent?.limit || MAX_RESULTS, intent?.type || null);
      // Fallback: if typed search returned nothing, retry without type filter
      if (ftsRows.length === 0 && intent?.type) {
        ftsRows = searchByFts(db, promptText, project, intent.limit || MAX_RESULTS, null);
      }
      const fileRows = files.length > 0 ? searchByFile(db, files, project, 2) : [];

      // T3 (v2.31): BM25 magnitude threshold — drop FTS hits whose relevance
      // magnitude doesn't clear the floor. This targets OR-fallback leakage
      // where a single-stem match surfaces tangential observations. Only FTS
      // rows carry a `relevance` column; file-recall rows (searchByFile) have
      // no relevance and are always kept — file-scoped recall is presumed
      // intentional and has its own relevance signal (the file name match).
      ftsRows = ftsRows.filter(r =>
        typeof r.relevance === 'number' && Math.abs(r.relevance) >= BM25_MIN_SCORE
      );

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

    const candidateIds = rows.map(r => r.id);
    const dedupSkip = shouldSkipByDedup(candidateIds, INJECTED_IDS_FILE);

    const output = !dedupSkip ? formatResults(rows) : null;
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
