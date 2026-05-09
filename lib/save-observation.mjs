// Shared "save one observation" pipeline — used by both mem-cli.mjs::cmdSave
// (CLI `mem save`) and server.mjs::mem_save (MCP tool).
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

import { jaccardSimilarity, scrubSecrets, computeMinHash, cjkBigrams, getCurrentBranch, debugCatch } from '../utils.mjs';
import { getVocabulary, computeVector } from '../tfidf.mjs';

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_RECENT_LIMIT = 50;
const DEDUP_JACCARD_THRESHOLD = 0.7;

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
  const rawTitle = params.title || content.slice(0, 100);
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
    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, lesson_learned, branch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, project, textField, type, safeTitle, safeContent,
      JSON.stringify(files), importance, minhashSig, safeLesson, getCurrentBranch(),
      now.toISOString(), now.getTime()
    );
    const savedId = Number(result.lastInsertRowid);

    if (savedId && files.length > 0) {
      const insertFile = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
      for (const f of files) insertFile.run(savedId, f);
    }

    try {
      const vocab = getVocabulary(db);
      if (vocab) {
        const vec = computeVector(safeTitle + ' ' + safeContent, vocab);
        if (vec) {
          db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
            .run(savedId, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
    } catch (e) { debugCatch(e, 'save-observation-vector'); }

    return savedId;
  });
  const savedId = saveTx();

  return {
    kind: 'saved',
    id: savedId,
    type,
    project,
    title: safeTitle,
    lessonCaptured: Boolean(safeLesson),
  };
}
