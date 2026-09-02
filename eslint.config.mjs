import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js globals
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        performance: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // Intentional empty catch blocks are a common pattern in this codebase
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Relax rules for test files
  {
    files: ['**/*.test.mjs', '**/test-helpers.mjs'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // Ignore non-source files.
  //
  // `scripts/**` is deliberately NOT here. It was, for the whole life of this
  // config, and that hid 4470 lines across 17 files — five of them (post-tool-use,
  // pre-agent-inject, pre-tool-recall, pre-skill-bridge, user-prompt-search) fire
  // on every hook event in production. The v3.75.1 stray-`export` bug lived there
  // and no gate in the repo could see it: eslint skipped the directory outright,
  // and knip lists `scripts/*.{mjs,js}` as ENTRY points, whose exports are exempt
  // from the unused-export report by definition. Un-ignoring cost five fixes.
  // Adding a directory here means deciding its code may rot unchecked.
  {
    ignores: ['node_modules/**', 'coverage/**', 'benchmark/**', '.tmp/**', 'tmp/**', 'docs/**'],
  },
];
