// Tests for haiku-client.mjs — unified Haiku LLM call wrapper
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock child_process before importing haiku-client
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock schema.mjs to avoid DB_DIR dependency issues
vi.mock('../schema.mjs', () => ({
  DB_DIR: '/tmp/haiku-test',
}));

// Mock utils.mjs — only the functions haiku-client uses
vi.mock('../utils.mjs', () => ({
  debugLog: vi.fn(),
  debugCatch: vi.fn(),
  parseJsonFromLLM: vi.fn((raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }),
}));

import { execFileSync } from 'child_process';
import { detectMode, _resetMode, getClaudePath, callHaiku, callHaikuJSON } from '../haiku-client.mjs';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('haiku-client.mjs', () => {
  beforeEach(() => {
    _resetMode();
    vi.restoreAllMocks();
    // Re-apply mock for execFileSync since restoreAllMocks clears it
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ─── detectMode ──────────────────────────────────────────────────────────

  describe('detectMode', () => {
    it('returns "api" when ANTHROPIC_API_KEY is set', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key-123');
      _resetMode();
      expect(detectMode()).toBe('api');
    });

    it('returns "cli" when ANTHROPIC_API_KEY is not set', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      expect(detectMode()).toBe('cli');
    });

    it('caches the result after first call', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      expect(detectMode()).toBe('cli');
      // Now set the key — should still return 'cli' (cached)
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
      expect(detectMode()).toBe('cli');
    });
  });

  // ─── _resetMode ──────────────────────────────────────────────────────────

  describe('_resetMode', () => {
    it('clears cached mode so next detectMode re-evaluates', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      expect(detectMode()).toBe('cli');

      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
      _resetMode(); // Clear cache
      expect(detectMode()).toBe('api');
    });
  });

  // ─── getClaudePath ─────────────────────────────────────────────────────

  describe('getClaudePath', () => {
    it('falls back to env CLAUDE_CODE_PATH', () => {
      vi.stubEnv('CLAUDE_CODE_PATH', '/usr/local/bin/claude-custom');
      expect(getClaudePath()).toBe('/usr/local/bin/claude-custom');
    });

    it('falls back to "claude" when no env or settings', () => {
      vi.stubEnv('CLAUDE_CODE_PATH', '');
      expect(getClaudePath()).toBe('claude');
    });
  });

  // ─── callHaiku ────────────────────────────────────────────────────────────

  describe('callHaiku', () => {
    it('returns null on empty prompt', async () => {
      const result = await callHaiku('');
      expect(result).toBeNull();
    });

    it('returns null on null prompt', async () => {
      const result = await callHaiku(null);
      expect(result).toBeNull();
    });

    it('routes to CLI mode when no API key', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      vi.mocked(execFileSync).mockReturnValue('  hello world  ');

      const result = await callHaiku('test prompt');
      expect(result).toEqual({ text: 'hello world' });
      expect(execFileSync).toHaveBeenCalledWith(
        expect.any(String),
        ['-p', '--model', 'haiku'],
        expect.objectContaining({
          input: 'test prompt',
          encoding: 'utf8',
        })
      );
    });

    it('routes to API mode when ANTHROPIC_API_KEY is present', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key');
      _resetMode();

      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ text: 'api response' }],
        }),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const result = await callHaiku('test prompt');
      expect(result).toEqual({ text: 'api response' });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-test-key',
          }),
        })
      );
    });

    it('returns null on CLI error (never throws)', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('command failed');
      });

      const result = await callHaiku('test prompt');
      expect(result).toBeNull();
    });

    it('returns null on API error (never throws)', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key');
      _resetMode();

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      const result = await callHaiku('test prompt');
      expect(result).toBeNull();
    });
  });

  // ─── callHaikuJSON ────────────────────────────────────────────────────────

  describe('callHaikuJSON', () => {
    it('parses JSON response', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      vi.mocked(execFileSync).mockReturnValue('{"key": "value"}');

      const result = await callHaikuJSON('test prompt');
      expect(result).toEqual({ key: 'value' });
    });

    it('returns null on non-JSON response', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      vi.mocked(execFileSync).mockReturnValue('not json at all');

      const result = await callHaikuJSON('test prompt');
      expect(result).toBeNull();
    });

    it('returns null when callHaiku returns null', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      _resetMode();
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('failed');
      });

      const result = await callHaikuJSON('test prompt');
      expect(result).toBeNull();
    });
  });
});
