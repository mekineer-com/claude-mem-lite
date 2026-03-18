#!/usr/bin/env node
const CLI_COMMANDS = new Set(['search', 'recent', 'recall', 'get', 'timeline', 'save', 'stats', 'context', 'help']);

const cmd = process.argv[2];

if (CLI_COMMANDS.has(cmd)) {
  const { run } = await import('./mem-cli.mjs');
  await run(process.argv.slice(2));
} else {
  const { main } = await import('./install.mjs');
  await main(process.argv.slice(2));
}
