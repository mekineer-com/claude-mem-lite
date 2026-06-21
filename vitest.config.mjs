import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    // D#40: the CLI auto-escalation path is default-ON in production but must
    // never spawn a real `claude` subprocess during the suite. This forces
    // autoDeepLlmReady's CLI branch off in every worker; tests that exercise the
    // auto path inject a stub llm or mock haiku-client instead.
    env: { CLAUDE_MEM_AUTO_DEEP_CLI: '0' },
    // Reap test-fixture dirs leaked by prior interrupted/SIGKILL'd runs (afterEach
    // never reached). Runs once before the suite; 1h age guard never touches the
    // current run. See lib/tmp-fixture-sweep.mjs.
    globalSetup: ['./tests/global-setup.mjs'],
    coverage: {
      provider: 'v8',
      include: [
        'utils.mjs', 'schema.mjs', 'server-internals.mjs', 'mem-cli.mjs',
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
