// Tests for hook-shared.mjs callLLM — unified provider routing.
// callLLM now mirrors haiku-client's provider priority: ANTHROPIC_API_KEY /
// OPENROUTER_API_KEY route through callHaiku (async API/OpenRouter), and only
// the no-key case falls back to the `claude -p` CLI.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../schema.mjs', () => ({
  ensureDb: vi.fn(),
  ensureDbWithWalRecovery: vi.fn(),
  DB_DIR: '/tmp/hook-shared-test',
}));

vi.mock('../utils.mjs', () => ({
  inferProject: vi.fn(() => 'proj'),
  debugCatch: vi.fn(),
}));

// vi.mock factories are hoisted above imports, so shared mock fns must come
// from vi.hoisted (top-level consts are not yet initialized at factory time).
const { callHaikuMock, detectModeMock } = vi.hoisted(() => ({
  callHaikuMock: vi.fn(),
  detectModeMock: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  getClaudePath: vi.fn(() => '/usr/bin/claude'),
  resolveModel: vi.fn(() => ({ cli: 'haiku', api: 'claude-haiku-4-5-20251001' })),
  flattenForCLI: vi.fn((p) => (typeof p === 'string' ? p : `${p.system}\n${p.user}`)),
  detectMode: detectModeMock,
  callHaiku: callHaikuMock,
}));

vi.mock('../memdir.mjs', () => ({
  memdirPath: vi.fn(() => '/tmp/memdir'),
  isAdopted: vi.fn(() => false),
}));

vi.mock('../adopt-content.mjs', () => ({
  PLUGIN_SLUG: 'claude-mem-lite',
}));

import { execFileSync } from 'child_process';
import { callLLM } from '../hook-shared.mjs';

describe('hook-shared callLLM — provider routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to callHaiku and returns its text in api mode', async () => {
    detectModeMock.mockReturnValue('api');
    callHaikuMock.mockResolvedValue({ text: 'api summary' });

    const out = await callLLM('summarize this');

    expect(out).toBe('api summary');
    expect(callHaikuMock).toHaveBeenCalledTimes(1);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('delegates to callHaiku and returns its text in openrouter mode', async () => {
    detectModeMock.mockReturnValue('openrouter');
    callHaikuMock.mockResolvedValue({ text: 'or summary' });

    const out = await callLLM({ system: 'INSTR', user: 'DATA' });

    expect(out).toBe('or summary');
    expect(callHaikuMock).toHaveBeenCalledWith(
      { system: 'INSTR', user: 'DATA' },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('returns null when callHaiku yields null (api/openrouter)', async () => {
    detectModeMock.mockReturnValue('openrouter');
    callHaikuMock.mockResolvedValue(null);

    const out = await callLLM('x');

    expect(out).toBeNull();
  });

  it('passes the caller timeout through to callHaiku', async () => {
    detectModeMock.mockReturnValue('api');
    callHaikuMock.mockResolvedValue({ text: 'ok' });

    await callLLM('x', 20000);

    expect(callHaikuMock).toHaveBeenCalledWith('x', expect.objectContaining({ timeout: 20000 }));
  });

  it('falls back to the claude CLI (execFileSync) in cli mode', async () => {
    detectModeMock.mockReturnValue('cli');
    vi.mocked(execFileSync).mockReturnValue('  cli summary  ');

    const out = await callLLM('summarize this');

    expect(out).toBe('cli summary');
    expect(callHaikuMock).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/bin/claude',
      ['-p', '--model', 'haiku'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });
});
