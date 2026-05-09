// Phase B (Invited-Memory plan): memdir.mjs — primitives for the per-project
// Claude Code memdir at ~/.claude/projects/<encoded>/memory/.
//
// The public API lets a plugin install a single sentinel-wrapped line into
// MEMORY.md (auto-loaded by Claude Code into the system prompt) plus an
// on-demand `plugin_<slug>.md` detail file. Writes are idempotent, hash-guarded
// against manual user edits, and capped by a 180-line budget so the injection
// block never gets truncated by Claude Code's 200-line MEMORY.md cap.
//
// See docs/plans/2026-04-16-invited-memory-pattern.md for rationale.

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const MEMORY_LINE_BUDGET = 180;
const SECTION_HEADER = '## 插件契约';

/**
 * POSIX-accurate line count. `str.split('\n').length` overcounts by 1 when the
 * file ends with a trailing newline (almost always true for markdown), which
 * caused an off-by-one budget trip at the 180-line boundary (code review
 * finding for v2.32.3).
 */
function countLines(raw) {
  if (raw.length === 0) return 0;
  const nl = (raw.match(/\n/g) || []).length;
  return nl + (raw.endsWith('\n') ? 0 : 1);
}

export class UserEditedError extends Error {
  constructor(message) { super(message); this.name = 'UserEditedError'; }
}

export class BudgetExceededError extends Error {
  constructor(message) { super(message); this.name = 'BudgetExceededError'; }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Mirror Claude Code's project-path encoding: every non-alphanumeric char
 * is replaced with "-". Lossy by design — the encoded path is a directory
 * slug, not a reversible encoding. Ground truth fixture:
 *   /mnt/data_ssd/dev/projects/mem → -mnt-data-ssd-dev-projects-mem
 * Memory ref: #7687 ("Claude Code mangles EVERY non-alphanumeric char").
 */
export function encodeProjectPath(absPath) {
  return String(absPath).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Absolute path to the project's memdir. Caller runs mkdir-p as needed.
 */
export function memdirPath(projectCwd) {
  return join(homedir(), '.claude', 'projects', encodeProjectPath(projectCwd), 'memory');
}

function memoryFile(memdir) { return join(memdir, 'MEMORY.md'); }

function slugSnake(slug) {
  return String(slug).replace(/[^a-zA-Z0-9]/g, '_');
}

function docFile(memdir, slug) {
  return join(memdir, `plugin_${slugSnake(slug)}.md`);
}

function stateFile(memdir, slug) {
  return join(memdir, `.plugin_${slugSnake(slug)}_state.json`);
}

// ─── Sentinel rendering & parsing ────────────────────────────────────────────

function sentinelRegex(slug) {
  // Escape regex metacharacters in the slug. In practice plugin slugs are
  // [a-z0-9-], but guard against '.', '+' etc. from arbitrary other plugins.
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `<!-- ${esc}:begin (v\\d+) -->\\s*\\n([\\s\\S]*?)<!-- ${esc}:end -->`,
  );
}

function renderSentinel(slug, version, contentLine) {
  return [
    `<!-- ${slug}:begin ${version} -->`,
    SECTION_HEADER,
    contentLine,
    `<!-- ${slug}:end -->`,
  ].join('\n');
}

function canonicalBody(contentLine) {
  // Must match what sentinelRegex captures in match[2]: everything between
  // "begin X -->\n" and "<!-- X:end -->". That's SECTION_HEADER + '\n' +
  // contentLine + '\n'.
  return `${SECTION_HEADER}\n${contentLine}\n`;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readState(memdir, slug) {
  const p = stateFile(memdir, slug);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function writeState(memdir, slug, state) {
  atomicWrite(stateFile(memdir, slug), JSON.stringify(state, null, 2) + '\n');
}

function clearState(memdir, slug) {
  const p = stateFile(memdir, slug);
  if (existsSync(p)) try { unlinkSync(p); } catch { /* best-effort */ }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse MEMORY.md for the plugin's sentinel block.
 * @returns {{ exists: boolean, raw: string, lineCount: number,
 *   section: string|null, body: string|null, version: string|null }}
 */
export function readMemoryIndex(memdir, slug) {
  const path = memoryFile(memdir);
  if (!existsSync(path)) {
    return { exists: false, raw: '', lineCount: 0, section: null, body: null, version: null };
  }
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(sentinelRegex(slug));
  const lineCount = countLines(raw);
  if (!m) return { exists: true, raw, lineCount, section: null, body: null, version: null };
  return { exists: true, raw, lineCount, section: m[0], body: m[2], version: m[1] };
}

/**
 * Insert-or-update the plugin's sentinel block in MEMORY.md, writing a
 * state sidecar alongside it.
 *
 * Idempotent: rewriting identical inputs is a no-op (returns action='unchanged').
 *
 * @param {string} memdir Absolute path to the memory directory.
 * @param {object} opts
 * @param {string} opts.slug Plugin slug (e.g. 'claude-mem-lite').
 * @param {string} opts.version Contract version, e.g. 'v1'.
 * @param {string} opts.contentLine Single-line index entry (≤150 chars).
 * @param {boolean} [opts.force=false] Override UserEditedError.
 * @returns {{action: 'created'|'updated'|'unchanged'}}
 *
 * @throws {BudgetExceededError} when MEMORY.md has > 180 lines AND we'd be
 *   adding a new section (updates to an existing sentinel are always allowed).
 * @throws {UserEditedError} when the sentinel exists but its body hash doesn't
 *   match the last hash we wrote (detected via the state sidecar). Also thrown
 *   when a sentinel exists without any state file — treated as foreign content.
 */
export function writePluginSection(memdir, { slug, version, contentLine, force = false }) {
  if (!existsSync(memdir)) mkdirSync(memdir, { recursive: true });
  const path = memoryFile(memdir);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const match = raw.match(sentinelRegex(slug));

  const freshSection = renderSentinel(slug, version, contentLine);
  const freshHash = sha256(canonicalBody(contentLine));

  if (!match) {
    // Insert: enforce the 180-line budget so we never get truncated at 200.
    const existingLines = countLines(raw);
    if (existingLines > MEMORY_LINE_BUDGET) {
      throw new BudgetExceededError(
        `MEMORY.md has ${existingLines} lines (> ${MEMORY_LINE_BUDGET}); refuse to add new sentinel section for ${slug}.`,
      );
    }
    // Assemble with one blank line before our section for readability.
    let next;
    if (raw.length === 0) {
      next = freshSection + '\n';
    } else if (raw.endsWith('\n\n')) {
      next = raw + freshSection + '\n';
    } else if (raw.endsWith('\n')) {
      next = raw + '\n' + freshSection + '\n';
    } else {
      next = raw + '\n\n' + freshSection + '\n';
    }
    atomicWrite(path, next);
    writeState(memdir, slug, { version, bodyHash: freshHash, writtenAt: new Date().toISOString() });
    return { action: 'created' };
  }

  // Update path: hash-guard against user edits via state sidecar.
  if (!force) {
    const state = readState(memdir, slug);
    if (!state) {
      throw new UserEditedError(
        `${slug} sentinel found without plugin state file — treating as foreign content. Pass force=true to re-adopt.`,
      );
    }
    const currentHash = sha256(match[2]);
    if (state.bodyHash !== currentHash) {
      throw new UserEditedError(
        `${slug} sentinel body was modified since last write (hash mismatch). Pass force=true to overwrite.`,
      );
    }
  }

  const next = raw.replace(match[0], freshSection);
  const changed = next !== raw;
  if (changed) atomicWrite(path, next);
  writeState(memdir, slug, { version, bodyHash: freshHash, writtenAt: new Date().toISOString() });
  return { action: changed ? 'updated' : 'unchanged' };
}

/**
 * Remove the plugin's sentinel block plus its state sidecar. External content
 * in MEMORY.md is preserved.
 * @returns {{action: 'removed'|'absent'}}
 */
export function removePluginSection(memdir, slug) {
  clearState(memdir, slug);
  const path = memoryFile(memdir);
  if (!existsSync(path)) return { action: 'absent' };
  const raw = readFileSync(path, 'utf8');
  const match = raw.match(sentinelRegex(slug));
  if (!match) return { action: 'absent' };

  // Delete the match plus a trailing newline + a preceding blank line so we
  // don't leave a stranded paragraph gap.
  let start = match.index;
  let end = match.index + match[0].length;
  if (raw[end] === '\n') end++;
  if (start > 0 && raw.slice(0, start).endsWith('\n\n')) start--;
  let next = raw.slice(0, start) + raw.slice(end);
  // Edge case (code review v2.32.3): when the sentinel was the first content
  // (e.g. two invited-memory plugins coexist and we remove the earlier one),
  // the tail can still start with a stranded blank line / doubled newlines.
  // Normalize leading whitespace and collapse any ≥3 consecutive newlines
  // so the remaining content looks hand-authored.
  next = next.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n');
  atomicWrite(path, next);
  return { action: 'removed' };
}

/**
 * Whether this memdir has our sentinel. Body edits don't demote the adoption —
 * users who hand-tweak the contract line still count as adopted.
 */
export function isAdopted(memdir, slug) {
  if (!existsSync(memdir)) return false;
  const { section } = readMemoryIndex(memdir, slug);
  return section !== null;
}

// ─── Plugin detail doc IO ────────────────────────────────────────────────────

export function writePluginDoc(memdir, slug, markdown) {
  if (!existsSync(memdir)) mkdirSync(memdir, { recursive: true });
  atomicWrite(docFile(memdir, slug), markdown);
}

export function removePluginDoc(memdir, slug) {
  const path = docFile(memdir, slug);
  if (!existsSync(path)) return;
  try { unlinkSync(path); } catch { /* best-effort */ }
}

// ─── P2: body-structure audit ────────────────────────────────────────────────
// CC's CLAUDE.md memory contract requires feedback_*.md and project_*.md to
// carry **Why:** + **How to apply:** lines. user_*.md and reference_*.md
// have no body-structure requirement (per memoryTypes.ts <body_structure>
// blocks). MEMORY.md (the index) is excluded too — it lists pointers, not
// memory content. This is intentionally a CLI-only tool (not a hook): it
// is a one-shot governance pass, running it on every session would just be
// noise.

const AUDIT_FILE_RE = /^(feedback|project)_[A-Za-z0-9_-]+\.md$/;
const WHY_RE = /^\s*\*\*Why:\*\*/m;
const HOW_RE = /^\s*\*\*How to apply:\*\*/m;

/**
 * Strip the leading YAML frontmatter block (between `---` fences) so audit
 * checks run only against body content. Returns input unchanged if no
 * frontmatter is present.
 */
function stripFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return content;
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return m ? content.slice(m[0].length) : content;
}

/**
 * Scan a memdir for feedback_* and project_* files and bucket them by
 * body-structure compliance. Pure function — IO is read-only and bounded
 * to the directory listing + per-file Reads.
 *
 * @param {string} memdir Absolute path to memdir
 * @returns {{
 *   compliant: string[],
 *   missingWhy: string[],
 *   missingHowToApply: string[],
 *   missingBoth: string[],
 *   total: number,
 * }}
 */
export function auditMemdir(memdir) {
  const result = { compliant: [], missingWhy: [], missingHowToApply: [], missingBoth: [], total: 0 };
  if (!memdir || !existsSync(memdir)) return result;

  let entries;
  try { entries = readdirSync(memdir); } catch { return result; }

  const targets = entries.filter(n => AUDIT_FILE_RE.test(n)).sort();
  for (const name of targets) {
    let body = '';
    try {
      const raw = readFileSync(join(memdir, name), 'utf8');
      body = stripFrontmatter(raw);
    } catch { /* unreadable — count as missingBoth */ }

    const hasWhy = WHY_RE.test(body);
    const hasHow = HOW_RE.test(body);
    if (hasWhy && hasHow) result.compliant.push(name);
    else if (!hasWhy && !hasHow) result.missingBoth.push(name);
    else if (!hasWhy) result.missingWhy.push(name);
    else result.missingHowToApply.push(name);
  }
  result.total = targets.length;
  return result;
}
