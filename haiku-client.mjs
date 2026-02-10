// claude-mem-lite: Unified Haiku LLM call wrapper
// Shared by memory (hook.mjs) and dispatch modules
// Auto-detects API key for direct calls, falls back to claude CLI

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { debugLog, debugCatch, parseJsonFromLLM } from './utils.mjs';
import { DB_DIR } from './schema.mjs';

// ─── Mode Detection ──────────────────────────────────────────────────────────

let _mode = null;

/**
 * Detect whether to use direct API or CLI for Haiku calls.
 * Cached after first call.
 * @returns {'api'|'cli'} The detected mode
 */
export function detectMode() {
  if (_mode) return _mode;
  _mode = process.env.ANTHROPIC_API_KEY ? 'api' : 'cli';
  debugLog('DEBUG', 'haiku-client', `mode: ${_mode}`);
  return _mode;
}

/** Reset cached mode (for testing). */
export function _resetMode() { _mode = null; }

// ─── CLI Path ────────────────────────────────────────────────────────────────

export function getClaudePath() {
  try {
    const s = JSON.parse(readFileSync(join(DB_DIR, 'settings.json'), 'utf8'));
    if (s.CLAUDE_CODE_PATH) return s.CLAUDE_CODE_PATH;
  } catch {}
  return process.env.CLAUDE_CODE_PATH || 'claude';
}

// ─── Core Call ───────────────────────────────────────────────────────────────

/**
 * Call Haiku model with a prompt. Returns parsed text or null on failure.
 * Uses direct API when ANTHROPIC_API_KEY is available, otherwise falls back to CLI.
 * Never throws — returns null on any error.
 *
 * @param {string} prompt The prompt text
 * @param {object} [opts] Options
 * @param {number} [opts.timeout=10000] Timeout in milliseconds
 * @param {number} [opts.maxTokens=500] Max tokens in response
 * @returns {Promise<{text: string}|null>} Response or null on failure
 */
export async function callHaiku(prompt, { timeout = 10000, maxTokens = 500 } = {}) {
  if (!prompt) return null;

  const mode = detectMode();

  try {
    if (mode === 'api') {
      return await callHaikuAPI(prompt, { timeout, maxTokens });
    }
    return callHaikuCLI(prompt, { timeout });
  } catch (e) {
    debugCatch(e, 'callHaiku');
    return null;
  }
}

/**
 * Call Haiku and parse JSON response. Convenience wrapper.
 * @param {string} prompt The prompt text
 * @param {object} [opts] Options passed to callHaiku
 * @returns {Promise<object|null>} Parsed JSON or null
 */
export async function callHaikuJSON(prompt, opts) {
  const result = await callHaiku(prompt, opts);
  if (!result?.text) return null;
  return parseJsonFromLLM(result.text);
}

// ─── API Mode ────────────────────────────────────────────────────────────────

async function callHaikuAPI(prompt, { timeout, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      debugLog('WARN', 'haiku-api', `HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text;
    return text ? { text } : null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── CLI Mode ────────────────────────────────────────────────────────────────

function callHaikuCLI(prompt, { timeout }) {
  try {
    const result = execFileSync(getClaudePath(), ['-p', '--model', 'haiku'], {
      input: prompt,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = result.trim();
    return text ? { text } : null;
  } catch (e) {
    // Try to extract partial output on timeout
    const out = e.stdout?.toString?.()?.trim() || e.output?.[1]?.toString?.()?.trim();
    if (out && out.startsWith('{') && out.endsWith('}')) return { text: out };
    debugCatch(e, 'haiku-cli');
    return null;
  }
}
