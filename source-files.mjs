// Shared runtime source-file manifest — imported by install.mjs and hook-update.mjs
// so the two code paths never drift. Adding a new .mjs that any entry point
// (cli.mjs / hook.mjs / server.mjs / mem-cli.mjs / install.mjs) imports requires
// adding the path here AND to package.json's files array;
// tests/source-files-sync.test.mjs enforces both.

export const SOURCE_FILES = [
  // Entry points and top-level modules
  'cli.mjs', 'cli-path.mjs', 'server.mjs', 'server-internals.mjs', 'search-engine.mjs', 'deep-search.mjs', 'rerank.mjs', 'tool-schemas.mjs',
  'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs', 'hook-memory.mjs', 'skip-tools.mjs',
  'hook-semaphore.mjs', 'hook-episode.mjs', 'hook-context.mjs', 'hook-handoff.mjs',
  'hook-update.mjs', 'hook-optimize.mjs', 'hook-precompact.mjs',
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
  'lib/cli-flags.mjs',
  'lib/task-reader.mjs',
  'lib/plan-reader.mjs',
  'lib/git-state.mjs',
  'lib/startup-dashboard.mjs',
  'lib/doctor-benchmark.mjs',
  'lib/doctor-drift.mjs',
  'lib/stats-quality.mjs',
  'lib/low-signal-patterns.mjs',
  'lib/private-strip.mjs',
  'lib/citation-tracker.mjs',
  'lib/cite-back-hint.mjs',
  // v2.85: stale test-fixture sweeper. Imported by install.mjs (cleanup) + cli.mjs.
  // Missing from manifest → tarball ships install.mjs that ERR_MODULE_NOT_FOUND on cleanup.
  'lib/tmp-fixture-sweep.mjs',
  'lib/summary-extractor.mjs',
  'lib/id-routing.mjs',
  'lib/err-sampler.mjs',
  // v2.76.x: unsampled hook-script failure log. Imported by
  // scripts/pre-tool-recall.js + scripts/pre-skill-bridge.js (recorder)
  // and mem-cli.mjs (countRecentHookErrors for `stats`). Missing from
  // manifest → tarball ships hooks that ERR_MODULE_NOT_FOUND on every fire.
  'lib/hook-telemetry.mjs',
  // v3.0: read-time file-intelligence (①) + repeated-read guard (②). Imported
  // ONLY by scripts/pre-tool-recall.js (reread-guard also imports file-intel) —
  // NOT reachable from the 5 ENTRY_MODULES, so the hook-script coverage test in
  // source-files-sync.test.mjs is what keeps these from being dropped on bump.
  'lib/file-intel.mjs',
  'lib/reread-guard.mjs',
  'lib/metrics.mjs',
  // v2.71.x: better-sqlite3 ABI probe + auto-rebuild. Shared by install.mjs
  // (post-`npm install` verify) and scripts/launch.mjs (pre-server-launch
  // self-heal after Node ABI changes). Missing from manifest → auto-update
  // ships a stale install that FATALs on first DB open after Node upgrade.
  'lib/binding-probe.mjs',
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
  // P0 (v2.59.x): user-explicit "ignore memory" override detector. Lives
  // under lib/ (not scripts/) so hook.mjs can statically import it without
  // colliding with the scripts/ directory rename in installExtractedRelease
  // — see the SWITCHABLE_PATHS loop in hook-update.mjs.
  'lib/mem-override.mjs',
  // v2.61 dedup refactor: shared "save one observation" pipeline used by both
  // mem-cli.mjs::cmdSave and server.mjs::mem_save. Statically imported from both
  // entry points; missing it from the manifest broke MCP saves on auto-update.
  'lib/save-observation.mjs',
  // Single-source observations-table write primitives (insertObservationRow/Files/
  // Vector). Statically imported by lib/save-observation.mjs and hook-llm.mjs (both
  // entry-point-reachable); missing it from the manifest would break ALL saves on
  // auto-update. Same single-source-of-truth pattern (see #8217).
  'lib/observation-write.mjs',
  'lib/recall-core.mjs',
  // Shared timeline core (anchor resolution + before/after window) and shared
  // cross-source search core (sessions/prompts FTS, CJK fallback, normalization,
  // pagination math). Statically imported by mem-cli.mjs AND server.mjs — same
  // single-source-of-truth pattern; missing either from the manifest would break
  // `timeline`/`search` and mem_timeline/mem_search on auto-update.
  'lib/timeline-core.mjs',
  'lib/search-core.mjs',
  // Shared "compress old low-value observations into weekly summaries" core.
  // Statically imported by mem-cli.mjs (cmdCompress), server.mjs (mem_compress),
  // and hook.mjs (handleAutoCompress) — same single-source-of-truth pattern as
  // save-observation.mjs; missing it from the manifest would break compress on auto-update.
  'lib/compress-core.mjs',
  // Shared maintenance ops (decay/cleanup/boost/demote/dedup/purge/vacuum/rebuild).
  // Statically imported by mem-cli.mjs (cmdMaintain), server.mjs (mem_maintain),
  // and hook.mjs (handleAutoMaintain) — missing it would break maintain on auto-update.
  'lib/maintain-core.mjs',
  // P10 dedup/merge threshold constants — single source of truth for the Jaccard
  // dedup/merge cutoffs. Statically imported by hook.mjs, hook-llm.mjs,
  // hook-optimize.mjs, mem-cli.mjs, server.mjs, and the save/maintain cores;
  // missing it from the manifest would break those paths on auto-update.
  'lib/dedup-constants.mjs',
  // v2.70 deferred-work: carry-forward TODO primitives. Statically imported by
  // server.mjs (mem_defer family) and mem-cli.mjs (defer subcommand).
  'lib/deferred-work.mjs',
  // v2.70 one-shot upgrade banner. Split out of hook.mjs because hook.mjs has
  // module-level `process.exit(0)` side effects that abort vitest workers on
  // direct import. Statically imported by hook.mjs SessionStart handler.
  'lib/upgrade-banner.mjs',
  // Per-table scrub helper for defense-in-depth at text-write INSERT paths.
  // Statically imported by hook-llm, hook-handoff, hook-optimize, hook,
  // mem-cli; reached transitively from server.mjs and cli.mjs.
  'lib/scrub-record.mjs',
  // Rate-limited friendly hint for an unloadable native DB binding
  // (ERR_DLOPEN_FAILED). Statically imported by hook.mjs; ship it so the
  // dispatch catch path resolves in installed/tarball runtimes.
  'lib/native-binding-hint.mjs',
  // Cold-start backfill: parses ~/.claude/projects/<encoded>/<uuid>.jsonl
  // transcripts into user_prompts + observations. Dynamic-imported by
  // mem-cli.mjs::cmdImportJsonl; listed here so source-files-sync.test.mjs
  // and the npm tarball ship it on every release.
  'lib/import-jsonl.mjs',
];

/**
 * Hook scripts that direct-install (non-plugin) mode must materialize under
 * ~/.claude-mem-lite/scripts/ — settings.json hook commands resolve to these
 * absolute paths. Plugin mode does not consume this directory (it runs scripts
 * from ${CLAUDE_PLUGIN_ROOT} instead).
 *
 * Single source of truth for both install.mjs (initial install) and
 * hook-update.mjs (auto-update): pre-v2.55 hook-update copied the entire
 * scripts/ tree from the GitHub Releases tarball, which silently shipped
 * dev-only files (mock-claude.mjs, extract-repos.mjs, p0-forward-probe.mjs…)
 * to every user's data dir on the first auto-update.
 */
export const HOOK_SCRIPT_FILES = [
  'post-tool-use.sh',
  'user-prompt-search.js',
  'prompt-search-utils.mjs',
  'pre-tool-recall.js',
  'pre-skill-bridge.js',
  // v2.84: self-heal wrapper that detects ERR_MODULE_NOT_FOUND under the
  // install dir and runs install.mjs repair before retrying the entry.
  // hooks.json + install.mjs settings template invoke node hook entries
  // through this wrapper so any partial-install drift heals automatically.
  'hook-launcher.mjs',
];
