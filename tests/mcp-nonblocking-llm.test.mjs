// D#138 MEDIUM-3: every LLM leg reachable from an MCP request handler must run on
// the non-blocking spawn path, never execFileSync.
//
// server.mjs is a long-lived process with one event loop. execFileSync freezes it
// for the whole child lifetime, so a keyed-provider outage (which degrades to the
// CLI) stalls EVERY concurrent MCP request behind one 45s BG_LLM_TIMEOUT_MS call.
// deep-search already moved to callModelJSONAsync (D#40); these three legs did not:
//
//   mem_optimize            → hook-optimize.mjs      (re-enrich / normalize / merge / compress)
//   mem_registry enrich     → registry-enricher.mjs  (also reached via import_url)
//   mem_search deep+rerank  → rerank.mjs
//
// The assertion is behavioural, not a source grep: each entry point is really
// invoked and child_process is watched. `execFileSync` being untouched IS the
// non-blocking proof — mirrors tests/haiku-client.test.mjs's D#40 F4 case.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

// The real semaphore writes lock files under RUNTIME_DIR; identifySynonymGroups
// bails out with [] when it cannot get a slot, which would pass this test for the
// wrong reason (no LLM call at all).
vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

import { execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { _resetMode, _resetHeadlessFlag } from '../haiku-client.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';

/** A spawn() stub that answers with `stdout` one microtask after the caller attaches listeners. */
function autoAnswer(stdout) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    child.kill = vi.fn();
    Promise.resolve().then(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    });
    return child;
  };
}

describe('MCP-reachable LLM legs must not block the event loop (D#138 MEDIUM-3)', () => {
  beforeEach(() => {
    // cli mode: no keyed provider, so the call goes straight to the CLI leg —
    // the exact shape a provider outage degrades into.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENROUTER_MODEL', '');
    for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(v, '');
    _resetMode();
    _resetHeadlessFlag();
    vi.mocked(execFileSync).mockReset();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it('mem_optimize (hook-optimize identifySynonymGroups) spawns, never execFileSync', async () => {
    vi.mocked(spawn).mockImplementation(autoAnswer('{"groups":[{"canonical":"race condition","aliases":["竞态"]}]}'));
    const { identifySynonymGroups } = await import('../hook-optimize.mjs');

    const groups = await identifySynonymGroups(['race condition', '竞态']);

    expect(execFileSync, 'blocking leg reached from an MCP handler').not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(groups).toEqual([{ canonical: 'race condition', aliases: ['竞态'] }]); // leg really ran
  });

  it('mem_registry enrich (registry-enricher) spawns, never execFileSync', async () => {
    vi.mocked(spawn).mockImplementation(autoAnswer(JSON.stringify({
      capability_summary: 'Formats commit messages',
      intent_tags: 'git,commit',
      domain_tags: 'vcs',
    })));
    const db = createRegistryTestDb();
    db.prepare(`INSERT INTO resources (name, type, source, local_path, quality_tier) VALUES (?, ?, ?, ?, ?)`)
      .run('commit-helper', 'skill', 'user', '/tmp/commit-helper/SKILL.md', 'community');
    const { enrichResource } = await import('../registry-enricher.mjs');

    const ok = await enrichResource(db, 'commit-helper', 'skill', '# commit-helper\nWrites commits.');

    expect(execFileSync, 'blocking leg reached from an MCP handler').not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ok, 'enrichment must succeed so the assertion above is about HOW, not WHETHER').toBe(true);
    db.close();
  });

  it('mem_search deep+rerank (defaultRerankLLM) spawns, never execFileSync', async () => {
    vi.mocked(spawn).mockImplementation(autoAnswer('[2,1,3]'));
    const { defaultRerankLLM } = await import('../rerank.mjs');

    const res = await defaultRerankLLM('rank these candidates');

    // Bare-array answers must survive: rerank deliberately takes the {text}
    // envelope instead of a JSON-parsing dispatcher (rerank.mjs:72).
    expect(execFileSync, 'blocking leg reached from an MCP handler').not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ text: '[2,1,3]' });
  });
});
