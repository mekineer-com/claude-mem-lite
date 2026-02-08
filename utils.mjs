// claude-mem-lite shared utilities
// Used by both server.mjs and hook.mjs

export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function truncate(str, max = 80) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export function typeIcon(type) {
  const icons = { decision: '🟡', bugfix: '🔴', feature: '🟢', refactor: '🔵', discovery: '🔍', change: '📝' };
  return icons[type] || '⚪';
}

// Sanitize FTS5 query: escape special chars, wrap tokens in double quotes
// Preserves hyphens within words (e.g. "webpack-dev-server") while stripping
// leading minus (FTS5 NOT operator) and other special chars.
const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);
export function sanitizeFtsQuery(query) {
  if (!query) return null;
  const cleaned = query
    .replace(/[{}()\[\]^~*:]/g, ' ')
    .replace(/(^|\s)-/g, '$1')
    .trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter(t => t && !/^-+$/.test(t) && !FTS5_KEYWORDS.has(t.toUpperCase()));
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

export function clampImportance(val) {
  if (typeof val !== 'number' || isNaN(val)) return 1;
  return Math.max(1, Math.min(3, Math.round(val)));
}

import { basename } from 'path';

export function computeRuleImportance(episode) {
  let importance = 1;
  for (const entry of episode.entries) {
    const sig = entry.bashSig;
    const files = entry.files || [];

    // importance=3: test/build failure, security files, DB migrations
    if (sig?.isError && (sig?.isTest || sig?.isBuild)) { importance = 3; break; }
    if (files.some(f => /\.(env|pem|key)$|\/auth\.|\/credential|\/password/i.test(f))) { importance = 3; break; }
    if (files.some(f => /migration|schema\.|prisma|alembic/i.test(f))) { importance = 3; break; }

    // importance=2: errors, git ops, deploy, config changes
    if (sig?.isError && importance < 2) importance = 2;
    if (sig?.isGit && importance < 2) importance = 2;
    if (sig?.isDeploy && importance < 2) importance = 2;
    if (files.some(f => /\.config\.|tsconfig|Dockerfile|docker-compose|package\.json|\.yml$|\.yaml$/i.test(basename(f))) && importance < 2) importance = 2;
  }
  return importance;
}
