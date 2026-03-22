#!/usr/bin/env node
const CLI_COMMANDS = new Set(['search', 'recent', 'recall', 'get', 'timeline', 'save', 'stats', 'context', 'browse', 'delete', 'update', 'export', 'compress', 'maintain', 'fts-check', 'registry', 'help']);

const cmd = process.argv[2];

if (cmd === '--help' || cmd === '-h') {
  const { run } = await import('./mem-cli.mjs');
  await run(['help']);
} else if (CLI_COMMANDS.has(cmd)) {
  const { run } = await import('./mem-cli.mjs');
  await run(process.argv.slice(2));
} else {
  const { main } = await import('./install.mjs');
  await main(process.argv.slice(2));
}
