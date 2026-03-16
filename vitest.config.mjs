import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: [
        'utils.mjs', 'schema.mjs', 'server-internals.mjs',
        'dispatch.mjs', 'dispatch-inject.mjs', 'dispatch-feedback.mjs',
        'registry.mjs', 'registry-retriever.mjs', 'registry-scanner.mjs',
        'resource-discovery.mjs',
        'hook-episode.mjs', 'hook-context.mjs', 'hook-semaphore.mjs',
        'hook-shared.mjs', 'hook-llm.mjs', 'haiku-client.mjs',
      ],
      // Entry files (install.mjs, server.mjs, hook.mjs) are tested via E2E/integration, not unit coverage
      exclude: ['install.mjs', 'server.mjs', 'hook.mjs', 'benchmark/**', 'scripts/**'],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 65,
      },
    },
  },
});
