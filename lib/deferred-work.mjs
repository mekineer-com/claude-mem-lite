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
  // source_session_id / source_prompt_id: forward-compat for v2.71+ defer-detector
  // hook (anchor a deferred item to the originating prompt). v1 inserts NULL.
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

/**
 * Resolve mixed ordinal (int) + raw-id ("D#<n>") tokens to real deferred_work
 * ids, validated against caller project + status='open'.
 *
 * - bare integer N → ordinal-within-project (uses same ROW_NUMBER as listOpenWithOrdinal)
 * - "D#<n>" string → raw deferred_work.id; must belong to caller project AND be open
 *
 * @param {Database} db
 * @param {string} project Caller project (FK guard)
 * @param {Array<number|string>} tokens Mixed input
 * @returns {number[]} Real deferred_work ids in input order
 * @throws {Error} On unresolvable input — error message names the offending token
 */
export function resolveDeferredIds(db, project, tokens) {
  if (!Array.isArray(tokens)) throw new Error('tokens must be an array');
  // Pre-load open list once for ordinal resolution (ROW_NUMBER snapshot stable
  // within this call so [1, 2] resolves consistently).
  const open = db.prepare(`
    SELECT id, ROW_NUMBER() OVER (ORDER BY priority DESC, created_at_epoch ASC) AS ordinal
    FROM deferred_work
    WHERE project = ? AND status = 'open'
  `).all(project);
  const ordinalToId = new Map(open.map(r => [r.ordinal, r.id]));

  const getRow = db.prepare(`SELECT id, project, status FROM deferred_work WHERE id = ?`);
  const seen = new Set();
  const resolved = [];

  for (const t of tokens) {
    let id;
    if (Number.isInteger(t)) {
      id = ordinalToId.get(t);
      if (id === undefined) {
        throw new Error(`ordinal ${t} has no corresponding open deferred item in project "${project}" (open count: ${open.length})`);
      }
    } else if (typeof t === 'string') {
      const m = /^D#(\d+)$/.exec(t.trim());
      if (!m) throw new Error(`invalid token "${t}" — expected D#N or integer ordinal`);
      id = parseInt(m[1], 10);
      const row = getRow.get(id);
      if (!row) throw new Error(`D#${id} not found`);
      if (row.project !== project) {
        throw new Error(`D#${id} belongs to project "${row.project}", not "${project}"`);
      }
      if (row.status !== 'open') {
        // Verb-neutral: resolveDeferredIds is shared by close (save --closes-deferred)
        // AND drop (mem_defer_drop), so "cannot close" mis-described the drop path.
        throw new Error(`D#${id} status is "${row.status}" — only 'open' items can be closed or dropped`);
      }
    } else {
      throw new Error(`invalid token type ${typeof t} — expected D#N or integer ordinal`);
    }
    if (seen.has(id)) throw new Error(`duplicate token resolves to id ${id}`);
    seen.add(id);
    resolved.push(id);
  }
  return resolved;
}

/**
 * Close a set of deferred items by id, all-or-nothing.
 *
 * Wraps the UPDATE loop in an internal transaction so that any per-row failure
 * rolls back prior rows. better-sqlite3's `.transaction()` composes with an
 * outer caller-managed transaction via SAVEPOINT — Task 5's wider closure flow
 * (obs INSERT + closeDeferredItems) wraps both calls in one outer transaction
 * to guarantee atomicity across the obs row and the deferred-work UPDATEs.
 *
 * @param {Database} db
 * @param {number[]} ids Already-resolved real ids (use resolveDeferredIds first)
 * @param {number} closingObsId observations.id that proves closure
 * @throws {Error} If any id is not currently open (lookup-based safety net)
 */
export function closeDeferredItems(db, ids, closingObsId) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (!Number.isInteger(closingObsId) || closingObsId <= 0) {
    throw new Error('closingObsId must be a positive integer');
  }
  // Defense-in-depth: even if caller already validated via resolveDeferredIds,
  // re-check status here (caller may have done resolution earlier in the same
  // transaction without holding a lock).
  const stmt = db.prepare(`
    UPDATE deferred_work
    SET status='done', closed_at_epoch=?, closed_by_obs_id=?
    WHERE id=? AND status='open'
  `);
  const now = Date.now();
  const tx = db.transaction((idList) => {
    for (const id of idList) {
      const r = stmt.run(now, closingObsId, id);
      if (r.changes !== 1) {
        throw new Error(`closeDeferredItems: id ${id} was not in 'open' status (changes=${r.changes})`);
      }
    }
  });
  tx(ids);
}
