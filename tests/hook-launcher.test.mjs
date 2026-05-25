// Integration tests for scripts/hook-launcher.mjs — the self-heal wrapper
// that detects ERR_MODULE_NOT_FOUND under the install dir and runs
// install.mjs repair before retrying. Spawned-process tests (vs unit tests)
// because the launcher derives its install dir from __dirname and the whole
// point of the wrapper is what happens at process boundaries.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SRC_LAUNCHER = join(REPO_ROOT, 'scripts', 'hook-launcher.mjs');

const tracked = new Set();
function makeInstall(prefix) {
  const root = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(SRC_LAUNCHER, join(root, 'scripts', 'hook-launcher.mjs'));
  tracked.add(root);
  return root;
}

afterEach(() => {
  for (const d of tracked) rmSync(d, { recursive: true, force: true });
  tracked.clear();
});

function runLauncher(root, args, env = {}) {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts', 'hook-launcher.mjs'), ...args],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_DIR: root, ...env } },
  );
}

describe('hook-launcher self-heal', () => {
  it('passes through when the target entry imports cleanly', () => {
    const root = makeInstall('cml-launcher-pass');
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-OK');
  });

  it('forwards positional argv to the entry as process.argv[2..]', () => {
    const root = makeInstall('cml-launcher-argv');
    writeFileSync(
      join(root, 'entry.mjs'),
      'process.stdout.write("ARGV=" + JSON.stringify(process.argv.slice(2)) + "\\n");\n',
    );
    const r = runLauncher(root, ['entry.mjs', 'session-start', '--flag', 'value']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ARGV=["session-start","--flag","value"]');
  });

  it('exits 1 with usage error when no entry is provided', () => {
    const root = makeInstall('cml-launcher-noarg');
    const r = runLauncher(root, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing entry argument/);
  });

  it('does NOT self-heal on errors other than ERR_MODULE_NOT_FOUND', () => {
    const root = makeInstall('cml-launcher-other');
    writeFileSync(join(root, 'install.mjs'), 'console.error("SHOULD-NOT-RUN");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), 'throw new Error("plain runtime error");\n');
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/SHOULD-NOT-RUN/);
    expect(r.stderr).not.toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/plain runtime error/);
  });

  it('runs install.mjs repair on local ERR_MODULE_NOT_FOUND and records cooldown', () => {
    const root = makeInstall('cml-launcher-heal');
    // Stub install.mjs simulating a failed repair (no network in tests).
    // attemptHeal returns false; launcher rethrows the original error.
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");

    const first = runLauncher(root, ['entry.mjs']);
    expect(first.stderr).toMatch(/Detected broken install/);
    expect(first.stderr).toMatch(/REPAIR-ATTEMPTED/);
    expect(first.status).not.toBe(0);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-lastheal'))).toBe(true);

    // Second invocation within cooldown skips repair (still throws original)
    const second = runLauncher(root, ['entry.mjs']);
    expect(second.stderr).not.toMatch(/REPAIR-ATTEMPTED/);
    expect(second.stderr).toMatch(/Self-heal skipped/);
    expect(second.status).not.toBe(0);
  });

  it('re-runs the entry after a successful self-heal', () => {
    const root = makeInstall('cml-launcher-heal-retry');
    // install.mjs stub writes the missing module then exits 0 (simulates a
    // successful repair). Launcher should then re-import the entry and succeed.
    writeFileSync(
      join(root, 'install.mjs'),
      `import { writeFileSync, mkdirSync } from 'fs';\n` +
      `import { join, dirname } from 'path';\n` +
      `import { fileURLToPath } from 'url';\n` +
      `const __dirname = dirname(fileURLToPath(import.meta.url));\n` +
      `const target = join(__dirname, 'missing-local.mjs');\n` +
      `mkdirSync(dirname(target), { recursive: true });\n` +
      `writeFileSync(target, 'process.stdout.write("HEALED-OK\\\\n");\\n');\n` +
      `process.exit(0);\n`,
    );
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");

    const r = runLauncher(root, ['entry.mjs']);
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stdout).toContain('HEALED-OK');
    expect(r.status).toBe(0);
  });
});
