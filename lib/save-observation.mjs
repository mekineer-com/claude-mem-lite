// Shared "save one observation" pipeline — used by both mem-cli.mjs::cmdSave
// (CLI `claude-mem-lite save`) and server.mjs::mem_save (MCP tool).
//
// Pre-extraction (v2.60.0) the same dedup → scrub → minhash → CJK-bigram →
// transactional INSERT block lived inline in both call sites (~110 lines × 2,
// flagged in the audit). They drifted: each carried its own `aligned with X`
// comments. This module is the single source of truth.
//
// Caller responsibilities (kept where input shape differs):
//   - validation (type whitelist, importance range, lesson length)
//   - argument parsing (CLI flags vs MCP Zod schema)
//   - result rendering (CLI stdout vs MCP content array)

import { jaccardSimilarity, scrubSecrets, computeMinHash, cjkBigrams, getCurrentBranch } from '../utils.mjs';
import { DEDUP_JACCARD_THRESHOLD } from './dedup-constants.mjs';
import { insertObservationRow, insertObservationFiles, insertObservationVector } from './observation-write.mjs';

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_RECENT_LIMIT = 50;

/**
 * Save a new observation if it isn't a near-duplicate of one saved within the
 * last 5 minutes (Jaccard similarity > 0.7 on title or content).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @param {string} params.content                 Observation body. Required.
 * @param {string} [params.title]                 Defaults to content.slice(0, 100).
 * @param {string} [params.type='discovery']      Caller validates.
 * @param {number} [params.importance=2]          Caller validates 1..3.
 * @param {string} params.project                 Resolved project key.
 * @param {string[]} [params.files=[]]            File paths to attach (junction table).
 * @param {string|null} [params.lesson_learned]   Caller validates ≤500 chars.
 * @param {Date}   [params.now]                   Override for tests.
 * @returns {{ kind: 'duplicate', existingId: number, project: string, type: string }
 *          | { kind: 'saved', id: number, type: string, project: string, title: string, lessonCaptured: boolean }}
 */
export function saveObservation(db, params) {
  const now = params.now instanceof Date ? params.now : new Date();
  const project = params.project;
  const type = params.type || 'discovery';
  const content = params.content;
  // Defensive single-source guard: never persist an empty/whitespace-only row.
  // CLI's `!text` check and MCP's `z.string().min(1)` both let whitespace-only
  // content through ("   " is length>=1 and truthy), creating junk observations
  // with blank title/text. Reject here so both call sites are covered at once.
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('mem_save: content is empty or whitespace-only');
  }
  const importance = params.importance ?? 2;
  const files = Array.isArray(params.files)
    ? params.files.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  const rawLesson = (typeof params.lesson_learned === 'string' && params.lesson_learned.length > 0)
    ? params.lesson_learned
    : null;

  // Scrub secrets BEFORE dedup so the comparison runs on the same form that
  // gets persisted (otherwise a token+placeholder pair could dedup-miss).
  const safeContent = scrubSecrets(content);
  // Derive the title from ALREADY-SCRUBBED content, then scrub again: slicing
  // raw content first could cut a secret value mid-token at the 100-char
  // boundary, leaving a head the value-length-gated scrub regex no longer
  // matches — so the title kept a partial secret while the narrative was clean.
  const rawTitle = params.title || safeContent.slice(0, 100);
  const safeTitle = scrubSecrets(rawTitle);
  const safeLesson = rawLesson ? scrubSecrets(rawLesson) : null;

  const sessionId = `manual-${project}`;

  // Ensure session exists (FK constraint). INSERT OR IGNORE makes this safe
  // under concurrent calls.
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

  // Dedup window: 5-min, top-50 most-recent in project.
  const dedupCutoff = now.getTime() - DEDUP_WINDOW_MS;
  const recent = db.prepare(`
    SELECT id, title, text FROM observations
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(project, dedupCutoff, DEDUP_RECENT_LIMIT);

  const dupMatch = recent.find((r) =>
    jaccardSimilarity(r.title, safeTitle) > DEDUP_JACCARD_THRESHOLD ||
    jaccardSimilarity(r.text || '', safeContent) > DEDUP_JACCARD_THRESHOLD
  );
  if (dupMatch) {
    return { kind: 'duplicate', existingId: dupMatch.id, project, type };
  }

  // FTS-indexed text field includes title + content + lesson + CJK bigrams,
  // so the +0.3 lesson_learned scoring multiplier actually gets to surface
  // lesson-bearing rows on FTS-matched queries.
  const minhashSig = computeMinHash(safeTitle + ' ' + safeContent);
  const indexText = [safeTitle, safeContent, safeLesson].filter(Boolean).join(' ');
  const bigramText = cjkBigrams(indexText);
  const textField = bigramText ? safeContent + ' ' + bigramText : safeContent;

  // Atomic: observation row + observation_files junction + observation_vectors
  // (TF-IDF). Vector write is best-effort — vocab may be uninitialized on a
  // fresh DB; failure must not roll back the observation.
  const saveTx = db.transaction(() => {
    // Manual-save shape: narrative=content, concepts/facts/files_read empty, no
    // subtitle/search_aliases (defaults). Column list single-sourced in lib/observation-write.
    const savedId = insertObservationRow(db, {
      memory_session_id: sessionId, project, text: textField, type, title: safeTitle,
      narrative: safeContent, files_modified: JSON.stringify(files), importance,
      minhash_sig: minhashSig, lesson_learned: safeLesson, branch: getCurrentBranch(),
      created_at: now.toISOString(), created_at_epoch: now.getTime(),
    });

    insertObservationFiles(db, savedId, files);
    insertObservationVector(db, savedId, safeTitle + ' ' + safeContent);

    return savedId;
  });
  const savedId = saveTx();

  // P4 explicit supersession: tombstone + link prior observations this save
  // overturns. Only same-project, currently-live rows are eligible — never
  // tombstone another project's memory or re-stamp an already-superseded row —
  // and never supersede the row we just wrote. superseded_at drops the row out of
  // live search (all queries filter superseded_at IS NULL); superseded_by records
  // WHICH observation replaced it (the missing link in finding #4). The column
  // already exists (schema.mjs), so no migration is required.
  let supersededIds = [];
  const requested = Array.isArray(params.supersedes) ? params.supersedes : [];
  const ids = [...new Set(
    requested.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== savedId)
  )];
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    const eligible = db.prepare(
      `SELECT id FROM observations WHERE id IN (${ph}) AND project = ? AND superseded_at IS NULL`
    ).all(...ids, project).map((r) => r.id);
    if (eligible.length > 0) {
      const ph2 = eligible.map(() => '?').join(',');
      db.prepare(`UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id IN (${ph2})`)
        .run(now.getTime(), savedId, ...eligible);
      supersededIds = eligible;
    }
  }

  return {
    kind: 'saved',
    id: savedId,
    type,
    project,
    title: safeTitle,
    lessonCaptured: Boolean(safeLesson),
    supersededIds,
  };
}
