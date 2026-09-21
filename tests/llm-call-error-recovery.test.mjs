// callLLM's CLI error-recovery leg — `lib/llm-call.mjs` lines 48-75, which carried 25%
// branch coverage and no test at all.
//
// It is half of the "zero data loss" promise. When `claude -p` exits non-zero — a timeout,
// a killed child — its stdout may already hold a complete JSON object, and throwing that
// away costs the caller a whole episode or session summary. `extractResponseFromError`
// recovers it, and refuses partial output rather than handing a caller something that will
// parse into a half-record.
//
// The function is module-local, so the behaviour is driven through `callLLM` with the CLI
// runner mocked — which is also the honest seam: what matters is what a caller of callLLM
// gets back, not the private helper's signature.
//
// Written under the converge "add verification" theme: the assertions describe what the
// shipped code does today, so a green run means the behaviour is correct, and a red one is
// a finding rather than something to fix in the same breath.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execClaudeCliSyncMock = vi.fn();
const detectModeMock = vi.fn(() => 'cli');
const callHaikuMock = vi.fn();

vi.mock('../haiku-client.mjs', () => ({
  resolveModel: vi.fn(() => ({ cli: 'haiku', api: 'claude-haiku-4-5-20251001' })),
  flattenForCLI: vi.fn((p) => (typeof p === 'string' ? p : `${p.system}\n${p.user}`)),
  detectMode: detectModeMock,
  callHaiku: callHaikuMock,
  execClaudeCliSync: execClaudeCliSyncMock,
  // callLLM's default timeout argument; a mock without it throws before the branch.
  BG_LLM_TIMEOUT_MS: 45000,
}));

const { callLLM } = await import('../lib/llm-call.mjs');

/** An execFileSync-shaped failure: a non-zero exit that still produced stdout. */
function cliFailure({ stdout, output } = {}) {
  const e = new Error('Command failed: claude -p');
  if (stdout !== undefined) e.stdout = stdout;
  if (output !== undefined) e.output = output;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  detectModeMock.mockReturnValue('cli');
});

describe('callLLM recovers a complete response from a failed CLI call', () => {
  it('returns the JSON object the failed call had already written to stdout', async () => {
    execClaudeCliSyncMock.mockImplementation(() => {
      throw cliFailure({ stdout: '  {"title":"a","type":"bugfix"}  ' });
    });

    const out = await callLLM('summarize');

    // Premise: we are on the CLI leg. Without this a wrong detectMode would make every
    // assertion below pass against the api branch, which never reaches the recovery code.
    expect(execClaudeCliSyncMock).toHaveBeenCalledTimes(1);
    expect(out).toBe('{"title":"a","type":"bugfix"}');
  });

  it('reads a Buffer stdout, not just a string', async () => {
    execClaudeCliSyncMock.mockImplementation(() => {
      throw cliFailure({ stdout: Buffer.from('{"title":"b"}') });
    });

    expect(await callLLM('summarize')).toBe('{"title":"b"}');
  });

  it('falls back to output[1] when stdout is absent', async () => {
    // execFileSync populates `output` as [stdin, stdout, stderr]; some failure shapes carry
    // the payload only there.
    execClaudeCliSyncMock.mockImplementation(() => {
      throw cliFailure({ output: [null, Buffer.from('{"title":"c"}'), Buffer.from('boom')] });
    });

    expect(await callLLM('summarize')).toBe('{"title":"c"}');
  });
});

describe('callLLM refuses partial or non-JSON output', () => {
  it('rejects an empty object rather than returning a record with no fields', async () => {
    execClaudeCliSyncMock.mockImplementation(() => {
      throw cliFailure({ stdout: '{}' });
    });

    expect(await callLLM('summarize')).toBeNull();
  });

  it('rejects brace-delimited output that does not parse', async () => {
    // Both samples start `{` and end `}`, so the cheap shape check passes them and only
    // JSON.parse can say no — which is the case the helper's inner try/catch exists for.
    // A sample that merely LOOKS truncated is not enough: `{"a":{"b":1}` also ends in `}`
    // and is genuinely invalid, while `{"a":{"b":1}}` is valid and would assert nothing.
    for (const stdout of ['{"title":"d","facts":{"a":1}', '{"a":1,}']) {
      execClaudeCliSyncMock.mockImplementation(() => {
        throw cliFailure({ stdout });
      });
      expect(await callLLM('summarize'), `should reject ${stdout}`).toBeNull();
    }
  });

  it('rejects output that is not brace-delimited at all', async () => {
    execClaudeCliSyncMock.mockImplementation(() => {
      throw cliFailure({ stdout: 'Error: model overloaded\n  at foo (bar.js:1)' });
    });

    expect(await callLLM('summarize')).toBeNull();
  });

  it('returns null when the failure carried no output at all', async () => {
    execClaudeCliSyncMock.mockImplementation(() => {
      throw cliFailure({});
    });

    expect(await callLLM('summarize')).toBeNull();
  });
});
