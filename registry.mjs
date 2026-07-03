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
    source        TEXT NOT NULL CHECK(source IN ('preinstalled','user','github')),
    repo_url      TEXT,
    repo_stars    INTEGER DEFAULT 0,
    local_path    TEXT NOT NULL,
    file_hash     TEXT,
    parent_plugin TEXT,          -- unused, kept for schema compat
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
    category          TEXT,
    quality_tier      TEXT DEFAULT 'community',
    popularity_score  REAL DEFAULT 0,
    personal_score    REAL DEFAULT 0,
    recommend_count   INTEGER DEFAULT 0,
    adopt_count       INTEGER DEFAULT 0,
    weighted_adopt_sum REAL DEFAULT 0,
    success_count     INTEGER DEFAULT 0,
    silenced_until TEXT,
    cooldown_hours    INTEGER DEFAULT 0,
    recommendation_mode TEXT DEFAULT 'proactive',
    indexed_at    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    enrichment_status TEXT DEFAULT NULL,
    enriched_at INTEGER DEFAULT NULL,
    repo_updated_at TEXT DEFAULT NULL,
    repo_forks INTEGER DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_res_type_name
    ON resources(type, name);

  CREATE INDEX IF NOT EXISTS idx_res_status
    ON resources(status) WHERE status = 'active';
`;

// Canonical FTS5 column order — all consumers must use this order.
// BM25 weights (positional): trigger_patterns(3), keywords(3), capability_summary(3),
//   intent_tags(2), use_cases(2), domain_tags(1), tech_stack(1), name(1)
//   — must match the bm25(resources_fts, 3,3,3,2,2,1,1,1) call in COMPOSITE_EXPR.
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
    resource_id   INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    session_id    TEXT,
    trigger       TEXT CHECK(trigger IN ('session_start','pre_tool_use','user_explicit','user_prompt')),
    tier          INTEGER CHECK(tier IN (1,2,3)),
    recommended   INTEGER DEFAULT 1,
    adopted       INTEGER DEFAULT 0,
    outcome       TEXT CHECK(outcome IN ('success','partial','failure','skipped','ignored') OR outcome IS NULL),
    score         REAL,
    rejection_reason TEXT CHECK(rejection_reason IN ('alternative','manual','context_switch','session_end','unknown','no_events','unclassified') OR rejection_reason IS NULL),
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inv_resource
    ON invocations(resource_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_inv_session
    ON invocations(session_id);

  CREATE INDEX IF NOT EXISTS idx_inv_created_at
    ON invocations(created_at);
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
  // 5000ms to match the main DB: registry writes (install indexing rewriting
  // resources + resources_fts) race shadow-recommend writes + mem_registry reads
  // on the same file; 3000ms was insufficient under that concurrency (schema.mjs).
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(RESOURCES_SCHEMA);

  // Migrate: add missing columns to resources (single PRAGMA call for all)
  try {
    const resCols = new Set(db.prepare("PRAGMA table_info(resources)").all().map(c => c.name));
    if (!resCols.has('invocation_name')) db.exec("ALTER TABLE resources ADD COLUMN invocation_name TEXT DEFAULT ''");
    if (!resCols.has('silenced_until')) db.exec("ALTER TABLE resources ADD COLUMN silenced_until TEXT");
    if (!resCols.has('cooldown_hours')) db.exec("ALTER TABLE resources ADD COLUMN cooldown_hours INTEGER DEFAULT 0");
    // recommendation_mode: 'proactive' (default, actively recommended), 'on_request' (only when explicitly asked)
    if (!resCols.has('recommendation_mode')) db.exec("ALTER TABLE resources ADD COLUMN recommendation_mode TEXT DEFAULT 'proactive'");
    // weighted_adopt_sum: continuous adoption score accumulator (vs binary adopt_count)
    if (!resCols.has('weighted_adopt_sum')) db.exec("ALTER TABLE resources ADD COLUMN weighted_adopt_sum REAL DEFAULT 0");
    // Phase 2: Registry optimization columns
    if (!resCols.has('category')) db.exec("ALTER TABLE resources ADD COLUMN category TEXT");
    if (!resCols.has('quality_tier')) db.exec("ALTER TABLE resources ADD COLUMN quality_tier TEXT DEFAULT 'community'");
    if (!resCols.has('popularity_score')) db.exec("ALTER TABLE resources ADD COLUMN popularity_score REAL DEFAULT 0");
    if (!resCols.has('personal_score')) db.exec("ALTER TABLE resources ADD COLUMN personal_score REAL DEFAULT 0");
    if (!resCols.has('enrichment_status')) db.exec("ALTER TABLE resources ADD COLUMN enrichment_status TEXT DEFAULT NULL");
    if (!resCols.has('enriched_at')) db.exec("ALTER TABLE resources ADD COLUMN enriched_at INTEGER DEFAULT NULL");
    if (!resCols.has('repo_updated_at')) db.exec("ALTER TABLE resources ADD COLUMN repo_updated_at TEXT DEFAULT NULL");
    if (!resCols.has('repo_forks')) db.exec("ALTER TABLE resources ADD COLUMN repo_forks INTEGER DEFAULT 0");
    // Auto-set quality_tier for installed preinstalled resources
    db.exec("UPDATE resources SET quality_tier = 'installed' WHERE source = 'preinstalled' AND quality_tier = 'community'");
  } catch (e) { debugCatch(e, 'resources-column-migration'); }

  // Migrate: add 'github' to source CHECK constraint (required for smart import)
  // Must disable FK checks during table recreation (RENAME triggers FK validation).
  // legacy_alter_table=ON is REQUIRED: under modern SQLite (the better-sqlite3
  // default) `ALTER TABLE resources RENAME TO resources_old` rewrites child-table FK
  // references, so invocations.resource_id would become `REFERENCES resources_old`
  // and the trailing DROP would leave it dangling — silently killing every future
  // `INSERT INTO invocations` (audit P0 #1). Legacy mode keeps child FKs pointing at
  // the original name, which the freshly-created `resources` table then satisfies.
  let resourcesRebuilt = false;
  try {
    const resSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='resources'`).get();
    if (resSchema?.sql && !resSchema.sql.includes("'github'")) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(() => {
          const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='resources_old'`).get();
          if (hasOld) db.exec(`DROP TABLE resources_old`);
          // Drop FTS triggers first (reference resources table)
          db.exec(`DROP TRIGGER IF EXISTS res_fts_insert`);
          db.exec(`DROP TRIGGER IF EXISTS res_fts_update`);
          db.exec(`DROP TRIGGER IF EXISTS res_fts_delete`);
          db.exec(`ALTER TABLE resources RENAME TO resources_old`);
          db.exec(RESOURCES_SCHEMA);
          // Copy all existing data
          const cols = db.prepare("PRAGMA table_info(resources_old)").all().map(c => c.name);
          const newCols = new Set(db.prepare("PRAGMA table_info(resources)").all().map(c => c.name));
          const common = cols.filter(c => newCols.has(c)).join(', ');
          db.exec(`INSERT INTO resources (${common}) SELECT ${common} FROM resources_old`);
          db.exec(`DROP TABLE resources_old`);
          // Recreate the table's indexes: the CREATE INDEX IF NOT EXISTS inside
          // RESOURCES_SCHEMA above was SKIPPED while resources_old still held the
          // index names, so the rebuilt table had NONE — including the UNIQUE
          // idx_res_type_name that upsertResource's ON CONFLICT(type,name) requires
          // (review HIGH-1; pre-existing, closed here). Names are free post-DROP.
          db.exec(RESOURCES_SCHEMA);
        })();
      } finally {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
      }
      resourcesRebuilt = true;
    }
  } catch (e) { debugCatch(e, 'resources-source-check-migration'); }

  // FTS5: create if not exists
  const hasFts = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='resources_fts'`).get();
  if (!hasFts) {
    db.exec(FTS5_SCHEMA);
  }
  // Triggers: always ensure (IF NOT EXISTS) — fixes DBs where FTS5 was created without triggers
  db.exec(TRIGGERS_SCHEMA);

  // The source-CHECK migration replaced the `resources` content table out from under
  // the external-content FTS index (content=resources), leaving resources_fts stale.
  // Rebuild it so a later DELETE's res_fts_delete trigger doesn't throw "database disk
  // image is malformed" against the mismatched index. Gated on the migration actually
  // having run so we don't rebuild on every open.
  if (resourcesRebuilt) {
    try { db.exec("INSERT INTO resources_fts(resources_fts) VALUES('rebuild')"); }
    catch (e) { debugCatch(e, 'resources-fts-rebuild-after-source-check'); }
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
        // Omit rejection_reason — column may not exist yet on old DBs; ADD COLUMN migration below handles it
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
        // Omit rejection_reason — column may not exist yet on old DBs; ADD COLUMN migration below handles it
        db.exec(`INSERT INTO invocations
          (id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
          SELECT id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at
          FROM invocations_old`);
        db.exec(`DROP TABLE invocations_old`);
      })();
    }
  } catch (e) { debugCatch(e, 'ensureRegistryDb-ignored-migration'); }

  // Migrate: add rejection_reason column if missing
  try {
    const cols = db.prepare("PRAGMA table_info(invocations)").all();
    if (!cols.some(c => c.name === 'rejection_reason')) {
      db.exec("ALTER TABLE invocations ADD COLUMN rejection_reason TEXT");
    }
  } catch (e) { debugCatch(e, 'rejection_reason-migration'); }

  // Migrate: add ON DELETE CASCADE to invocations.resource_id (audit P0 #4). Old DBs
  // declared the FK with no ON DELETE action, so deleting a resource that had
  // invocation history threw SQLITE_CONSTRAINT_FOREIGNKEY (registry remove /
  // mem_registry delete) or silently no-op'd (dead-repo purge). SQLite can't ALTER an
  // FK, so rebuild the table. Renaming the CHILD table is safe (nothing references
  // invocations), so legacy_alter_table is not a concern here. Runs after the
  // rejection_reason ADD COLUMN so the column exists in both old and new tables.
  try {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invocations'`).get();
    if (schema?.sql && !/ON DELETE CASCADE/i.test(schema.sql)) {
      db.transaction(() => {
        const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='invocations_old'`).get();
        if (hasOld) db.exec(`DROP TABLE invocations_old`);
        db.exec(`ALTER TABLE invocations RENAME TO invocations_old`);
        db.exec(INVOCATIONS_SCHEMA);
        // Omit rejection_reason from the copy (matching the CHECK migrations above):
        // it was historically a bare TEXT with NO CHECK, so an old row could hold a
        // value outside INVOCATIONS_SCHEMA's current rejection_reason CHECK whitelist.
        // Copying it would throw SQLITE_CONSTRAINT_CHECK → rollback → the FK is left
        // un-cascaded forever and every retry re-fails (review HIGH-2). The column is
        // never written at runtime, so copied rows get NULL — no data loss.
        db.exec(`INSERT INTO invocations
          (id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
          SELECT id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at
          FROM invocations_old`);
        db.exec(`DROP TABLE invocations_old`);
        // Recreate the table's indexes — the INVOCATIONS_SCHEMA CREATE INDEX above was
        // skipped while invocations_old held the names (review HIGH-1). Free post-DROP.
        db.exec(INVOCATIONS_SCHEMA);
      })();
    }
  } catch (e) { debugCatch(e, 'invocations-ondelete-cascade-migration'); }

  // (Removed the separate idx_invocations_resource_created migration — it was a column-
  // identical duplicate of idx_inv_resource (resource_id, created_at) in INVOCATIONS_SCHEMA.
  // It only ever survived because the rebuild migrations dropped idx_inv_resource; now that
  // the rebuilds recreate their indexes (review HIGH-1), the duplicate is pure dead weight.
  // Pre-existing DBs keep their old idx_invocations_resource_created; it's harmless.)

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
    repo_stars=CASE WHEN excluded.repo_stars > 0 THEN excluded.repo_stars ELSE repo_stars END,
    local_path=excluded.local_path, file_hash=excluded.file_hash,
    invocation_name=CASE WHEN excluded.invocation_name != '' THEN excluded.invocation_name ELSE invocation_name END,
    -- Preserve-on-empty (mirror repo_stars/invocation_name above): a PARTIAL re-upsert --
    -- e.g. "registry import --name X --capability-summary ...", where mem-cli defaults every
    -- other flag to '' -- must NOT blank the FTS text columns and silently drop the resource
    -- out of search (import is the ONLY registry edit path; there is no update subcommand).
    -- Full upserts are unaffected: every field is non-empty, so the CASE picks excluded.
    intent_tags=CASE WHEN excluded.intent_tags != '' THEN excluded.intent_tags ELSE intent_tags END,
    domain_tags=CASE WHEN excluded.domain_tags != '' THEN excluded.domain_tags ELSE domain_tags END,
    action_type=CASE WHEN excluded.action_type != '' THEN excluded.action_type ELSE action_type END,
    trigger_patterns=CASE WHEN excluded.trigger_patterns != '' THEN excluded.trigger_patterns ELSE trigger_patterns END,
    capability_summary=CASE WHEN excluded.capability_summary != '' THEN excluded.capability_summary ELSE capability_summary END,
    input_type=CASE WHEN excluded.input_type != '' THEN excluded.input_type ELSE input_type END,
    output_type=CASE WHEN excluded.output_type != '' THEN excluded.output_type ELSE output_type END,
    prerequisites=excluded.prerequisites,
    keywords=CASE WHEN excluded.keywords != '' THEN excluded.keywords ELSE keywords END,
    tech_stack=CASE WHEN excluded.tech_stack != '' THEN excluded.tech_stack ELSE tech_stack END,
    use_cases=CASE WHEN excluded.use_cases != '' THEN excluded.use_cases ELSE use_cases END,
    complexity=excluded.complexity,
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
