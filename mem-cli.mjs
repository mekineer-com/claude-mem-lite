#!/usr/bin/env node
// claude-mem-lite CLI — lightweight command layer for direct memory access
// No MCP SDK or heavy deps — only imports schema.mjs and utils.mjs

import { ensureDb, DB_PATH, checkFTSIntegrity, rebuildFTS } from './schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, jaccardSimilarity, computeMinHash, estimateJaccardFromMinHash, scrubSecrets, cjkBigrams, isoWeekKey, COMPRESSED_PENDING_PURGE, OBS_BM25, TYPE_DECAY_CASE, TYPE_QUALITY_CASE, getCurrentBranch } from './utils.mjs';
import { resolveProject } from './project-utils.mjs';
import { TIER_CASE_SQL, tierSqlParams } from './tier.mjs';
import { getVocabulary, computeVector, vectorSearch, rrfMerge, VECTOR_SCAN_LIMIT, rebuildVocabulary, _resetVocabCache } from './tfidf.mjs';
import { basename, join } from 'path';
import { readFileSync } from 'fs';

// OBS_BM25, TYPE_DECAY_CASE imported from utils.mjs

// ─── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function out(text) {
  process.stdout.write(text + '\n');
}

function relativeTime(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fmtDateShort(iso) {
  if (!iso) return '';
  return iso.slice(0, 10); // YYYY-MM-DD
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdSearch(db, args) {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ');
  if (!query) {
    out('[mem] Usage: mem search <query> [--type TYPE] [--limit N] [--project P] [--from DATE] [--to DATE] [--importance N] [--branch B] [--offset N]');
    return;
  }

  const limit = parseInt(flags.limit, 10) || 5;
  const type = flags.type || null;
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const dateFrom = flags.from ? new Date(flags.from).getTime() : null;
  let dateTo = flags.to ? new Date(flags.to).getTime() : null;
  if (dateTo && flags.to && /^\d{4}-\d{2}-\d{2}$/.test(flags.to)) dateTo += 86400000 - 1;
  const minImportance = flags.importance ? parseInt(flags.importance, 10) : null;
  const branch = flags.branch || null;
  const offset = parseInt(flags.offset, 10) || 0;

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) {
    out(`[mem] No valid search terms in "${query}"`);
    return;
  }

  let rows = searchFts(db, ftsQuery, { type, project, limit, dateFrom, dateTo, minImportance, branch, offset });

  // OR fallback when AND returns 0 results
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      try { rows = searchFts(db, orQuery, { type, project, limit, dateFrom, dateTo, minImportance, branch, offset }); } catch {}
    }
  }

  // Type-list fallback: when --type is specified and FTS finds nothing,
  // list recent observations of that type (user likely wants to browse by type)
  if (rows.length === 0 && type) {
    const typeWheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL', 'type = ?'];
    const typeParams = [type];
    if (project) { typeWheres.push('project = ?'); typeParams.push(project); }
    if (dateFrom) { typeWheres.push('created_at_epoch >= ?'); typeParams.push(dateFrom); }
    if (dateTo) { typeWheres.push('created_at_epoch <= ?'); typeParams.push(dateTo); }
    if (minImportance) { typeWheres.push('COALESCE(importance, 1) >= ?'); typeParams.push(minImportance); }
    if (branch) { typeWheres.push('branch = ?'); typeParams.push(branch); }
    typeParams.push(limit);
    rows = db.prepare(`
      SELECT id, type, title, subtitle, created_at, lesson_learned
      FROM observations
      WHERE ${typeWheres.join(' AND ')}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(...typeParams);
  }

  if (rows.length === 0) {
    out(`[mem] No results for "${query}"`);
    return;
  }

  out(`[mem] ${rows.length} result${rows.length !== 1 ? 's' : ''} for "${query}":`);
  for (const r of rows) {
    const date = fmtDateShort(r.created_at);
    const title = truncate(r.title || r.subtitle || '(untitled)', 70);
    out(`#${r.id} ${typeIcon(r.type)} ${date} ${title}`);
    if (r.lesson_learned) {
      out(`  -> ${truncate(r.lesson_learned, 80)}`);
    }
  }
}

function searchFts(db, ftsQuery, { type, project, limit, dateFrom, dateTo, minImportance, branch, offset }) {
  const now = Date.now();
  // Current project for boost (2× when no explicit project filter)
  const currentProject = !project ? inferProject() : null;

  // WHERE clause params (positional ? in SQL order)
  const whereParams = [ftsQuery];
  const wheres = [
    'observations_fts MATCH ?',
    'COALESCE(o.compressed_into, 0) = 0',
    'o.superseded_at IS NULL',
  ];
  if (project) { wheres.push('o.project = ?'); whereParams.push(project); }
  if (type) { wheres.push('o.type = ?'); whereParams.push(type); }
  if (dateFrom) { wheres.push('o.created_at_epoch >= ?'); whereParams.push(dateFrom); }
  if (dateTo) { wheres.push('o.created_at_epoch <= ?'); whereParams.push(dateTo); }
  if (minImportance) { wheres.push('COALESCE(o.importance, 1) >= ?'); whereParams.push(minImportance); }
  if (branch) { wheres.push('o.branch = ?'); whereParams.push(branch); }

  // ORDER BY params come after WHERE params, then LIMIT/OFFSET
  const orderParams = [now, currentProject, currentProject];
  const params = [...whereParams, ...orderParams, limit, offset || 0];

  // Scoring aligned with server.mjs: BM25 × type-decay × type-quality × project_boost × importance × access_bonus
  const ftsRows = db.prepare(`
    SELECT o.id, o.type, o.title, o.subtitle, o.created_at, o.lesson_learned
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE ${wheres.join(' AND ')}
    ORDER BY ${OBS_BM25}
      * (1.0 + EXP(-0.693 * (? - MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))) / ${TYPE_DECAY_CASE}))
      * ${TYPE_QUALITY_CASE}
      * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
      * (0.5 + 0.5 * COALESCE(o.importance, 1))
      * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
    LIMIT ? OFFSET ?
  `).all(...params);

  // Hybrid: vector search + RRF merge (best-effort)
  try {
    const vocab = getVocabulary(db);
    if (vocab) {
      const queryText = ftsQuery.replace(/['"()]/g, ' ');
      const queryVec = computeVector(queryText, vocab);
      if (queryVec) {
        const vecResults = vectorSearch(db, queryVec, {
          project: project || null,
          vocabVersion: vocab.version,
          limit: VECTOR_SCAN_LIMIT,
        });
        if (vecResults.length > 0 && ftsRows.length > 0) {
          const rrfRanking = rrfMerge(ftsRows, vecResults);
          const rowMap = new Map(ftsRows.map(r => [r.id, r]));
          for (const vr of vecResults) {
            if (!rowMap.has(vr.id)) {
              const obs = db.prepare('SELECT id, type, title, subtitle, created_at, created_at_epoch, lesson_learned, importance, branch FROM observations WHERE id = ?').get(vr.id);
              if (obs) {
                // Apply same filters as FTS5 query (aligned with MCP searchObservations)
                if (dateFrom && obs.created_at_epoch < dateFrom) continue;
                if (dateTo && obs.created_at_epoch > dateTo) continue;
                if (minImportance && (obs.importance ?? 1) < minImportance) continue;
                if (branch && obs.branch !== branch) continue;
                rowMap.set(vr.id, obs);
              }
            }
          }
          return rrfRanking
            .filter(rr => rowMap.has(rr.id))
            .map(rr => rowMap.get(rr.id))
            .slice(0, limit);
        } else if (vecResults.length > 0 && ftsRows.length === 0) {
          return vecResults
            .map(vr => db.prepare('SELECT id, type, title, subtitle, created_at, created_at_epoch, lesson_learned, importance, branch FROM observations WHERE id = ?').get(vr.id))
            .filter(obs => {
              if (!obs) return false;
              if (dateFrom && obs.created_at_epoch < dateFrom) return false;
              if (dateTo && obs.created_at_epoch > dateTo) return false;
              if (minImportance && (obs.importance ?? 1) < minImportance) return false;
              if (branch && obs.branch !== branch) return false;
              return true;
            })
            .slice(0, limit);
        }
      }
    }
  } catch { /* vector search is best-effort */ }

  return ftsRows;
}

function cmdRecent(db, args) {
  const { positional, flags } = parseArgs(args);
  const limit = parseInt(positional[0], 10) || 5;
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();

  const params = [];
  const wheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL'];
  if (project) { wheres.push('project = ?'); params.push(project); }
  params.push(limit);

  const rows = db.prepare(`
    SELECT id, type, title, subtitle, created_at_epoch, created_at
    FROM observations
    WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...params);

  if (rows.length === 0) {
    out(`[mem] No recent observations${project ? ` (${project})` : ''}`);
    return;
  }

  out(`[mem] Recent (${project || 'all'}):`);
  for (const r of rows) {
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 60);
    out(`#${r.id} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
  }
}

function cmdRecall(db, args) {
  const { positional, flags } = parseArgs(args);
  const file = positional.join(' ');
  if (!file) {
    out('[mem] Usage: mem recall <file>');
    return;
  }

  const filename = basename(file);
  const limit = parseInt(flags.limit, 10) || 10;

  // Search via observation_files junction table for indexed filename lookups
  const escaped = filename.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const likePattern = `%${escaped}`;
  const rows = db.prepare(`
    SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned, o.created_at
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE COALESCE(o.compressed_into, 0) = 0
      AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(filename, likePattern, limit);

  if (rows.length === 0) {
    out(`[mem] No history for "${filename}"`);
    return;
  }

  // Update access_count for recalled observations (aligned with MCP mem_recall)
  const recalledIds = rows.map(r => r.id);
  const recallPh = recalledIds.map(() => '?').join(',');
  db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${recallPh})`).run(Date.now(), ...recalledIds);

  out(`[mem] History for ${filename}:`);
  for (const r of rows) {
    const title = truncate(r.title || '(untitled)', 60);
    const lesson = r.lesson_learned ? ` -- ${truncate(r.lesson_learned, 50)}` : '';
    out(`#${r.id} ${typeIcon(r.type)} ${title}${lesson}`);
  }
}

function cmdGet(db, args) {
  const { positional, flags } = parseArgs(args);
  const idStr = positional.join(',');
  if (!idStr) {
    out('[mem] Usage: mem get <id1,id2,...> [--source obs|session|prompt]');
    return;
  }

  const ids = idStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (ids.length === 0) {
    out('[mem] No valid IDs provided');
    return;
  }

  const source = flags.source || 'obs';
  const placeholders = ids.map(() => '?').join(',');

  if (source === 'session') {
    const rows = db.prepare(`SELECT * FROM session_summaries WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...ids);
    if (rows.length === 0) { out('[mem] No sessions found for given IDs'); return; }
    const parts = [];
    for (const r of rows) {
      const lines = [`S#${r.id} ${fmtDateShort(r.created_at)}`];
      if (r.request) lines.push(`Request: ${r.request}`);
      if (r.completed) lines.push(`Completed: ${r.completed}`);
      if (r.investigated) lines.push(`Investigated: ${r.investigated}`);
      if (r.learned) lines.push(`Learned: ${r.learned}`);
      if (r.next_steps) lines.push(`Next steps: ${r.next_steps}`);
      if (r.project) lines.push(`Project: ${r.project}`);
      parts.push(lines.join('\n'));
    }
    out(parts.join('\n\n'));
    return;
  }

  if (source === 'prompt') {
    const rows = db.prepare(`SELECT * FROM user_prompts WHERE id IN (${placeholders}) ORDER BY created_at_epoch ASC`).all(...ids);
    if (rows.length === 0) { out('[mem] No prompts found for given IDs'); return; }
    const parts = [];
    for (const r of rows) {
      const lines = [`P#${r.id} ${fmtDateShort(r.created_at)}`];
      if (r.prompt_text) lines.push(`Text: ${r.prompt_text}`);
      if (r.content_session_id) lines.push(`Session: ${r.content_session_id}`);
      parts.push(lines.join('\n'));
    }
    out(parts.join('\n\n'));
    return;
  }

  // Default: observations
  // Update access_count (aligned with MCP mem_get)
  db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${placeholders})`).run(Date.now(), ...ids);

  const rows = db.prepare(`
    SELECT id, type, title, subtitle, narrative, text, concepts, facts,
           files_read, files_modified, lesson_learned, importance, created_at, project
    FROM observations
    WHERE id IN (${placeholders})
    ORDER BY created_at_epoch ASC
  `).all(...ids);

  if (rows.length === 0) {
    out('[mem] No observations found for given IDs');
    return;
  }

  const parts = [];
  for (const r of rows) {
    const lines = [`#${r.id} [${r.type}] ${fmtDateShort(r.created_at)}`];
    if (r.title) lines.push(`Title: ${r.title}`);
    if (r.subtitle) lines.push(`Subtitle: ${r.subtitle}`);

    // Collect files from JSON arrays
    const files = [];
    try {
      const modified = JSON.parse(r.files_modified || '[]');
      const read = JSON.parse(r.files_read || '[]');
      if (modified.length) files.push(...modified.map(f => basename(f)));
      if (read.length && !modified.length) files.push(...read.map(f => basename(f)));
    } catch {}
    if (files.length) lines.push(`Files: ${files.join(', ')}`);

    if (r.lesson_learned) lines.push(`Lesson: ${r.lesson_learned}`);
    if (r.narrative) lines.push(`Narrative: ${truncate(r.narrative, 200)}`);
    if (r.concepts) lines.push(`Concepts: ${r.concepts}`);
    if (r.importance) lines.push(`Importance: ${r.importance}`);
    parts.push(lines.join('\n'));
  }

  out(parts.join('\n\n'));
}

function cmdTimeline(db, args) {
  const { positional, flags } = parseArgs(args);
  let anchorId = parseInt(flags.anchor, 10);
  const before = parseInt(flags.before, 10) || 5;
  const after = parseInt(flags.after, 10) || 5;
  const project = flags.project ? resolveProject(db, flags.project) : null;

  // Support query-based anchor: `timeline --query "search terms"` or positional
  const queryStr = flags.query || positional.join(' ');
  if ((!anchorId || isNaN(anchorId)) && queryStr) {
    const ftsQuery = sanitizeFtsQuery(queryStr);
    if (ftsQuery) {
      const match = db.prepare(`
        SELECT o.id FROM observations_fts
        JOIN observations o ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
        ORDER BY ${OBS_BM25}
        LIMIT 1
      `).get(ftsQuery);
      if (match) anchorId = match.id;
    }
  }

  if (!anchorId || isNaN(anchorId)) {
    out('[mem] Usage: mem timeline --anchor <id> [--query "text"] [--before N] [--after N] [--project P]');
    return;
  }

  // Update access_count for anchor (aligned with MCP mem_timeline)
  db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?').run(Date.now(), anchorId);

  // Get anchor epoch
  const anchorRow = db.prepare('SELECT created_at_epoch, project FROM observations WHERE id = ?').get(anchorId);
  if (!anchorRow) {
    out(`[mem] Observation #${anchorId} not found`);
    return;
  }

  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  // Before anchor
  const beforeRows = db.prepare(`
    SELECT id, type, title, subtitle, created_at, created_at_epoch
    FROM observations
    WHERE created_at_epoch < ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(anchorRow.created_at_epoch, ...baseParams, before);

  // After anchor
  const afterRows = db.prepare(`
    SELECT id, type, title, subtitle, created_at, created_at_epoch
    FROM observations
    WHERE created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL ${projectFilter}
    ORDER BY created_at_epoch ASC
    LIMIT ?
  `).all(anchorRow.created_at_epoch, ...baseParams, after);

  // Anchor itself
  const anchor = db.prepare(
    'SELECT id, type, title, subtitle, created_at, created_at_epoch FROM observations WHERE id = ?'
  ).get(anchorId);

  const all = [...beforeRows.reverse(), anchor, ...afterRows];

  out(`[mem] Timeline around #${anchorId}:`);
  for (const r of all) {
    const marker = r.id === anchorId ? ' <--' : '';
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 60);
    out(`#${r.id} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}${marker}`);
  }
}

function cmdSave(db, args) {
  const { positional, flags } = parseArgs(args);
  const text = positional.join(' ');
  if (!text) {
    out('[mem] Usage: mem save "<text>" [--type T] [--title T] [--importance N] [--project P] [--files f1,f2]');
    return;
  }

  const type = flags.type || 'discovery';
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  if (!validTypes.has(type)) {
    out(`[mem] Invalid type "${type}". Valid: ${[...validTypes].join(', ')}`);
    return;
  }

  const rawTitle = flags.title || text.slice(0, 100);
  // Explicit saves default to importance=2 (notable) — user chose to save
  const importance = Math.max(1, Math.min(3, parseInt(flags.importance, 10) || 2));
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const saveFiles = flags.files ? flags.files.split(',').map(f => f.trim()).filter(Boolean) : [];

  // Secret scrubbing (aligned with MCP mem_save)
  const safeContent = scrubSecrets(text);
  const safeTitle = scrubSecrets(rawTitle);

  // Dedup: skip if similar title/content saved in last 5 minutes (aligned with MCP mem_save)
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recent = db.prepare(`
    SELECT id, title, text FROM observations
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC LIMIT 50
  `).all(project, fiveMinAgo);

  const dupMatch = recent.find(r =>
    jaccardSimilarity(r.title, safeTitle) > 0.7 ||
    jaccardSimilarity(r.text || '', safeContent) > 0.7
  );
  if (dupMatch) {
    out(`[mem] Skipped: similar to existing #${dupMatch.id}. Use "claude-mem-lite get ${dupMatch.id}" to review.`);
    return;
  }

  // MinHash + CJK bigrams (aligned with MCP mem_save)
  const minhashSig = computeMinHash(safeTitle + ' ' + safeContent);
  const bigramText = cjkBigrams(safeTitle + ' ' + safeContent);
  const textField = bigramText ? safeContent + ' ' + bigramText : safeContent;

  const now = new Date();
  const sessionId = `cli-${now.getTime()}`;

  // Ensure a session exists for the FK constraint
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'completed')
  `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

  // Atomic: insert observation + observation_files + TF-IDF vector (aligned with MCP mem_save)
  const saveTx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, branch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', ?, ?, ?, ?, ?, ?)
    `).run(sessionId, project, textField, type, safeTitle, safeContent, JSON.stringify(saveFiles), importance, minhashSig, getCurrentBranch(), now.toISOString(), now.getTime());
    const savedId = Number(result.lastInsertRowid);

    // Populate observation_files junction table (aligned with MCP mem_save)
    if (savedId && saveFiles.length > 0) {
      const insertFile = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
      for (const f of saveFiles) insertFile.run(savedId, f);
    }

    // Write TF-IDF vector
    try {
      const vocab = getVocabulary(db);
      if (vocab) {
        const vec = computeVector(safeTitle + ' ' + safeContent, vocab);
        if (vec) {
          db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
            .run(savedId, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
    } catch { /* non-critical */ }

    return result;
  });
  const result = saveTx();

  out(`[mem] Saved #${result.lastInsertRowid} [${type}] "${truncate(safeTitle, 60)}" (project: ${project})`);
}

function cmdStats(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const days = parseInt(flags.days, 10) || 30;

  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  const now = Date.now();
  const thirtyDaysAgo = now - days * 86400000;
  const sevenDaysAgo = now - 7 * 86400000;

  // Total observations
  const obsTotal = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE 1=1 ${projectFilter}`
  ).get(...baseParams);

  // 30d and 7d counts
  const obs30d = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`
  ).get(thirtyDaysAgo, ...baseParams);

  const obs7d = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`
  ).get(sevenDaysAgo, ...baseParams);

  // Session count
  const sessTotal = db.prepare(
    `SELECT COUNT(*) as c FROM sdk_sessions WHERE 1=1 ${project ? 'AND project = ?' : ''}`
  ).get(...baseParams);

  // Project count
  const projCount = db.prepare(
    'SELECT COUNT(DISTINCT project) as c FROM observations'
  ).get();

  // Type distribution
  const types = db.prepare(`
    SELECT type, COUNT(*) as c FROM observations
    WHERE 1=1 ${projectFilter}
    GROUP BY type ORDER BY c DESC
  `).all(...baseParams);

  const typeLine = types.map(t => `${t.type}=${t.c}`).join(' ');

  out(`[mem] Stats${project ? ` (${project})` : ''}:`);
  out(`Observations: ${obsTotal.c.toLocaleString()} (30d: ${obs30d.c}, 7d: ${obs7d.c})`);
  out(`Sessions: ${sessTotal.c} | Projects: ${projCount.c}`);
  if (typeLine) out(`Types: ${typeLine}`);
}

function cmdContext(_db, _args) {
  // Read the project's CLAUDE.md and extract the context block
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
  const claudeMdPath = join(projectDir, 'CLAUDE.md');

  let content;
  try {
    content = readFileSync(claudeMdPath, 'utf8');
  } catch {
    out(`[mem] No CLAUDE.md found at ${claudeMdPath}`);
    return;
  }

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';
  const startIdx = content.lastIndexOf(startTag);
  const endIdx = content.lastIndexOf(endTag);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    out('[mem] No claude-mem-context block found in CLAUDE.md');
    return;
  }

  const block = content.slice(startIdx + startTag.length, endIdx).trim();
  out(`[mem] Current context:\n${block}`);
}

// ─── Browse (tier-grouped dashboard) ────────────────────────────────────────

function cmdBrowse(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();
  const tierFilter = flags.tier || null;
  if (tierFilter && !['working', 'active', 'archive'].includes(tierFilter)) {
    out(`[mem] Invalid tier: "${tierFilter}". Use: working, active, or archive`);
    return;
  }
  const limit = parseInt(flags.limit, 10) || (tierFilter ? 20 : 5);
  const now = Date.now();

  const ctx = {
    now,
    currentProject: project,
    currentSessionId: getActiveSessionId(db, project),
  };
  const params = tierSqlParams(ctx);

  const tiers = ['working', 'active', 'archive'];
  const tierLabels = { working: '🔴 Working Memory', active: '🟡 Active Memory', archive: '🔵 Archive' };
  const showTiers = tierFilter ? [tierFilter] : tiers;

  out(`📊 Memory Dashboard (${project})\n`);

  let grandTotal = 0;
  const tierCounts = {};

  for (const tier of showTiers) {
    const countRow = db.prepare(`
      SELECT COUNT(*) as c FROM (
        SELECT ${TIER_CASE_SQL} as tier FROM observations
        WHERE project = ?
      ) WHERE tier = ?
    `).get(...params, project, tier);
    const count = countRow?.c ?? 0;
    tierCounts[tier] = count;
    grandTotal += count;

    out(`${tierLabels[tier]} (${count})`);

    if (tier === 'archive' && !tierFilter) {
      if (count > 0) out('');
      continue;
    }

    if (count === 0) { out(''); continue; }

    const rows = db.prepare(`
      SELECT * FROM (
        SELECT id, type, title, created_at_epoch, ${TIER_CASE_SQL} as tier
        FROM observations
        WHERE project = ?
      ) WHERE tier = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(...params, project, tier, limit);

    for (const r of rows) {
      out(`  #${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)', 60)} | ${relativeTime(r.created_at_epoch)}`);
    }
    if (count > rows.length) out(`  ... and ${count - rows.length} more`);
    out('');
  }

  if (grandTotal === 0) {
    out('No observations found. Start a coding session to build memory.');
    return;
  }

  if (!tierFilter) {
    const parts = tiers.map(t => `${t[0].toUpperCase() + t.slice(1)}: ${tierCounts[t] ?? 0}`);
    out(`Totals: ${grandTotal} observations | ${parts.join(' | ')}`);
  }
}

function getActiveSessionId(db, project) {
  const row = db.prepare(
    "SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND status = 'active' ORDER BY started_at_epoch DESC LIMIT 1"
  ).get(project);
  return row?.memory_session_id ?? '';
}

// ─── Delete ──────────────────────────────────────────────────────────────────

function cmdDelete(db, args) {
  const { positional, flags } = parseArgs(args);
  const idStr = positional.join(',');
  if (!idStr) {
    out('[mem] Usage: mem delete <id1,id2,...> [--confirm]');
    return;
  }

  const ids = idStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (ids.length === 0) {
    out('[mem] No valid IDs provided');
    return;
  }

  const confirm = flags.confirm === true || flags.confirm === 'true';
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, type, title, project FROM observations WHERE id IN (${placeholders})`).all(...ids);

  if (rows.length === 0) {
    out('[mem] No observations found for given IDs');
    return;
  }

  if (!confirm) {
    out(`[mem] Preview: ${rows.length} observation(s) will be deleted:`);
    for (const r of rows) {
      out(`  #${r.id} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${r.project}`);
    }
    out('[mem] Run with --confirm to execute deletion.');
    return;
  }

  // Transaction: clean up related_ids references + delete (aligned with MCP mem_delete)
  const deletedIds = new Set(ids);
  const deleteTx = db.transaction(() => {
    const likeConditions = ids.map(() => `related_ids LIKE ?`).join(' OR ');
    const likeParams = ids.map(id => `%${id}%`);
    const referencing = db.prepare(`
      SELECT id, related_ids FROM observations
      WHERE related_ids IS NOT NULL AND related_ids != '[]' AND (${likeConditions})
    `).all(...likeParams);
    for (const r of referencing) {
      let refIds;
      try { refIds = JSON.parse(r.related_ids); } catch { continue; }
      if (!Array.isArray(refIds)) continue;
      const filtered = refIds.filter(id => !deletedIds.has(id));
      if (filtered.length !== refIds.length) {
        db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(filtered), r.id);
      }
    }
    return db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);
  });
  const result = deleteTx();
  const missing = ids.filter(id => !rows.some(r => r.id === id));
  out(`[mem] Deleted ${result.changes} observation(s).${missing.length > 0 ? ` Note: ID(s) ${missing.join(', ')} not found.` : ''}`);
}

// ─── Update ──────────────────────────────────────────────────────────────────

function cmdUpdate(db, args) {
  const { positional, flags } = parseArgs(args);
  const id = parseInt(positional[0], 10);
  if (!id || isNaN(id)) {
    out('[mem] Usage: mem update <id> [--title T] [--type T] [--importance N] [--lesson T] [--narrative T] [--concepts T]');
    return;
  }

  const obs = db.prepare('SELECT id, title FROM observations WHERE id = ?').get(id);
  if (!obs) {
    out(`[mem] Observation #${id} not found`);
    return;
  }

  const updates = [];
  const params = [];
  if (flags.title) { updates.push('title = ?'); params.push(scrubSecrets(flags.title)); }
  if (flags.narrative) { updates.push('narrative = ?'); params.push(scrubSecrets(flags.narrative)); }
  if (flags.type) { updates.push('type = ?'); params.push(flags.type); }
  if (flags.importance) { updates.push('importance = ?'); params.push(Math.max(1, Math.min(3, parseInt(flags.importance, 10)))); }
  if (flags.lesson) { updates.push('lesson_learned = ?'); params.push(scrubSecrets(flags.lesson)); }
  if (flags.concepts) { updates.push('concepts = ?'); params.push(flags.concepts); }

  if (updates.length === 0) {
    out('[mem] No fields to update. Use --title, --type, --importance, --lesson, --narrative, --concepts');
    return;
  }

  params.push(id);

  // Atomic: update fields + rebuild FTS text + re-vectorize (aligned with MCP mem_update)
  db.transaction(() => {
    db.prepare(`UPDATE observations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Rebuild FTS text field
    const row = db.prepare('SELECT title, subtitle, narrative, concepts, facts, lesson_learned, search_aliases FROM observations WHERE id = ?').get(id);
    const base = [row.title, row.subtitle, row.narrative, row.concepts, row.facts, row.lesson_learned, row.search_aliases].filter(Boolean).join(' ');
    const bigrams = cjkBigrams((row.title || '') + ' ' + (row.narrative || ''));
    const textField = bigrams ? base + ' ' + bigrams : base;
    db.prepare('UPDATE observations SET text = ? WHERE id = ?').run(textField, id);

    // Re-vectorize (non-critical — catch to avoid rollback)
    try {
      const vocab = getVocabulary(db);
      if (vocab) {
        const vec = computeVector(textField, vocab);
        if (vec) {
          db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
            .run(id, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
    } catch { /* non-critical */ }
  })();

  out(`[mem] Updated #${id}: ${updates.map(u => u.split(' =')[0]).join(', ')}`);
}

// ─── Export ──────────────────────────────────────────────────────────────────

function cmdExport(db, args) {
  const { flags } = parseArgs(args);
  const wheres = ['COALESCE(compressed_into, 0) = 0', 'superseded_at IS NULL'];
  const params = [];

  const project = flags.project ? resolveProject(db, flags.project) : null;
  if (project) { wheres.push('project = ?'); params.push(project); }
  if (flags.type) { wheres.push('type = ?'); params.push(flags.type); }
  if (flags.from) {
    const epoch = new Date(flags.from).getTime();
    if (!isNaN(epoch)) { wheres.push('created_at_epoch >= ?'); params.push(epoch); }
  }
  if (flags.to) {
    let epoch = new Date(flags.to).getTime();
    if (flags.to && /^\d{4}-\d{2}-\d{2}$/.test(flags.to)) epoch += 86400000 - 1;
    if (!isNaN(epoch)) { wheres.push('created_at_epoch <= ?'); params.push(epoch); }
  }

  const limit = Math.min(parseInt(flags.limit, 10) || 200, 1000);
  const format = flags.format || 'json';

  const rows = db.prepare(`
    SELECT id, project, type, title, subtitle, narrative, concepts, facts, lesson_learned, importance, files_modified, created_at, created_at_epoch
    FROM observations WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(...params, limit);

  if (rows.length === 0) {
    out('[mem] No observations found matching criteria');
    return;
  }

  if (format === 'jsonl') {
    for (const r of rows) out(JSON.stringify(r));
  } else {
    out(JSON.stringify(rows, null, 2));
  }

  if (rows.length >= limit) {
    process.stderr.write(`[mem] Note: Results capped at ${limit}. Use --from/--to or --limit to export more.\n`);
  }
}

// ─── Compress ────────────────────────────────────────────────────────────────

function cmdCompress(db, args) {
  const { flags } = parseArgs(args);
  const preview = flags.execute !== true && flags.execute !== 'true';
  const ageDays = parseInt(flags['age-days'], 10) || 30;
  const cutoff = Date.now() - ageDays * 86400000;
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  const candidates = db.prepare(`
    SELECT id, project, type, title, created_at, created_at_epoch
    FROM observations
    WHERE COALESCE(importance, 1) = 1
      AND COALESCE(access_count, 0) = 0
      AND created_at_epoch < ?
      AND compressed_into IS NULL
      ${projectFilter}
    ORDER BY project, created_at_epoch
  `).all(cutoff, ...baseParams);

  if (candidates.length === 0) {
    out('[mem] No candidates for compression.');
    return;
  }

  // Group by project + ISO week
  const groups = new Map();
  for (const c of candidates) {
    const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const compressableGroups = [...groups.entries()].filter(([, obs]) => obs.length >= 3);

  if (preview) {
    const totalCandidates = compressableGroups.reduce((s, [, obs]) => s + obs.length, 0);
    out(`[mem] Compression preview:`);
    out(`  Total candidates: ${candidates.length}`);
    out(`  Compressable groups (≥3 obs): ${compressableGroups.length}`);
    out(`  Observations to compress: ${totalCandidates}`);
    for (const [key, obs] of compressableGroups.slice(0, 20)) {
      const [proj, week] = key.split('::');
      const types = {};
      for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
      const typeStr = Object.entries(types).map(([t, c]) => `${c} ${t}`).join(', ');
      out(`  ${proj} ${week}: ${obs.length} obs (${typeStr})`);
    }
    out('[mem] Run with --execute to compress.');
    return;
  }

  // Execute compression
  let totalCompressed = 0;
  const insertSummary = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, '', ?, '', '', '[]', '[]', 2, ?, ?)
  `);

  db.transaction(() => {
    for (const [key, obs] of compressableGroups) {
      const [proj] = key.split('::');
      const types = {};
      for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
      const dominantType = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
      const title = `Weekly summary: ${obs.length} ${dominantType} observations`;
      const narrative = obs.map(o => `- ${o.title || '(untitled)'}`).join('\n');
      const sessionId = `compress-${proj}`;

      const sortedEpochs = obs.map(o => o.created_at_epoch).sort((a, b) => a - b);
      const medianEpoch = sortedEpochs[Math.floor(sortedEpochs.length / 2)];
      const medianDate = new Date(medianEpoch);

      const now = new Date();
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(sessionId, sessionId, proj, now.toISOString(), now.getTime());

      const summaryResult = insertSummary.run(
        sessionId, proj, narrative, dominantType, title, narrative,
        medianDate.toISOString(), medianEpoch
      );
      const summaryId = Number(summaryResult.lastInsertRowid);

      const obsIds = obs.map(o => o.id);
      const obsPh = obsIds.map(() => '?').join(',');
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${obsPh})`).run(summaryId, ...obsIds);
      totalCompressed += obs.length;
    }
  })();

  out(`[mem] Compressed ${totalCompressed} observations into ${compressableGroups.length} weekly summaries.`);
}

// ─── Maintain ────────────────────────────────────────────────────────────────

function cmdMaintain(db, args) {
  const { positional, flags } = parseArgs(args);
  const action = positional[0];
  if (!action || !['scan', 'execute'].includes(action)) {
    out('[mem] Usage: mem maintain <scan|execute> [--ops cleanup,decay,boost,dedup,purge_stale,rebuild_vectors] [--project P] [--retain-days N] [--merge-ids keepId:removeId,...]');
    return;
  }

  const project = flags.project ? resolveProject(db, flags.project) : null;
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];
  const STALE_AGE_MS = 30 * 86400000;
  const SCAN_LIMIT = 500;
  const SIMILARITY_THRESHOLD = 0.7;

  if (action === 'scan') {
    const staleAge = Date.now() - STALE_AGE_MS;

    // Find near-duplicates (MinHash pre-filter → Jaccard)
    const recent = db.prepare(`
      SELECT id, title, importance, access_count, created_at_epoch
      FROM observations
      WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
      ORDER BY created_at_epoch DESC LIMIT ${SCAN_LIMIT}
    `).all(...baseParams);

    const titles = recent.map(r => (r.title || '').trim());
    const minhashes = titles.map(t => t ? computeMinHash(t) : null);
    const duplicates = [];
    for (let i = 0; i < recent.length && duplicates.length < 50; i++) {
      if (!titles[i] || !minhashes[i]) continue;
      for (let j = i + 1; j < recent.length; j++) {
        if (!titles[j] || !minhashes[j]) continue;
        if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < 0.5) continue;
        const sim = jaccardSimilarity(titles[i], titles[j]);
        if (sim > SIMILARITY_THRESHOLD) {
          duplicates.push({ a: recent[i], b: recent[j], similarity: sim.toFixed(2) });
        }
        if (duplicates.length >= 50) break;
      }
    }

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN COALESCE(importance, 1) = 1 AND COALESCE(access_count, 0) = 0
                      AND created_at_epoch < ? THEN 1 ELSE 0 END) as stale,
        SUM(CASE WHEN (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
                 THEN 1 ELSE 0 END) as broken,
        SUM(CASE WHEN COALESCE(access_count, 0) > 3 AND COALESCE(importance, 1) < 3
                 THEN 1 ELSE 0 END) as boostable
      FROM observations
      WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
    `).get(staleAge, ...baseParams);

    const pendingPurge = db.prepare(
      `SELECT COUNT(*) as count FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} ${projectFilter}`
    ).get(...baseParams);

    out(`[mem] Maintenance scan:`);
    out(`  Total active: ${stats.total}`);
    out(`  Near-duplicate pairs: ${duplicates.length}`);
    out(`  Stale (>30d, imp=1, no access): ${stats.stale}`);
    out(`  Broken (no title/narrative): ${stats.broken}`);
    out(`  Boostable (accessed>3, imp<3): ${stats.boostable}`);
    out(`  Pending purge: ${pendingPurge.count}`);
    if (duplicates.length > 0) {
      out('  Duplicates:');
      for (const d of duplicates.slice(0, 15)) {
        out(`    [${d.a.id}] "${truncate(d.a.title, 40)}" <-> [${d.b.id}] "${truncate(d.b.title, 40)}" (${d.similarity})`);
      }
    }
    return;
  }

  // Execute
  const opsStr = flags.ops || 'cleanup,decay,boost';
  const ops = opsStr.split(',').map(s => s.trim());
  const staleAge = Date.now() - STALE_AGE_MS;
  const OP_CAP = 1000;
  const results = [];

  db.transaction(() => {
    if (ops.includes('cleanup')) {
      const deleted = db.prepare(`
        DELETE FROM observations WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(...baseParams);
      results.push(`Cleaned up ${deleted.changes} broken observations`);
    }

    if (ops.includes('decay')) {
      const decayed = db.prepare(`
        UPDATE observations SET importance = MAX(1, COALESCE(importance, 1) - 1)
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(importance, 1) > 1
            AND COALESCE(access_count, 0) = 0
            AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(staleAge, ...baseParams);

      // Mark importance=1, never-accessed, old observations as pending-purge (aligned with MCP)
      const idleMarked = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(importance, 1) = 1
            AND COALESCE(access_count, 0) = 0
            AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(staleAge, ...baseParams);
      results.push(`Decayed ${decayed.changes} stale observations, marked ${idleMarked.changes} idle as pending-purge`);
    }

    if (ops.includes('boost')) {
      const boosted = db.prepare(`
        UPDATE observations SET importance = MIN(3, COALESCE(importance, 1) + 1)
        WHERE id IN (
          SELECT id FROM observations
          WHERE COALESCE(compressed_into, 0) = 0
            AND COALESCE(access_count, 0) > 3
            AND COALESCE(importance, 1) < 3
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(...baseParams);
      results.push(`Boosted ${boosted.changes} frequently-accessed observations`);
    }

    if (ops.includes('dedup') && flags['merge-ids']) {
      // Parse merge-ids: "keepId:removeId1:removeId2,keepId2:removeId3" format
      let totalMerged = 0;
      const mergeStmt = db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ? AND COALESCE(compressed_into, 0) = 0');
      const groups = flags['merge-ids'].split(',').map(g => g.trim().split(':').map(Number).filter(n => !isNaN(n)));
      for (const group of groups) {
        if (group.length < 2) continue;
        const [keepId, ...removeIds] = group;
        for (const removeId of removeIds) {
          totalMerged += mergeStmt.run(keepId, removeId).changes;
        }
      }
      results.push(`Merged ${totalMerged} duplicate observations`);
    }

    if (ops.includes('purge_stale')) {
      const retainDays = parseInt(flags['retain-days'], 10) || 30;
      const retainCutoff = Date.now() - retainDays * 86400000;
      const purged = db.prepare(`
        DELETE FROM observations WHERE id IN (
          SELECT id FROM observations
          WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ?
            ${projectFilter} LIMIT ${OP_CAP}
        )
      `).run(retainCutoff, ...baseParams);
      results.push(`Purged ${purged.changes} stale observations`);
    }
  })();

  // FTS optimize
  db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
  results.push('FTS5 index optimized');

  // rebuild_vectors: outside main transaction (aligned with MCP mem_maintain)
  if (ops.includes('rebuild_vectors')) {
    try {
      _resetVocabCache();
      const vocab = rebuildVocabulary(db);
      if (!vocab) {
        results.push('Vectors: no observations to build vocabulary from');
      } else {
        const allObs = db.prepare(`
          SELECT id, title, narrative, concepts FROM observations
          WHERE COALESCE(compressed_into, 0) = 0 AND superseded_at IS NULL
        `).all();
        let updated = 0;
        const insertStmt = db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)');
        const vecNow = Date.now();
        db.transaction(() => {
          db.prepare('DELETE FROM observation_vectors').run();
          for (const obs of allObs) {
            const text = [obs.title || '', obs.narrative || '', obs.concepts || ''].filter(Boolean).join(' ');
            const vec = computeVector(text, vocab);
            if (vec) {
              insertStmt.run(obs.id, Buffer.from(vec.buffer), vocab.version, vecNow);
              updated++;
            }
          }
        })();
        results.push(`Vectors: rebuilt vocabulary (${vocab.terms.size} terms), updated ${updated}/${allObs.length} vectors`);
      }
    } catch (e) {
      results.push(`Vectors: rebuild failed — ${e.message}`);
    }
  }

  out(`[mem] ${results.join('\n[mem] ')}`);
}

// ─── FTS Check ───────────────────────────────────────────────────────────────

function cmdFtsCheck(db, args) {
  const { positional } = parseArgs(args);
  const action = positional[0];
  if (!action || !['check', 'rebuild'].includes(action)) {
    out('[mem] Usage: mem fts-check <check|rebuild>');
    return;
  }

  if (action === 'check') {
    const result = checkFTSIntegrity(db);
    if (result.healthy) {
      out('[mem] FTS5 indexes are healthy — all integrity checks passed.');
    } else {
      out(`[mem] FTS5 issues found:`);
      for (const d of result.details) out(`  ${d}`);
    }
    return;
  }

  if (action === 'rebuild') {
    const result = rebuildFTS(db);
    if (result.errors.length > 0) {
      out(`[mem] Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`);
    } else {
      out(`[mem] Successfully rebuilt: ${result.rebuilt.join(', ')}`);
    }
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────

function cmdHelp() {
  out(`claude-mem-lite CLI

Commands:
  search <query>        FTS5 search observations
    --type T            Filter by type (bugfix|decision|discovery|feature|refactor|change)
    --limit N           Max results (default 5)
    --project P         Filter by project
    --from DATE         Start date (YYYY-MM-DD or ISO 8601)
    --to DATE           End date (YYYY-MM-DD or ISO 8601)
    --importance N      Minimum importance (1-3)
    --branch B          Filter by git branch
    --offset N          Skip first N results (pagination)

  recent [N]            Show N most recent observations (default 5)
    --project P         Filter by project

  recall <file>         Show observations related to a file
    --limit N           Max results (default 10)

  get <id1,id2,...>     Get full details by ID
    --source S          Record type: obs (default), session, prompt

  timeline              Show observations around an anchor
    --anchor ID         Center on this observation ID
    --query "text"      Find anchor by FTS5 search
    --before N          Show N before anchor (default 5)
    --after N           Show N after anchor (default 5)
    --project P         Filter by project

  save "<text>"         Save a new observation
    --type T            Observation type (default: discovery)
    --title T           Title (auto-generated if omitted)
    --importance N      1-3 (default: 2)
    --project P         Project name
    --files f1,f2       Comma-separated file paths

  delete <id1,id2,...>  Delete observations by ID
    --confirm           Execute deletion (preview by default)

  update <id>           Update an existing observation
    --title T           New title
    --type T            New type
    --importance N      New importance (1-3)
    --lesson T          Add/update lesson learned
    --narrative T       New narrative
    --concepts T        Space-separated concept tags

  export                Export observations as JSON/JSONL
    --project P         Filter by project
    --type T            Filter by type
    --format F          json (default) or jsonl
    --from DATE         Start date
    --to DATE           End date
    --limit N           Max results (default 200, max 1000)

  compress              Compress old low-value observations
    --execute           Execute compression (preview by default)
    --age-days N        Min age in days (default 30)
    --project P         Filter by project

  maintain <scan|exec>  Memory maintenance
    --ops O             Comma-separated: cleanup,decay,boost,dedup,purge_stale,rebuild_vectors
    --merge-ids K:R,... For dedup: keepId:removeId pairs (e.g. 10:11,20:21:22)
    --project P         Filter by project
    --retain-days N     For purge_stale: keep last N days (default 30)

  fts-check <chk|rbld>  FTS5 index check or rebuild

  stats                 Show memory statistics
    --project P         Filter by project
    --days N            Lookback window (default 30)

  context               Show current CLAUDE.md context block

  browse                Tier-grouped memory dashboard
    --tier T            Filter: working|active|archive
    --project P         Filter by project
    --limit N           Max entries per tier (default 5)

DB: ${DB_PATH}`);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function run(argv) {
  const cmd = argv[0];
  const cmdArgs = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    cmdHelp();
    return;
  }

  let db;
  try {
    db = ensureDb();
  } catch (e) {
    out(`[mem] Error: Cannot open database: ${e.message}`);
    out(`[mem] DB path: ${DB_PATH}`);
    process.exitCode = 1;
    return;
  }

  try {
    switch (cmd) {
      case 'search':    cmdSearch(db, cmdArgs); break;
      case 'recent':    cmdRecent(db, cmdArgs); break;
      case 'recall':    cmdRecall(db, cmdArgs); break;
      case 'get':       cmdGet(db, cmdArgs); break;
      case 'timeline':  cmdTimeline(db, cmdArgs); break;
      case 'save':      cmdSave(db, cmdArgs); break;
      case 'delete':    cmdDelete(db, cmdArgs); break;
      case 'update':    cmdUpdate(db, cmdArgs); break;
      case 'export':    cmdExport(db, cmdArgs); break;
      case 'compress':  cmdCompress(db, cmdArgs); break;
      case 'maintain':  cmdMaintain(db, cmdArgs); break;
      case 'fts-check': cmdFtsCheck(db, cmdArgs); break;
      case 'stats':     cmdStats(db, cmdArgs); break;
      case 'context':   cmdContext(db, cmdArgs); break;
      case 'browse':    cmdBrowse(db, cmdArgs); break;
      default:
        out(`[mem] Unknown command: ${cmd}`);
        out('[mem] Run "claude-mem-lite help" for usage');
        process.exitCode = 1;
    }
  } finally {
    try { db.close(); } catch {}
  }
}
