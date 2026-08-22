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
    // Same systemic-scrub rationale for the two #8608-class leak vars (audit 2026-07-17
    // MED-5): MEM_QUIET_HOOKS=1 in a dev shell leaks into every spawned hook subprocess
    // (…process.env spread) and silently flips descriptive-stdout assertions; CLAUDE_MEM_DIR
    // overrides the HOME-based data dir (resolveDataDir), so a dev who relocated their real
    // DB would have e2e subprocesses read/write it. Tests that exercise these vars set them
    // explicitly (vi.stubEnv or child env), which overrides this global ''.
    // CLAUDE_MEM_TEST_GUARD (audit 2026-08-22 P2-4): clearing CLAUDE_MEM_DIR stops a
    // relocated dev DB from being READ, but a test that never sets the var resolves the
    // default — the maintainer's real ~/.claude-mem-lite — and writes to it. That
    // happened during the v3.73.0 release. With the guard on, lib/resolve-data-dir.mjs
    // refuses any data dir outside os.tmpdir(), in this process AND in every subprocess
    // that inherits the ambient env (the same channel by which the var goes missing).
    env: {
      CLAUDE_MEM_AUTO_DEEP_CLI: '0', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '',
      MEM_QUIET_HOOKS: '', CLAUDE_MEM_DIR: '', CLAUDE_MEM_TEST_GUARD: '1',
    },
    // Reap test-fixture dirs leaked by prior interrupted/SIGKILL'd runs (afterEach
    // never reached). Runs once before the suite; 1h age guard never touches the
    // current run. See lib/tmp-fixture-sweep.mjs.
    globalSetup: ['./tests/global-setup.mjs'],
    coverage: {
      provider: 'v8',
      // Audit 2026-08-22 P2-2: this list used to be 22 hand-picked root modules, so
      // "77.47% covered" described a curated subset while lib/'s ~70 shipped modules
      // — every extracted shared core since v3.4x — had no coverage signal at all.
      // lib/** is now in scope; the thresholds below were re-baselined against the
      // real number rather than the subset's. The four god modules stay excluded
      // (see `exclude`): they are exercised through E2E/subprocess tests, which v8
      // coverage of the parent process cannot see, so including them would measure
      // the harness rather than the code.
      include: [
        'lib/**/*.mjs',
        'utils.mjs', 'schema.mjs', 'search-scoring.mjs', 'mem-cli.mjs',
        'registry-scanner.mjs', 'resource-discovery.mjs',
        'hook-episode.mjs', 'hook-context.mjs', 'hook-semaphore.mjs',
        'hook-shared.mjs', 'hook-llm.mjs', 'haiku-client.mjs',
        'format-utils.mjs', 'hash-utils.mjs', 'bash-utils.mjs',
        'secret-scrub.mjs', 'project-utils.mjs', 'tier.mjs',
        'tfidf.mjs', 'nlp.mjs', 'stop-words.mjs', 'synonyms.mjs',
      ],
      // Entry files and MCP-only modules tested via E2E/integration, not unit coverage.
      // `experiment/**` is listed because the `lib/**/*.mjs` include above is NOT anchored
      // to the repo root — it also matches `experiment/lib/*.mjs`, an unshipped scratch dir
      // that would otherwise drag the gate down with code nothing ships.
      exclude: ['install.mjs', 'server.mjs', 'hook.mjs', 'registry.mjs', 'registry-retriever.mjs', 'benchmark/**', 'scripts/**', 'experiment/**'],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 65,
      },
    },
  },
});
