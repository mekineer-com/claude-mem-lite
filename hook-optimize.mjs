// claude-mem-lite: LLM-powered database optimization
// Background worker for intelligent maintenance: re-enrich, normalize, cluster-merge, smart-compress
// Triggered from auto-maintain (24h) or manually via mem_optimize MCP tool / CLI

import {
  truncate, debugLog, debugCatch, COMPRESSED_AUTO,
  computeMinHash, clampImportance, cjkBigrams,
} from './utils.mjs';
import { callModelJSON } from './haiku-client.mjs';
import { acquireLLMSlot, releaseLLMSlot } from './hook-semaphore.mjs';
import { getVocabulary, computeVector } from './tfidf.mjs';

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
