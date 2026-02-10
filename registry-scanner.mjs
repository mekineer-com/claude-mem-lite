// claude-mem-lite: Resource scanner — discovers skills/agents from filesystem
// Scans user local dirs and managed pre-installed dirs

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { debugCatch } from './utils.mjs';
import { DB_DIR } from './schema.mjs';

/**
 * @typedef {object} ScannedResource
 * @property {string} name Resource name (directory name)
 * @property {'skill'|'agent'} type Resource type
 * @property {'preinstalled'|'user'} source Source origin
 * @property {string} localPath Absolute path to resource directory
 * @property {string} content Combined content of resource files
 * @property {string} fileHash SHA-256 hash of content
 * @property {string|null} repoUrl GitHub repo URL if preinstalled
 */

// ─── Scan Sources ────────────────────────────────────────────────────────────

function getScanSources(dataDir) {
  const home = homedir();
  return [
    // User local resources (highest priority)
    { path: join(home, '.claude', 'skills'), type: 'skill', source: 'user' },
    { path: join(home, '.claude', 'agents'), type: 'agent', source: 'user' },
    // Pre-installed managed resources
    { path: join(dataDir, 'managed', 'skills'), type: 'skill', source: 'preinstalled' },
    { path: join(dataDir, 'managed', 'agents'), type: 'agent', source: 'preinstalled' },
  ];
}

// ─── Content Reading ─────────────────────────────────────────────────────────

/** Read the primary markdown content file from a resource directory. */
function readResourceContent(dirPath) {
  // Priority: skill.md / agent.md > README.md > first .md file
  const candidates = ['skill.md', 'agent.md', 'SKILL.md', 'AGENT.md', 'README.md'];

  for (const name of candidates) {
    const fp = join(dirPath, name);
    if (existsSync(fp)) {
      try { return readFileSync(fp, 'utf8'); } catch { continue; }
    }
  }

  // Fallback: first .md file found
  try {
    const files = readdirSync(dirPath).filter(f => f.endsWith('.md'));
    if (files.length > 0) {
      return readFileSync(join(dirPath, files[0]), 'utf8');
    }
  } catch {}

  // Last resort: look for .yaml/.yml files (some agents use YAML)
  try {
    const yamlFiles = readdirSync(dirPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (yamlFiles.length > 0) {
      return readFileSync(join(dirPath, yamlFiles[0]), 'utf8');
    }
  } catch {}

  return '';
}

/** Compute SHA-256 hash of content for change detection. */
function computeHash(content) {
  if (!content) return null;
  return createHash('sha256').update(content).digest('hex');
}

// ─── Single Resource Parsing ─────────────────────────────────────────────────

/**
 * Parse a single resource directory into a ScannedResource.
 * @param {string} dirPath Path to resource directory
 * @param {'skill'|'agent'} type Resource type
 * @param {'preinstalled'|'user'} source Source origin
 * @returns {ScannedResource|null} Parsed resource or null if invalid
 */
export function parseResource(dirPath, type, source) {
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      // Single .md file (not in a subdirectory)
      if (dirPath.endsWith('.md')) {
        const content = readFileSync(dirPath, 'utf8');
        if (!content || content.length < 10) return null;
        return {
          name: basename(dirPath, '.md'),
          type,
          source,
          localPath: dirPath,
          content,
          fileHash: computeHash(content),
          repoUrl: null,
        };
      }
      return null;
    }

    const content = readResourceContent(dirPath);
    if (!content || content.length < 10) return null;

    return {
      name: basename(dirPath),
      type,
      source,
      localPath: dirPath,
      content,
      fileHash: computeHash(content),
      repoUrl: null,
    };
  } catch (e) {
    debugCatch(e, `parseResource(${dirPath})`);
    return null;
  }
}

// ─── Directory Scanning ──────────────────────────────────────────────────────

/**
 * Scan a single directory for resources.
 * Each subdirectory (or .md file) is treated as one resource.
 * @param {string} dirPath Directory to scan
 * @param {'skill'|'agent'} type Resource type
 * @param {'preinstalled'|'user'} source Source origin
 * @returns {ScannedResource[]} Array of discovered resources
 */
export function scanDirectory(dirPath, type, source) {
  if (!existsSync(dirPath)) return [];

  const resources = [];
  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const fullPath = join(dirPath, entry);
      const res = parseResource(fullPath, type, source);
      if (res) resources.push(res);
    }
  } catch (e) {
    debugCatch(e, `scanDirectory(${dirPath})`);
  }

  return resources;
}

// ─── Main Scan ───────────────────────────────────────────────────────────────

/**
 * Scan all resource sources and return discovered resources.
 * Deduplicates by (type, name) — user resources take priority over preinstalled.
 * @param {object} [config] Configuration
 * @param {string} [config.dataDir] Data directory (defaults to DB_DIR)
 * @returns {ScannedResource[]} All discovered resources
 */
export function scanAllResources(config = {}) {
  const dataDir = config.dataDir || DB_DIR;
  const sources = getScanSources(dataDir);
  const seen = new Map(); // key: "type:name" -> resource

  for (const src of sources) {
    const resources = scanDirectory(src.path, src.type, src.source);
    for (const res of resources) {
      const key = `${res.type}:${res.name}`;
      // User resources override preinstalled (scanned first due to source order)
      if (!seen.has(key)) {
        seen.set(key, res);
      }
    }
  }

  return [...seen.values()];
}

/**
 * Compare scanned resources against DB state to find what needs indexing.
 * @param {Database} db Registry database
 * @param {ScannedResource[]} scanned Scanned resources
 * @returns {{toIndex: ScannedResource[], toDisable: object[]}} Resources needing action
 */
export function diffResources(db, scanned) {
  const existing = new Map();
  const rows = db.prepare('SELECT id, type, name, file_hash, status FROM resources').all();
  for (const r of rows) existing.set(`${r.type}:${r.name}`, r);

  const toIndex = [];
  const scannedKeys = new Set();

  for (const res of scanned) {
    const key = `${res.type}:${res.name}`;
    scannedKeys.add(key);
    const ex = existing.get(key);

    if (!ex) {
      // New resource
      toIndex.push(res);
    } else if (ex.file_hash !== res.fileHash) {
      // Content changed
      toIndex.push(res);
    }
    // else: unchanged, skip
  }

  // Resources in DB but not on filesystem → disable
  const toDisable = [];
  for (const [key, row] of existing) {
    if (!scannedKeys.has(key) && row.status === 'active') {
      toDisable.push(row);
    }
  }

  return { toIndex, toDisable };
}
