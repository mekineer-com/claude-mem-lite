// claude-mem-lite: Unified LLM call wrapper
// Shared by memory (hook.mjs) and dispatch modules
// Auto-detects API key for direct calls, falls back to claude CLI
// Model configurable via CLAUDE_MEM_MODEL env var (default: haiku)

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { debugLog, debugCatch, parseJsonFromLLM } from './utils.mjs';
import { DB_DIR } from './schema.mjs';

// ─── Model Resolution ────────────────────────────────────────────────────────

// CLI name → API model ID mapping
const MODEL_MAP = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929',
};

/**
 * Resolve the LLM model to use for background calls.
 * Reads CLAUDE_MEM_MODEL env var, defaults to 'haiku'.
 * @returns {{ cli: string, api: string }} CLI name and API model ID
 */
export function resolveModel() {
  const raw = (process.env.CLAUDE_MEM_MODEL || 'haiku').toLowerCase().trim();
  const cli = MODEL_MAP[raw] ? raw : 'haiku';
  const api = MODEL_MAP[cli];
  return { cli, api };
}

// ─── Mode Detection ──────────────────────────────────────────────────────────

let _mode = null;

/**
 * Detect whether to use direct API or CLI for LLM calls.
 * Cached after first call.
 * @returns {'api'|'cli'} The detected mode
 */
export function detectMode() {
  if (_mode) return _mode;
  _mode = process.env.ANTHROPIC_API_KEY ? 'api' : 'cli';
  const { cli } = resolveModel();
  debugLog('DEBUG', 'haiku-client', `mode: ${_mode}, model: ${cli}`);
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

// ─── Model-Selectable API ────────────────────────────────────────────────────

/**
 * Call LLM with explicit model selection. Supports 'haiku' and 'sonnet'.
 * Reuses existing API/CLI dual-mode infrastructure.
 * Never throws — returns null on any error.
 *
 * @param {string} prompt The prompt text
 * @param {'haiku'|'sonnet'} model Model to use (default: 'haiku')
 * @param {object} [opts] Options
 * @param {number} [opts.timeout=15000] Timeout in milliseconds
 * @param {number} [opts.maxTokens=1000] Max tokens in response
 * @returns {Promise<{text: string}|null>} Response or null on failure
 */
export async function callLLMWithModel(prompt, model = 'haiku', { timeout = 15000, maxTokens = 1000 } = {}) {
  if (!prompt) return null;
  const resolvedModel = MODEL_MAP[model] ? model : 'haiku';
  const mode = detectMode();

  try {
    if (mode === 'api') {
      return await callModelAPI(prompt, resolvedModel, { timeout, maxTokens });
    }
    return callModelCLI(prompt, resolvedModel, { timeout });
  } catch (e) {
    debugCatch(e, `callLLMWithModel:${resolvedModel}`);
    return null;
  }
}

/**
 * Call LLM with model selection and parse JSON response.
 * @param {string} prompt
 * @param {'haiku'|'sonnet'} model
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
export async function callModelJSON(prompt, model = 'haiku', opts) {
  const result = await callLLMWithModel(prompt, model, opts);
  if (!result?.text) return null;
  return parseJsonFromLLM(result.text);
}

async function callModelAPI(prompt, model, { timeout, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const modelId = MODEL_MAP[model];
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
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      debugLog('WARN', `${model}-api`, `HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text;
    return text ? { text } : null;
  } finally {
    clearTimeout(timer);
  }
}

function callModelCLI(prompt, model, { timeout }) {
  const modelName = MODEL_MAP[model] ? model : 'haiku';
  try {
    const result = execFileSync(getClaudePath(), ['-p', '--model', modelName], {
      input: prompt,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp',
    });
    const text = result.trim();
    return text ? { text } : null;
  } catch (e) {
    const out = e.stdout?.toString?.()?.trim() || e.output?.[1]?.toString?.()?.trim();
    if (out && out.startsWith('{') && out.endsWith('}')) {
      try { JSON.parse(out); return { text: out }; } catch {}
    }
    debugCatch(e, `${model}-cli`);
    return null;
  }
}

// ─── API Mode ────────────────────────────────────────────────────────────────

async function callHaikuAPI(prompt, { timeout, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const { api: modelId } = resolveModel();
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
        model: modelId,
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
  const { cli: modelName } = resolveModel();
  try {
    const result = execFileSync(getClaudePath(), ['-p', '--model', modelName], {
      input: prompt,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/tmp', // Prevent ghost sessions in user's /resume list
    });
    const text = result.trim();
    return text ? { text } : null;
  } catch (e) {
    // Try to extract partial output on timeout — validate JSON before returning
    const out = e.stdout?.toString?.()?.trim() || e.output?.[1]?.toString?.()?.trim();
    if (out && out.startsWith('{') && out.endsWith('}')) {
      try { JSON.parse(out); return { text: out }; } catch {}
    }
    debugCatch(e, 'haiku-cli');
    return null;
  }
}
