import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    // D#40: the CLI auto-escalation path is default-ON in production but must
    // never spawn a real `claude` subprocess during the suite. This forces
    // autoDeepLlmReady's CLI branch off in every worker; tests that exercise the
    // auto path inject a stub llm or mock haiku-client instead.
    //
    // Hermetic LLM mode: a dev/CI shell that exports a real ANTHROPIC_API_KEY /
    // OPENROUTER_API_KEY flips detectMode() to 'api'/'openrouter', so any un-mocked
    // LLM path would make a REAL network call — non-deterministic (rate-limit flakes),
    // slow, and billable. haiku-client.test.mjs + e2e.test.mjs already stub these
    // per-file ("the dev/CI shell may export a real key"); force them empty GLOBALLY
    // so no test can leak a live call by forgetting to. Tests that exercise keyed
    // mode override locally via vi.stubEnv (which restores to '' after each test).
    env: { CLAUDE_MEM_AUTO_DEEP_CLI: '0', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '' },
    // Reap test-fixture dirs leaked by prior interrupted/SIGKILL'd runs (afterEach
    // never reached). Runs once before the suite; 1h age guard never touches the
    // current run. See lib/tmp-fixture-sweep.mjs.
    globalSetup: ['./tests/global-setup.mjs'],
    coverage: {
      provider: 'v8',
      include: [
        'utils.mjs', 'schema.mjs', 'search-scoring.mjs', 'mem-cli.mjs',
        'registry-scanner.mjs', 'resource-discovery.mjs',
        'hook-episode.mjs', 'hook-context.mjs', 'hook-semaphore.mjs',
        'hook-shared.mjs', 'hook-llm.mjs', 'haiku-client.mjs',
        'format-utils.mjs', 'hash-utils.mjs', 'bash-utils.mjs',
        'secret-scrub.mjs', 'project-utils.mjs', 'tier.mjs',
        'tfidf.mjs', 'nlp.mjs', 'stop-words.mjs', 'synonyms.mjs',
      ],
      // Entry files and MCP-only modules tested via E2E/integration, not unit coverage
      exclude: ['install.mjs', 'server.mjs', 'hook.mjs', 'registry.mjs', 'registry-retriever.mjs', 'benchmark/**', 'scripts/**'],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 65,
      },
    },
  },
});
