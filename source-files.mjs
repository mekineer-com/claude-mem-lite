// Shared runtime source-file manifest — imported by install.mjs and hook-update.mjs
// so the two code paths never drift. Adding a new .mjs that any entry point
// (cli.mjs / hook.mjs / server.mjs / mem-cli.mjs / install.mjs) imports requires
// adding the path here AND to package.json's files array;
// tests/source-files-sync.test.mjs enforces both.

export const SOURCE_FILES = [
  // Entry points and top-level modules
  'cli.mjs', 'server.mjs', 'server-internals.mjs', 'search-engine.mjs', 'tool-schemas.mjs',
  'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs', 'hook-memory.mjs', 'skip-tools.mjs',
  'hook-semaphore.mjs', 'hook-episode.mjs', 'hook-context.mjs', 'hook-handoff.mjs',
  'hook-update.mjs', 'hook-optimize.mjs',
  'plugin-cache-guard.mjs',
  'haiku-client.mjs', 'utils.mjs', 'schema.mjs',
  'package.json', 'package-lock.json', 'skill.md',
  'registry.mjs', 'registry-scanner.mjs', 'registry-indexer.mjs',
  'registry-retriever.mjs', 'resource-discovery.mjs',
  // registry-enricher/-github/-importer are dynamically imported by server.mjs
  // (mem_registry tool) and mem-cli.mjs (registry CLI subcommands). Missing
  // them from SOURCE_FILES silently broke those code paths prior to this fix.
  'registry-enricher.mjs', 'registry-github.mjs', 'registry-importer.mjs',
  // Shared SOURCE_FILES manifest — self-reference so `~/.claude-mem-lite/` can
  // re-run install.mjs (which imports this module) after an auto-update.
  'source-files.mjs',
  'install.mjs', 'install-metadata.mjs', 'mem-cli.mjs',
  'tier.mjs', 'tfidf.mjs',
  'nlp.mjs', 'synonyms.mjs', 'scoring-sql.mjs', 'stop-words.mjs', 'project-utils.mjs',
  'secret-scrub.mjs', 'format-utils.mjs', 'hash-utils.mjs', 'bash-utils.mjs',
  // lib/ — statically imported by hook-llm.mjs (activity) + hook-handoff.mjs (git-state, task-reader);
  // dynamically imported by hook.mjs (startup-dashboard) + mem-cli.mjs (doctor-benchmark, plan-reader).
  'lib/activity.mjs',
  'lib/task-reader.mjs',
  'lib/plan-reader.mjs',
  'lib/git-state.mjs',
  'lib/startup-dashboard.mjs',
  'lib/doctor-benchmark.mjs',
  'lib/doctor-drift.mjs',
  'lib/stats-quality.mjs',
  'lib/low-signal-patterns.mjs',
  'lib/citation-tracker.mjs',
  'lib/summary-extractor.mjs',
  'lib/id-routing.mjs',
  'lib/err-sampler.mjs',
  'lib/metrics.mjs',
  // v2.41 god-module split — mem-cli.mjs router + per-cmd handlers under cli/
  'cli/common.mjs',
  'cli/fts-check.mjs',
  'cli/doctor.mjs',
  'cli/activity.mjs',
  'server/fts-check.mjs',
  // v2.32 invited-memory: memdir primitives + adopt/unadopt CLI
  'memdir.mjs',
  'adopt-content.mjs',
  'adopt-cli.mjs',
];
