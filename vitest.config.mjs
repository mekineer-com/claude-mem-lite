import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['utils.mjs', 'schema.mjs', 'server-internals.mjs'],
      exclude: ['install.mjs', 'server.mjs', 'benchmark/**', 'scripts/**'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
});
