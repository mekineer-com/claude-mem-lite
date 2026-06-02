// Build a fresh per-arm memory DB. Seeding goes through the production
// saveObservation pipeline (dedup → scrub → minhash → TF-IDF vector → FTS), so a
// seeded memory is indexed EXACTLY like one captured in real use — otherwise the
// treatment arm would test retrieval of a differently-shaped row than production.

import Database from 'better-sqlite3';
import { initSchema } from '../../schema.mjs';
import { saveObservation } from '../../lib/save-observation.mjs';

function openFresh(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF'); // initSchema restores ON before returning (v2.87.0)
  return initSchema(db);
}

function insertMemory(db, mem, project) {
  saveObservation(db, {
    content: mem.content,
    title: mem.title,
    type: mem.type || 'discovery',
    importance: mem.importance ?? 2,
    project,
    files: mem.files || [],
    lesson_learned: mem.lesson_learned ?? null,
  });
}

/**
 * Create the DB at `dbPath` for `arm` and seed it. Returns { seeded } = number
 * of observations written. The control arm writes nothing (its runs have no
 * injection); treatment writes the task's captured memory; shuffled writes the
 * provided irrelevant pool.
 */
export function seedArmDb(dbPath, arm, task, { shuffledPool = [] } = {}) {
  if (arm.seed === 'none') return { seeded: 0 };
  const db = openFresh(dbPath);
  try {
    if (arm.seed === 'captured') {
      insertMemory(db, task.capturedMemory, task.project);
      return { seeded: 1 };
    }
    if (arm.seed === 'shuffled') {
      for (const mem of shuffledPool) insertMemory(db, mem, task.project);
      return { seeded: shuffledPool.length };
    }
    return { seeded: 0 };
  } finally {
    db.close();
  }
}
