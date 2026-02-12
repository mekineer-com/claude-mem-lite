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
      exclude: ['install.mjs', 'server.mjs', 'hook.mjs', 'benchmark/**', 'scripts/**'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
});
