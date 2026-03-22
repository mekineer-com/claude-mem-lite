#!/usr/bin/env node
const CLI_COMMANDS = new Set(['search', 'recent', 'recall', 'get', 'timeline', 'save', 'stats', 'context', 'browse', 'delete', 'update', 'export', 'compress', 'maintain', 'fts-check', 'registry', 'help']);
const INSTALL_COMMANDS = new Set(['install', 'uninstall', 'status', 'doctor', 'cleanup', 'cleanup-hooks', 'self-update', 'release']);

const cmd = process.argv[2];

if (cmd === '--version' || cmd === '-v') {
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
  process.stdout.write(`claude-mem-lite v${pkg.version}\n`);
} else if (cmd === '--help' || cmd === '-h') {
  const { run } = await import('./mem-cli.mjs');
  await run(['help']);
} else if (CLI_COMMANDS.has(cmd)) {
  const { run } = await import('./mem-cli.mjs');
  await run(process.argv.slice(2));
} else if (!cmd || INSTALL_COMMANDS.has(cmd)) {
  const { main } = await import('./install.mjs');
  await main(process.argv.slice(2));
} else {
  process.stderr.write(`[mem] Unknown command: "${cmd}"\n`);
  process.stderr.write('[mem] Run "claude-mem-lite help" for CLI commands or "claude-mem-lite install" for setup\n');
  process.exitCode = 1;
}
