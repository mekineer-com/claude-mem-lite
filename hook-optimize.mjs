// claude-mem-lite: LLM-powered database optimization
// Background worker for intelligent maintenance: re-enrich, normalize, cluster-merge, smart-compress
// Triggered from auto-maintain (24h) or manually via mem_optimize MCP tool / CLI

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  truncate, debugLog, debugCatch, COMPRESSED_AUTO,
  computeMinHash, clampImportance, cjkBigrams,
} from './utils.mjs';
import { callModelJSON } from './haiku-client.mjs';
import { acquireLLMSlot, releaseLLMSlot } from './hook-semaphore.mjs';
import { getVocabulary, computeVector } from './tfidf.mjs';
import { DB_DIR } from './schema.mjs';

const RUNTIME_DIR = join(DB_DIR, 'runtime');

// ─── Budget ─────────────────────────────────────────────────────────────────

export function distributeBudget(total = 15) {
  return {
    reenrich: Math.ceil(total * 0.4),
    normalize: 1,
    clusterMerge: Math.ceil(total * 0.3),
    smartCompress: Math.max(1, total - Math.ceil(total * 0.4) - 1 - Math.ceil(total * 0.3)),
  };
}

// ─── Task 1: Re-enrich ─────────────────────────────────────────────────────

export function findReenrichCandidates(db, limit = 10) {
  return db.prepare(`
    SELECT id, title, narrative, type, subtitle
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND (concepts IS NULL OR concepts = '')
      AND (facts IS NULL OR facts = '')
      AND lesson_learned IS NULL
      AND search_aliases IS NULL
      AND optimized_at IS NULL
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(limit);
}

export async function executeReenrich(db, limit = 10) {
  const candidates = findReenrichCandidates(db, limit);
  if (candidates.length === 0) return { processed: 0, skipped: 0 };

  let processed = 0, skipped = 0;
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

  for (const cand of candidates) {
    const gotSlot = await acquireLLMSlot();
    if (!gotSlot) { skipped++; continue; }

    try {
      const prompt = `Re-enrich this observation with structured metadata. Return ONLY valid JSON, no markdown fences.

Title: ${cand.title || '(untitled)'}
Narrative: ${cand.narrative || '(no narrative)'}
Type: ${cand.type || 'change'}

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"improved ≤120 char title","narrative":"improved 2-3 sentence narrative","concepts":["kw1","kw2"],"facts":["specific fact 1","specific fact 2"],"importance":1,"lesson_learned":"non-obvious insight or 'none' if routine","search_aliases":["alt query 1","alt query 2"]}
importance: 0=no value, 1=routine, 2=notable non-obvious insight, 3=critical. Default 1.
lesson_learned: State what was learned. If routine, write "none".
search_aliases: 2-6 alternative search terms (include CJK if applicable).`;

      const parsed = await callModelJSON(prompt, 'haiku', { timeout: 15000, maxTokens: 500 });
      if (!parsed || !parsed.title) { skipped++; continue; }

      if (parsed.importance === 0 || parsed.importance === '0') {
        db.prepare(`UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, optimized_at = ? WHERE id = ?`)
          .run(Date.now(), cand.id);
        processed++;
        continue;
      }

      const type = validTypes.has(parsed.type) ? parsed.type : cand.type || 'change';
      const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [];
      const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [];
      const conceptsText = concepts.join(' ');
      const factsText = facts.join(' ');
      const lessonLearned = typeof parsed.lesson_learned === 'string'
        && parsed.lesson_learned.toLowerCase() !== 'none'
        && parsed.lesson_learned.trim().length > 0
        ? parsed.lesson_learned.slice(0, 500) : null;
      const searchAliases = Array.isArray(parsed.search_aliases)
        ? parsed.search_aliases.slice(0, 6).join(' ') : null;
      const title = truncate(parsed.title, 120);
      const narrative = truncate(parsed.narrative || cand.narrative || '', 500);
      const importance = clampImportance(parsed.importance);

      const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
      const textField = [conceptsText, factsText, searchAliases || '', bigramText].filter(Boolean).join(' ');
      const minhashSig = computeMinHash((title || '') + ' ' + (narrative || ''));

      db.prepare(`
        UPDATE observations SET type=?, title=?, narrative=?, concepts=?, facts=?,
          text=?, importance=?, lesson_learned=?, search_aliases=?, minhash_sig=?, optimized_at=?
        WHERE id = ?
      `).run(type, title, narrative, conceptsText, factsText, textField,
        importance, lessonLearned, searchAliases, minhashSig, Date.now(), cand.id);

      // Rebuild TF-IDF vector
      try {
        const vocab = getVocabulary(db);
        if (vocab) {
          const vecText = [title, narrative, conceptsText].filter(Boolean).join(' ');
          const vec = computeVector(vecText, vocab);
          if (vec) {
            db.prepare(`
              INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, computed_at)
              VALUES (?, ?, ?, ?)
            `).run(cand.id, Buffer.from(vec.buffer), vocab.version, Date.now());
          }
        }
      } catch (e) { debugCatch(e, 'reenrich-vector'); }

      processed++;
    } catch (e) {
      debugCatch(e, 'reenrich');
      skipped++;
    } finally {
      releaseLLMSlot();
    }
  }

  if (processed > 0) debugLog('DEBUG', 'llm-optimize', `re-enriched ${processed} degraded observations`);
  return { processed, skipped };
}

// ─── Task 2: Normalize ─────────────────────────────────────────────────────

const NORMALIZE_GATE_FILE = join(RUNTIME_DIR, 'last-normalize.json');
const NORMALIZE_INTERVAL_MS = 7 * 86400000; // 7 days

export function shouldRunNormalize() {
  try {
    const last = JSON.parse(readFileSync(NORMALIZE_GATE_FILE, 'utf8'));
    return Date.now() - last.epoch >= NORMALIZE_INTERVAL_MS;
  } catch {
    return true;
  }
}

export function extractUniqueConcepts(db, limit = 500) {
  const rows = db.prepare(`
    SELECT concepts FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND concepts IS NOT NULL AND concepts != ''
    ORDER BY created_at_epoch DESC
    LIMIT 2000
  `).all();

  const conceptSet = new Set();
  for (const row of rows) {
    for (const c of row.concepts.split(/\s+/)) {
      const trimmed = c.trim();
      if (trimmed.length >= 2) conceptSet.add(trimmed);
    }
  }
  return [...conceptSet].slice(0, limit);
}

export async function identifySynonymGroups(concepts) {
  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return [];

  try {
    const prompt = `Analyze these concept terms from a code memory database and identify synonym groups (terms that refer to the same concept). Include cross-language synonyms (English/Chinese). Return ONLY valid JSON.

Concepts: ${concepts.join(', ')}

JSON: {"groups":[{"canonical":"preferred term","aliases":["synonym1","synonym2"]}, ...]}

Rules:
- Only include groups where you are confident the terms are true synonyms
- canonical should be the most specific/technical term
- Include CJK ↔ English equivalents if present
- Skip terms that have no synonyms in the list`;

    const parsed = await callModelJSON(prompt, 'sonnet', { timeout: 20000, maxTokens: 1000 });
    if (!parsed?.groups || !Array.isArray(parsed.groups)) return [];
    return parsed.groups.filter(g => g.canonical && Array.isArray(g.aliases) && g.aliases.length > 0);
  } catch (e) {
    debugCatch(e, 'normalize-identify');
    return [];
  } finally {
    releaseLLMSlot();
  }
}

export function applyNormalization(db, groups) {
  if (!groups || groups.length === 0) return { updated: 0 };

  const aliasMap = new Map();
  for (const g of groups) {
    for (const alias of g.aliases) {
      aliasMap.set(alias.toLowerCase(), g.canonical);
    }
  }

  const rows = db.prepare(`
    SELECT id, concepts, search_aliases FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND concepts IS NOT NULL AND concepts != ''
  `).all();

  let updated = 0;
  const updateStmt = db.prepare(`
    UPDATE observations SET concepts = ?, search_aliases = ?, optimized_at = ? WHERE id = ?
  `);

  for (const row of rows) {
    const terms = row.concepts.split(/\s+/);
    let changed = false;
    const newTerms = terms.map(t => {
      const canonical = aliasMap.get(t.toLowerCase());
      if (canonical && canonical !== t) { changed = true; return canonical; }
      return t;
    });

    if (changed) {
      const uniqueConcepts = [...new Set(newTerms)].join(' ');
      const existingAliases = row.search_aliases || '';
      const originalTerms = terms.filter(t => aliasMap.has(t.toLowerCase()) && aliasMap.get(t.toLowerCase()) !== t);
      const newAliases = [existingAliases, ...originalTerms].filter(Boolean).join(' ');
      updateStmt.run(uniqueConcepts, newAliases, Date.now(), row.id);
      updated++;
    }
  }

  if (updated > 0) debugLog('DEBUG', 'llm-optimize', `normalized concepts in ${updated} observations`);
  return { updated };
}

export async function executeNormalize(db, force = false) {
  if (!force && !shouldRunNormalize()) return { skipped: true, reason: 'gate' };

  const concepts = extractUniqueConcepts(db);
  if (concepts.length < 5) return { skipped: true, reason: 'too few concepts' };

  const groups = await identifySynonymGroups(concepts);
  if (groups.length === 0) return { processed: 0, groups: 0 };

  const result = applyNormalization(db, groups);

  try { writeFileSync(NORMALIZE_GATE_FILE, JSON.stringify({ epoch: Date.now() })); } catch {}

  return { processed: result.updated, groups: groups.length };
}
