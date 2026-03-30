// claude-mem-lite: LLM-powered database optimization
// Background worker for intelligent maintenance: re-enrich, normalize, cluster-merge, smart-compress
// Triggered from auto-maintain (24h) or manually via mem_optimize MCP tool / CLI

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  truncate, debugLog, debugCatch, COMPRESSED_AUTO,
  computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity, clampImportance, cjkBigrams,
} from './utils.mjs';
import { callModelJSON } from './haiku-client.mjs';
import { acquireLLMSlot, releaseLLMSlot } from './hook-semaphore.mjs';
import { getVocabulary, computeVector, cosineSimilarity } from './tfidf.mjs';
import { DB_DIR } from './schema.mjs';

const RUNTIME_DIR = join(DB_DIR, 'runtime');

// ─── Budget ─────────────────────────────────────────────────────────────────

export function distributeBudget(total = 15) {
  const normalize = 1;
  const reenrich = Math.max(1, Math.floor(total * 0.4));
  const clusterMerge = Math.max(1, Math.floor(total * 0.3));
  const smartCompress = Math.max(1, total - reenrich - normalize - clusterMerge);
  // Clamp: if total is too small for 4 tasks, cap each so sum ≤ total
  if (reenrich + normalize + clusterMerge + smartCompress > total) {
    return { reenrich: Math.max(1, total - 3), normalize: 1, clusterMerge: 1, smartCompress: 1 };
  }
  return { reenrich, normalize, clusterMerge, smartCompress };
}

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/** Rebuild TF-IDF vector for an observation. Non-critical — swallows errors. */
function rebuildVector(db, obsId, textParts) {
  try {
    const vocab = getVocabulary(db);
    if (!vocab) return;
    const vec = computeVector(textParts.filter(Boolean).join(' '), vocab);
    if (vec) {
      db.prepare(`
        INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, computed_at)
        VALUES (?, ?, ?, ?)
      `).run(obsId, Buffer.from(vec.buffer), vocab.version, Date.now());
    }
  } catch (e) { debugCatch(e, 'optimize-vector'); }
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

Title: ${truncate(cand.title || '(untitled)', 200)}
Narrative: ${truncate(cand.narrative || '(no narrative)', 500)}
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

      rebuildVector(db, cand.id, [title, narrative, conceptsText]);

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

// ─── Task 3: Cluster-merge ─────────────────────────────────────────────────

const MERGE_TIME_WINDOW_MS = 30 * 86400000;
const MERGE_JACCARD_LOW = 0.4;
const MERGE_JACCARD_HIGH = 0.85;

export function findMergeCandidates(db, maxClusters = 5) {
  const cutoff = Date.now() - MERGE_TIME_WINDOW_MS;
  const rows = db.prepare(`
    SELECT id, title, narrative, project, access_count, created_at_epoch, minhash_sig
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND optimized_at IS NULL
      AND title IS NOT NULL AND title != ''
      AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC
    LIMIT 200
  `).all(cutoff);

  const used = new Set();
  const clusters = [];

  for (let i = 0; i < rows.length && clusters.length < maxClusters; i++) {
    if (used.has(rows[i].id)) continue;
    const cluster = [rows[i]];

    for (let j = i + 1; j < rows.length && cluster.length < 5; j++) {
      if (used.has(rows[j].id)) continue;
      if (rows[i].project !== rows[j].project) continue;
      if (Math.abs(rows[i].created_at_epoch - rows[j].created_at_epoch) > MERGE_TIME_WINDOW_MS) continue;

      if (rows[i].minhash_sig && rows[j].minhash_sig) {
        const est = estimateJaccardFromMinHash(rows[i].minhash_sig, rows[j].minhash_sig);
        if (est < MERGE_JACCARD_LOW * 0.8) continue;
      }

      const titleSim = jaccardSimilarity(rows[i].title, rows[j].title);
      if (titleSim >= MERGE_JACCARD_LOW && titleSim < MERGE_JACCARD_HIGH) {
        cluster.push(rows[j]);
        used.add(rows[j].id);
      }
    }

    if (cluster.length >= 2) {
      used.add(rows[i].id);
      clusters.push(cluster);
    }
  }

  return clusters;
}

export async function executeMergeCluster(db, cluster) {
  if (cluster.length < 2) return { merged: false };

  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return { merged: false };

  try {
    const obsDescriptions = cluster.map((o, i) =>
      `${i + 1}. [${o.type || 'change'}] "${truncate(o.title, 200)}" — ${truncate(o.narrative || '(no narrative)', 500)}`
    ).join('\n');

    const prompt = `These observations from a code memory database may be about the same topic. Should they be merged into a single observation?

Observations:
${obsDescriptions}

Return ONLY valid JSON:
- If they should NOT be merged: {"should_merge":false}
- If they SHOULD be merged: {"should_merge":true,"merged_title":"≤120 char comprehensive title","merged_narrative":"comprehensive ≤800 char summary preserving all key details","merged_concepts":["kw1","kw2"],"merged_facts":["specific fact 1"],"merged_lesson":"synthesized non-obvious lesson or null","importance":2}`;

    const parsed = await callModelJSON(prompt, 'sonnet', { timeout: 20000, maxTokens: 1000 });
    if (!parsed || !parsed.should_merge) return { merged: false };

    const keeper = cluster.reduce((best, o) =>
      (o.access_count || 0) > (best.access_count || 0) ? o : best
    , cluster[0]);
    const others = cluster.filter(o => o.id !== keeper.id);

    const concepts = Array.isArray(parsed.merged_concepts) ? parsed.merged_concepts.slice(0, 10) : [];
    const facts = Array.isArray(parsed.merged_facts) ? parsed.merged_facts.slice(0, 10) : [];
    const conceptsText = concepts.join(' ');
    const factsText = facts.join(' ');
    const title = truncate(parsed.merged_title, 120);
    const narrative = truncate(parsed.merged_narrative || '', 800);
    const lessonLearned = typeof parsed.merged_lesson === 'string'
      && parsed.merged_lesson.trim().length > 0
      ? parsed.merged_lesson.slice(0, 500) : null;

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, bigramText].filter(Boolean).join(' ');
    const minhashSig = computeMinHash((title || '') + ' ' + (narrative || ''));
    const importance = clampImportance(parsed.importance || 2);

    db.transaction(() => {
      db.prepare(`
        UPDATE observations SET title=?, narrative=?, concepts=?, facts=?, text=?,
          importance=?, lesson_learned=?, minhash_sig=?, optimized_at=?
        WHERE id = ?
      `).run(title, narrative, conceptsText, factsText, textField,
        importance, lessonLearned, minhashSig, Date.now(), keeper.id);

      const otherIds = others.map(o => o.id);
      const ph = otherIds.map(() => '?').join(',');
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${ph})`)
        .run(keeper.id, ...otherIds);
    })();

    rebuildVector(db, keeper.id, [title, narrative, conceptsText]);

    debugLog('DEBUG', 'llm-optimize', `merged ${cluster.length} observations into #${keeper.id}`);
    return { merged: true, keeperId: keeper.id, mergedCount: others.length };
  } catch (e) {
    debugCatch(e, 'cluster-merge');
    return { merged: false };
  } finally {
    releaseLLMSlot();
  }
}

export async function executeClusterMerge(db, maxClusters = 5) {
  const clusters = findMergeCandidates(db, maxClusters);
  if (clusters.length === 0) return { processed: 0, merged: 0 };

  let merged = 0;
  for (const cluster of clusters) {
    const result = await executeMergeCluster(db, cluster);
    if (result.merged) merged++;
  }

  return { processed: clusters.length, merged };
}

// ─── Task 4: Smart-compress ────────────────────────────────────────────────

const COMPRESS_TIME_SPLIT_MS = 14 * 86400000;
const COMPRESS_COSINE_THRESHOLD = 0.3;

export function findSmartCompressCandidates(db, ageDays = 30) {
  const cutoff = Date.now() - ageDays * 86400000;
  return db.prepare(`
    SELECT id, title, narrative, lesson_learned, project, type, created_at_epoch
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND COALESCE(importance, 1) = 1
      AND COALESCE(access_count, 0) = 0
      AND created_at_epoch < ?
    ORDER BY project, created_at_epoch
  `).all(cutoff);
}

export function clusterForCompression(candidates, db) {
  if (candidates.length < 3) return [];

  const byProject = new Map();
  for (const c of candidates) {
    if (!byProject.has(c.project)) byProject.set(c.project, []);
    byProject.get(c.project).push(c);
  }

  const clusters = [];

  for (const [project, obs] of byProject) {
    if (obs.length < 3) continue;

    let vocab;
    try { vocab = getVocabulary(db); } catch {}

    if (vocab) {
      const vectors = obs.map(o => {
        const text = [o.title || '', o.narrative || ''].join(' ');
        return computeVector(text, vocab);
      });

      const used = new Set();
      for (let i = 0; i < obs.length; i++) {
        if (used.has(i) || !vectors[i]) continue;
        const cluster = [{ obs: obs[i], idx: i }];
        used.add(i);

        for (let j = i + 1; j < obs.length; j++) {
          if (used.has(j) || !vectors[j]) continue;
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim >= COMPRESS_COSINE_THRESHOLD) {
            cluster.push({ obs: obs[j], idx: j });
            used.add(j);
          }
        }

        if (cluster.length >= 3) {
          const sorted = cluster.map(c => c.obs).sort((a, b) => a.created_at_epoch - b.created_at_epoch);
          let subCluster = [sorted[0]];
          for (let k = 1; k < sorted.length; k++) {
            if (sorted[k].created_at_epoch - subCluster[0].created_at_epoch > COMPRESS_TIME_SPLIT_MS) {
              if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
              subCluster = [sorted[k]];
            } else {
              subCluster.push(sorted[k]);
            }
          }
          if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
        }
      }
    } else {
      // Fallback: group by time window only
      const sorted = obs.sort((a, b) => a.created_at_epoch - b.created_at_epoch);
      let subCluster = [sorted[0]];
      for (let k = 1; k < sorted.length; k++) {
        if (sorted[k].created_at_epoch - subCluster[0].created_at_epoch > COMPRESS_TIME_SPLIT_MS) {
          if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
          subCluster = [sorted[k]];
        } else {
          subCluster.push(sorted[k]);
        }
      }
      if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
    }
  }

  return clusters;
}

export async function executeSmartCompressCluster(db, observations, project) {
  if (observations.length < 3) return { compressed: false };

  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return { compressed: false };

  try {
    const obsDescriptions = observations.map((o, i) =>
      `${i + 1}. [${o.type || 'change'}] "${truncate(o.title || '(untitled)', 200)}" — ${truncate(o.narrative || '(no narrative)', 500)}${o.lesson_learned ? ` | Lesson: ${truncate(o.lesson_learned, 200)}` : ''}`
    ).join('\n');

    const prompt = `Summarize these related code memory observations into ONE comprehensive summary. Preserve all important decisions, lessons, and specific facts. Return ONLY valid JSON.

Observations:
${obsDescriptions}

JSON: {"title":"descriptive summary ≤120 chars","narrative":"comprehensive summary ≤800 chars preserving key decisions and lessons","concepts":["kw1","kw2"],"facts":["all specific facts preserved"],"lesson_learned":"most important synthesized lesson or 'none'","search_aliases":["alt search 1","alt search 2"]}`;

    const parsed = await callModelJSON(prompt, 'sonnet', { timeout: 20000, maxTokens: 1000 });
    if (!parsed || !parsed.title) return { compressed: false };

    const title = truncate(parsed.title, 120);
    const narrative = truncate(parsed.narrative || '', 800);
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

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, searchAliases || '', bigramText].filter(Boolean).join(' ');

    const epochs = observations.map(o => o.created_at_epoch).sort((a, b) => a - b);
    const medianEpoch = epochs[Math.floor(epochs.length / 2)];

    const summaryId = db.transaction(() => {
      const sessionId = `compress-${project}`;
      const now = new Date();
      db.prepare(`INSERT OR IGNORE INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?,?,?,?,?,'active')`
      ).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

      const result = db.prepare(`INSERT INTO observations
        (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
         files_read, files_modified, importance, lesson_learned, search_aliases, optimized_at,
         created_at, created_at_epoch)
        VALUES (?,?,?,?,?,'',?,?,?,'[]','[]',2,?,?,?,?,?)`
      ).run(sessionId, project, textField, 'discovery', title, narrative,
        conceptsText, factsText, lessonLearned, searchAliases, Date.now(),
        new Date(medianEpoch).toISOString(), medianEpoch);

      const sId = Number(result.lastInsertRowid);

      const obsIds = observations.map(o => o.id);
      const ph = obsIds.map(() => '?').join(',');
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${ph})`)
        .run(sId, ...obsIds);

      return sId;
    })();

    rebuildVector(db, summaryId, [title, narrative, conceptsText]);

    debugLog('DEBUG', 'llm-optimize', `smart-compressed ${observations.length} observations into #${summaryId}`);
    return { compressed: true, summaryId, count: observations.length };
  } catch (e) {
    debugCatch(e, 'smart-compress');
    return { compressed: false };
  } finally {
    releaseLLMSlot();
  }
}

export async function executeSmartCompress(db, maxClusters = 5) {
  const candidates = findSmartCompressCandidates(db);
  if (candidates.length < 3) return { processed: 0, compressed: 0 };

  const clusters = clusterForCompression(candidates, db);
  if (clusters.length === 0) return { processed: 0, compressed: 0 };

  let compressed = 0;
  const toProcess = clusters.slice(0, maxClusters);
  for (const cluster of toProcess) {
    const result = await executeSmartCompressCluster(db, cluster.observations, cluster.project);
    if (result.compressed) compressed++;
  }

  return { processed: toProcess.length, compressed };
}

// ─── Pipeline Orchestrator ──────────────────────────────────────────────────

export function optimizePreview(db) {
  const reenrich = findReenrichCandidates(db, 1000).length;

  const concepts = extractUniqueConcepts(db);
  const normalizeReady = shouldRunNormalize() && concepts.length >= 5;

  const mergeClusters = findMergeCandidates(db, 50);
  const clusterMerge = mergeClusters.length;

  const compressCandidates = findSmartCompressCandidates(db);
  const compressClusters = clusterForCompression(compressCandidates, db);
  const smartCompress = compressClusters.length;

  return {
    reenrich,
    normalize: normalizeReady ? concepts.length : 0,
    normalizeGateOpen: shouldRunNormalize(),
    clusterMerge,
    smartCompress,
    total: reenrich + (normalizeReady ? 1 : 0) + clusterMerge + smartCompress,
  };
}

export async function optimizeRun(db, { tasks, maxItems = 15, force = false } = {}) {
  const allTasks = ['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'];
  const selectedTasks = tasks && tasks.length > 0 ? tasks : allTasks;
  const budget = distributeBudget(maxItems);
  const results = {};

  for (const task of selectedTasks) {
    try {
      switch (task) {
        case 're-enrich':
          results.reenrich = await executeReenrich(db, budget.reenrich);
          break;
        case 'normalize':
          results.normalize = await executeNormalize(db, force);
          break;
        case 'cluster-merge':
          results.clusterMerge = await executeClusterMerge(db, budget.clusterMerge);
          break;
        case 'smart-compress':
          results.smartCompress = await executeSmartCompress(db, budget.smartCompress);
          break;
      }
    } catch (e) {
      debugCatch(e, `optimize:${task}`);
      results[task] = { error: e.message };
    }
  }

  return results;
}

export async function handleLLMOptimize() {
  const { ensureDb } = await import('./schema.mjs');
  let db;
  try {
    db = ensureDb();
  } catch {
    return;
  }

  try {
    const results = await optimizeRun(db);
    const parts = [];
    if (results.reenrich?.processed) parts.push(`re-enriched: ${results.reenrich.processed}`);
    if (results.normalize?.processed) parts.push(`normalized: ${results.normalize.processed}`);
    if (results.clusterMerge?.merged) parts.push(`merged: ${results.clusterMerge.merged}`);
    if (results.smartCompress?.compressed) parts.push(`compressed: ${results.smartCompress.compressed}`);
    if (parts.length > 0) debugLog('DEBUG', 'llm-optimize', parts.join(', '));
  } catch (e) {
    debugCatch(e, 'llm-optimize');
  } finally {
    db.close();
  }
}
