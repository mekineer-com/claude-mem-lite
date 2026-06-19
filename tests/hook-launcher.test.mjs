// Integration tests for scripts/hook-launcher.mjs — the self-heal wrapper
// that detects ERR_MODULE_NOT_FOUND under the install dir and runs
// install.mjs repair before retrying. Spawned-process tests (vs unit tests)
// because the launcher derives its install dir from __dirname and the whole
// point of the wrapper is what happens at process boundaries.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync, readFileSync } from 'fs';
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
    // attemptHeal returns false; the launcher then degrades quietly (exit 0)
    // instead of re-throwing the original import error as a stack trace.
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");

    const first = runLauncher(root, ['entry.mjs']);
    expect(first.stderr).toMatch(/Detected broken install/);
    expect(first.stderr).toMatch(/REPAIR-ATTEMPTED/);
    expect(first.status).toBe(0);
    expect(first.stderr).not.toMatch(/node:internal|ERR_MODULE_NOT_FOUND/);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-lastheal'))).toBe(true);

    // Second invocation within cooldown skips repair and still degrades quietly
    // (clean guidance, exit 0, no stack trace) rather than failing every fire.
    const second = runLauncher(root, ['entry.mjs']);
    expect(second.stderr).not.toMatch(/REPAIR-ATTEMPTED/);
    expect(second.stderr).toMatch(/Self-heal skipped/);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toMatch(/node:internal|ERR_MODULE_NOT_FOUND/);
  });

  it('treats a missing bare dependency (e.g. better-sqlite3) as a broken install, not a foreign error', () => {
    // Root-cause regression: a half-installed/missing npm dependency throws
    // ERR_MODULE_NOT_FOUND with e.url UNDEFINED and message "Cannot find
    // package '<name>' imported from <importer>". The pre-fix classifier keyed
    // off file://INSTALL_DIR and misread this as a foreign error → re-threw a
    // Node stack trace on every hook fire (the Stop-hook noise users saw).
    const root = makeInstall('cml-launcher-baredep');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    // entry imports a bare package that does not exist — mirrors schema.mjs →
    // better-sqlite3 during a half-finished npm install.
    writeFileSync(join(root, 'entry.mjs'), "import x from 'better-sqlite3-nope-xyz';\n");

    const r = runLauncher(root, ['entry.mjs']);
    // Recognized as ours → self-heal attempted (vs silently re-thrown).
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/REPAIR-ATTEMPTED/);
    // Best-effort hook: degrades to exit 0 with no raw Node stack trace.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/node:internal/);
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

  it('re-throws a foreign/typo bare dependency NOT in package.json (surfaces the packaging bug)', () => {
    // #5/#7: a missing bare package imported from an install-dir file was
    // blanket-classified as ours → self-healed → swallowed at exit 0, hiding a
    // genuine packaging bug. With package.json readable, an UNDECLARED package
    // re-throws Node's default error instead of being silently degraded.
    const root = makeInstall('cml-launcher-foreign');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'better-sqlite3': '^12' } }));
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import x from 'totally-foreign-not-ours';\n");
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/Detected broken install/);
    expect(r.stderr).not.toMatch(/REPAIR-ATTEMPTED/);
    expect(r.stderr).toMatch(/totally-foreign-not-ours/);
  });

  it('still self-heals a missing dependency that IS declared in package.json (#5/#7)', () => {
    const root = makeInstall('cml-launcher-owndep');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'declared-dep-xyz': '^1' } }));
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import x from 'declared-dep-xyz';\n");
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/REPAIR-ATTEMPTED/);
    expect(r.status).toBe(0);
  });

  it('records an observable breakage marker when degrading to exit 0 (#4/#8)', () => {
    const root = makeInstall('cml-launcher-broken-marker');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    const marker = join(root, 'runtime', 'hook-launcher-broken');
    expect(existsSync(marker)).toBe(true);
    const rec = JSON.parse(readFileSync(marker, 'utf8'));
    expect(rec.reason).toBeTruthy();
    expect(typeof rec.ts).toBe('number');
  });

  it('degrades to exit 0 (no stack trace) when the entry still fails after a "successful" repair (#14)', () => {
    // The retry-fail branch (exit code 1→0 in v3.1.0, previously untested):
    // install.mjs reports success (exit 0) but does NOT fix the import, so the
    // cache-busted retry throws again. Must degrade to exit 0 + record breakage.
    const root = makeInstall('cml-launcher-retry-fail');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-DONE");process.exit(0);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './still-missing.mjs';\n");
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/Hook still failing after self-heal/);
    expect(r.stderr).not.toMatch(/node:internal/);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-broken'))).toBe(true);
  });

  it('clears the heal cooldown + breakage markers after a fully successful self-heal (#6/#9)', () => {
    const root = makeInstall('cml-launcher-heal-clears');
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
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('HEALED-OK');
    // cooldown cleared so an unrelated later breakage can heal immediately
    expect(existsSync(join(root, 'runtime', 'hook-launcher-lastheal'))).toBe(false);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-broken'))).toBe(false);
  });
});
