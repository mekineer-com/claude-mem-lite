// claude-mem-lite — deferred_work data layer
// Pure-data CRUD + ordinal resolver + transactional closure helper.
// Decoupled from observations table: different lifecycle, different scoring.

/**
 * Insert a new open deferred_work row.
 * @param {Database} db Opened DB
 * @param {object} args
 * @param {string} args.project Required project name
 * @param {string} args.title Required one-line subject
 * @param {number} [args.priority=2] 1=low, 2=normal, 3=urgent
 * @param {string} [args.detail] Optional longer description
 * @param {string[]} [args.files] Optional file paths
 * @param {string} [args.source_session_id] Mem session id
 * @param {number} [args.source_prompt_id] user_prompts.id
 * @returns {{id: number}} Inserted row id
 */
export function insertDeferred(db, args) {
  const { project, title, priority = 2, detail = null, files = null,
          source_session_id = null, source_prompt_id = null } = args;
  if (!project || typeof project !== 'string') throw new Error('project required');
  if (!title || typeof title !== 'string') throw new Error('title required');
  if (![1, 2, 3].includes(priority)) throw new Error('priority must be 1, 2, or 3');
  const stmt = db.prepare(`
    INSERT INTO deferred_work
      (project, title, detail, priority, status, created_at_epoch,
       source_session_id, source_prompt_id, files)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `);
  const r = stmt.run(
    project, title, detail, priority, Date.now(),
    source_session_id, source_prompt_id,
    files ? JSON.stringify(files) : null,
  );
  return { id: Number(r.lastInsertRowid) };
}

/**
 * List open items in a project with computed per-project ordinal.
 * Ordinal is dynamic — recomputed each call by ROW_NUMBER over open rows
 * sorted (priority DESC, created_at_epoch ASC). When item-1 closes, item-2
 * becomes the new item-1.
 * @param {Database} db
 * @param {string} project
 * @param {number} [limit=10]
 * @returns {Array<{id, project, title, detail, priority, status, created_at_epoch, ordinal}>}
 */
export function listOpenWithOrdinal(db, project, limit = 10) {
  return db.prepare(`
    SELECT id, project, title, detail, priority, status, created_at_epoch,
           ROW_NUMBER() OVER (ORDER BY priority DESC, created_at_epoch ASC) AS ordinal
    FROM deferred_work
    WHERE project = ? AND status = 'open'
    ORDER BY priority DESC, created_at_epoch ASC
    LIMIT ?
  `).all(project, limit);
}

/**
 * Set status='dropped' with a non-empty reason. No-op when status is not 'open'.
 * @returns {{changed: number}} 1 if updated, 0 if not found or not open.
 */
export function dropDeferred(db, id, reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('drop reason required (non-empty string)');
  }
  const r = db.prepare(`
    UPDATE deferred_work
    SET status='dropped', closed_at_epoch=?, drop_reason=?
    WHERE id=? AND status='open'
  `).run(Date.now(), reason.trim(), id);
  return { changed: r.changes };
}
