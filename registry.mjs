// claude-mem-lite: Resource registry database schema and CRUD operations
// Independent from schema.mjs (memory DB) — uses separate resource-registry.db

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { debugCatch } from './utils.mjs';

// ─── Schema ──────────────────────────────────────────────────────────────────

const RESOURCES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS resources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('skill','agent')),
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','disabled','error','indexing')),
    source        TEXT NOT NULL CHECK(source IN ('preinstalled','user')),
    repo_url      TEXT,
    repo_stars    INTEGER DEFAULT 0,
    local_path    TEXT NOT NULL,
    file_hash     TEXT,
    parent_plugin TEXT,
    invocation_name   TEXT DEFAULT '',
    intent_tags       TEXT DEFAULT '',
    domain_tags       TEXT DEFAULT '',
    action_type       TEXT DEFAULT '',
    trigger_patterns  TEXT DEFAULT '',
    capability_summary TEXT DEFAULT '',
    input_type    TEXT DEFAULT '',
    output_type   TEXT DEFAULT '',
    prerequisites TEXT DEFAULT '{}',
    keywords      TEXT DEFAULT '',
    tech_stack    TEXT DEFAULT '',
    use_cases     TEXT DEFAULT '',
    complexity    TEXT DEFAULT 'intermediate',
    recommend_count   INTEGER DEFAULT 0,
    adopt_count       INTEGER DEFAULT 0,
    success_count     INTEGER DEFAULT 0,
    indexed_at    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_res_type_name
    ON resources(type, name);

  CREATE INDEX IF NOT EXISTS idx_res_status
    ON resources(status) WHERE status = 'active';
`;

// Canonical FTS5 column order — all consumers must use this order.
// BM25 weights (positional): trigger_patterns(5), keywords(3), capability_summary(3),
//   intent_tags(2), use_cases(2), domain_tags(1), tech_stack(1), name(1)
const FTS5_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS resources_fts USING fts5(
    trigger_patterns,
    keywords,
    capability_summary,
    intent_tags,
    use_cases,
    domain_tags,
    tech_stack,
    name,
    content=resources,
    content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
  );
`;

const TRIGGERS_SCHEMA = `
  CREATE TRIGGER IF NOT EXISTS res_fts_insert AFTER INSERT ON resources BEGIN
    INSERT INTO resources_fts(rowid, trigger_patterns, keywords, capability_summary,
      intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES (NEW.id, NEW.trigger_patterns, NEW.keywords, NEW.capability_summary,
      NEW.intent_tags, NEW.use_cases, NEW.domain_tags, NEW.tech_stack, NEW.name);
  END;

  CREATE TRIGGER IF NOT EXISTS res_fts_update AFTER UPDATE ON resources BEGIN
    INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, keywords,
      capability_summary, intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.keywords, OLD.capability_summary,
      OLD.intent_tags, OLD.use_cases, OLD.domain_tags, OLD.tech_stack, OLD.name);
    INSERT INTO resources_fts(rowid, trigger_patterns, keywords, capability_summary,
      intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES (NEW.id, NEW.trigger_patterns, NEW.keywords, NEW.capability_summary,
      NEW.intent_tags, NEW.use_cases, NEW.domain_tags, NEW.tech_stack, NEW.name);
  END;

  CREATE TRIGGER IF NOT EXISTS res_fts_delete AFTER DELETE ON resources BEGIN
    INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, keywords,
      capability_summary, intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.keywords, OLD.capability_summary,
      OLD.intent_tags, OLD.use_cases, OLD.domain_tags, OLD.tech_stack, OLD.name);
  END;
`;

const INVOCATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS invocations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id   INTEGER NOT NULL REFERENCES resources(id),
    session_id    TEXT,
    trigger       TEXT CHECK(trigger IN ('session_start','pre_tool_use','user_explicit','user_prompt')),
    tier          INTEGER CHECK(tier IN (1,2,3)),
    recommended   INTEGER DEFAULT 1,
    adopted       INTEGER DEFAULT 0,
    outcome       TEXT CHECK(outcome IN ('success','partial','failure','skipped','ignored') OR outcome IS NULL),
    score         REAL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inv_resource
    ON invocations(resource_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_inv_session
    ON invocations(session_id);
`;

const PREINSTALLED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS preinstalled (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('skill','agent')),
    repo_url      TEXT NOT NULL,
    repo_path     TEXT DEFAULT '',
    stars         INTEGER DEFAULT 0,
    tags          TEXT DEFAULT '[]',
    enabled       INTEGER DEFAULT 1,
    cloned_at     TEXT,
    clone_hash    TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_type_name
    ON preinstalled(type, name);
`;

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize registry database with all tables and FTS5.
 * Idempotent — safe to call multiple times.
 * @param {string} dbPath Path to resource-registry.db
 * @returns {Database} Opened database instance
 */
export function ensureRegistryDb(dbPath) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(RESOURCES_SCHEMA);

  // Migrate: add invocation_name column if missing (safe for existing DBs)
  try {
    const cols = db.prepare("PRAGMA table_info(resources)").all();
    if (!cols.some(c => c.name === 'invocation_name')) {
      db.exec("ALTER TABLE resources ADD COLUMN invocation_name TEXT DEFAULT ''");
    }
  } catch (e) { debugCatch(e, 'invocation_name-migration'); }

  // FTS5 + triggers: only create if not exists
  const hasFts = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='resources_fts'`).get();
  if (!hasFts) {
    db.exec(FTS5_SCHEMA);
    db.exec(TRIGGERS_SCHEMA);
  }

  db.exec(INVOCATIONS_SCHEMA);

  // Migrate invocations CHECK constraint: add 'user_prompt' trigger value
  // SQLite cannot ALTER CHECK constraints, so recreate table if needed
  try {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invocations'`).get();
    if (schema?.sql && !schema.sql.includes('user_prompt')) {
      db.transaction(() => {
        // Clean up leftover from previous failed migration attempt
        const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='invocations_old'`).get();
        if (hasOld) db.exec(`DROP TABLE invocations_old`);
        db.exec(`ALTER TABLE invocations RENAME TO invocations_old`);
        db.exec(INVOCATIONS_SCHEMA);
        db.exec(`INSERT INTO invocations
          (id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
          SELECT id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at
          FROM invocations_old`);
        db.exec(`DROP TABLE invocations_old`);
      })();
    }
  } catch (e) { debugCatch(e, 'ensureRegistryDb-migration'); }

  // Migrate invocations CHECK constraint: add 'ignored' outcome value
  try {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invocations'`).get();
    if (schema?.sql && !schema.sql.includes("'ignored'")) {
      db.transaction(() => {
        const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='invocations_old'`).get();
        if (hasOld) db.exec(`DROP TABLE invocations_old`);
        db.exec(`ALTER TABLE invocations RENAME TO invocations_old`);
        db.exec(INVOCATIONS_SCHEMA);
        db.exec(`INSERT INTO invocations
          (id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
          SELECT id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at
          FROM invocations_old`);
        db.exec(`DROP TABLE invocations_old`);
      })();
    }
  } catch (e) { debugCatch(e, 'ensureRegistryDb-ignored-migration'); }

  db.exec(PREINSTALLED_SCHEMA);

  return db;
}

// ─── Exported Schema (for test-helpers.mjs) ─────────────────────────────────

export { RESOURCES_SCHEMA, FTS5_SCHEMA, TRIGGERS_SCHEMA, INVOCATIONS_SCHEMA, PREINSTALLED_SCHEMA };

// ─── Resource CRUD ───────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO resources (name, type, status, source, repo_url, repo_stars, local_path, file_hash,
    invocation_name, intent_tags, domain_tags, action_type, trigger_patterns, capability_summary,
    input_type, output_type, prerequisites, keywords, tech_stack, use_cases, complexity,
    indexed_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(type, name) DO UPDATE SET
    status=excluded.status, source=excluded.source, repo_url=excluded.repo_url,
    repo_stars=excluded.repo_stars, local_path=excluded.local_path, file_hash=excluded.file_hash,
    invocation_name=CASE WHEN excluded.invocation_name != '' THEN excluded.invocation_name ELSE invocation_name END,
    intent_tags=excluded.intent_tags, domain_tags=excluded.domain_tags,
    action_type=excluded.action_type, trigger_patterns=excluded.trigger_patterns,
    capability_summary=excluded.capability_summary, input_type=excluded.input_type,
    output_type=excluded.output_type, prerequisites=excluded.prerequisites,
    keywords=excluded.keywords, tech_stack=excluded.tech_stack,
    use_cases=excluded.use_cases, complexity=excluded.complexity,
    indexed_at=excluded.indexed_at, updated_at=datetime('now')
`;

/**
 * Insert or update a resource. Idempotent via UPSERT on (type, name).
 * @param {Database} db Registry database
 * @param {object} r Resource object
 * @returns {number} Resource ID
 */
export function upsertResource(db, r) {
  return db.transaction(() => {
    db.prepare(UPSERT_SQL).run(
      r.name, r.type, r.status || 'active', r.source || 'preinstalled',
      r.repo_url || null, r.repo_stars || 0, r.local_path,
      r.file_hash || null, r.invocation_name || '',
      r.intent_tags || '', r.domain_tags || '',
      r.action_type || '', r.trigger_patterns || '', r.capability_summary || '',
      r.input_type || '', r.output_type || '', r.prerequisites || '{}',
      r.keywords || '', r.tech_stack || '', r.use_cases || '', r.complexity || 'intermediate',
      r.indexed_at || null
    );
    const row = db.prepare('SELECT id FROM resources WHERE type = ? AND name = ?').get(r.type, r.name);
    return row?.id || 0;
  })();
}

/**
 * Get all active resources.
 * @param {Database} db Registry database
 * @returns {object[]} Array of resource objects
 */
export function getActiveResources(db) {
  return db.prepare('SELECT * FROM resources WHERE status = ? ORDER BY name').all('active');
}

/**
 * Get a resource by type and name.
 * @param {Database} db Registry database
 * @param {string} type 'skill' or 'agent'
 * @param {string} name Resource name
 * @returns {object|undefined} Resource or undefined
 */
export function getResourceByName(db, type, name) {
  return db.prepare('SELECT * FROM resources WHERE type = ? AND name = ?').get(type, name);
}

/**
 * Get a resource by ID.
 * @param {Database} db Registry database
 * @param {number} id Resource ID
 * @returns {object|undefined} Resource or undefined
 */
export function getResourceById(db, id) {
  return db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
}

/**
 * Atomically increment a stats field on a resource.
 * @param {Database} db Registry database
 * @param {number} id Resource ID
 * @param {'recommend_count'|'adopt_count'|'success_count'} field Stats field
 */
export function updateResourceStats(db, id, field) {
  const allowed = new Set(['recommend_count', 'adopt_count', 'success_count']);
  if (!allowed.has(field)) throw new Error(`Invalid stats field: ${field}`);
  // String interpolation required: SQLite cannot parameterize column names.
  // Safety: field is validated against allowlist above.
  db.prepare(`UPDATE resources SET ${field} = ${field} + 1, updated_at = datetime('now') WHERE id = ?`).run(id);
}

/**
 * Record a dispatch invocation.
 * @param {Database} db Registry database
 * @param {object} record Invocation record
 * @returns {number} Invocation ID
 */
export function recordInvocation(db, record) {
  const result = db.prepare(`
    INSERT INTO invocations (resource_id, session_id, trigger, tier, recommended, adopted, outcome, score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.resource_id, record.session_id || null,
    record.trigger || null, record.tier || null,
    record.recommended ?? 1, record.adopted ?? 0,
    record.outcome || null, record.score ?? null
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get success rates for resources over a time period.
 * @param {Database} db Registry database
 * @param {number} [days=30] Lookback period
 * @returns {object[]} Array of {resource_id, total, adopted, avg_score}
 */
export function getResourceSuccessRates(db, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare(`
    SELECT resource_id,
      COUNT(*) as total,
      SUM(adopted) as adopted,
      AVG(CASE WHEN score IS NOT NULL THEN score END) as avg_score
    FROM invocations
    WHERE created_at > ?
    GROUP BY resource_id
  `).all(since);
}

/**
 * Get invocations for a specific session (for feedback collection).
 * @param {Database} db Registry database
 * @param {string} sessionId Session identifier
 * @returns {object[]} Array of invocation records
 */
export function getSessionInvocations(db, sessionId) {
  return db.prepare(`
    SELECT i.*, r.name as resource_name, r.type as resource_type,
           r.invocation_name as invocation_name
    FROM invocations i
    JOIN resources r ON r.id = i.resource_id
    WHERE i.session_id = ?
    ORDER BY i.created_at
  `).all(sessionId);
}

/**
 * Update invocation outcome (for feedback).
 * @param {Database} db Registry database
 * @param {number} id Invocation ID
 * @param {object} update Fields to update
 */
export function updateInvocation(db, id, update) {
  const allowed = new Set(['adopted', 'outcome', 'score']);
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(update)) {
    if (val === undefined) continue;
    if (!allowed.has(key)) throw new Error(`Invalid invocation field: ${key}`);
    sets.push(`${key} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) return;
  vals.push(id);
  // String interpolation required: SQLite cannot parameterize column names.
  // Safety: column names are validated against allowlist above.
  db.prepare(`UPDATE invocations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}
