// Project directories named in a non-Latin script get their own project (D9).
//
// projectNameFromDir replaced every character outside [a-zA-Z0-9_.-] with '-', so
// ~/projects/博客 and ~/projects/商城 were both `projects----`, and 项目/api and 工作/api were
// both `----api`: two projects' memories, handoffs, startup context and file recall were one
// pool. Letters, marks and digits of any script now survive; everything else is still
// replaced. ASCII names come out byte for byte as before, so no existing ASCII project moves.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectNameFromDir } from '../project-utils.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

/** The rule before D9, verbatim — the oracle for "ASCII names do not move". */
const before = (p) => {
  const base = p.split('/').filter(Boolean).pop() || '';
  const parts = p.split('/').filter(Boolean);
  const parent = parts.length > 1 ? parts[parts.length - 2] : '';
  const raw = parent ? `${parent}--${base}` : base;
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
};

describe('project identity', () => {
  it('keeps two CJK-named sibling projects apart', () => {
    const a = projectNameFromDir('/home/u/projects/博客');
    const b = projectNameFromDir('/home/u/projects/商城');
    expect(a).toBe('projects--博客');
    expect(b).toBe('projects--商城');
    expect(projectNameFromDir('/home/u/项目/api')).not.toBe(projectNameFromDir('/home/u/工作/api'));
  });

  it('is unchanged for every ASCII directory name', () => {
    const cases = [
      '/home/u/dev/claude-mem-lite',
      '/home/u/my projects/web app!',
      '/srv/a+b/c:d',
      '/x',
      '/',
      '/org/proj.v2/sub_dir',
      `/home/u/${'p'.repeat(80)}/${'q'.repeat(80)}`,
      '/home/u/dir with @ and # and $',
    ];
    for (const c of cases) expect(projectNameFromDir(c), c).toBe(before(c));
  });

  it('names the same directory the same way whether the OS hands it over composed or decomposed', () => {
    // macOS file APIs can return NFD; CLAUDE_PROJECT_DIR is usually NFC.
    const nfc = '/w/caf\u00e9';
    const nfd = '/w/cafe\u0301';
    expect(nfc).not.toBe(nfd); // premise: two different strings
    expect(projectNameFromDir(nfd)).toBe(projectNameFromDir(nfc));
    expect(projectNameFromDir(nfc)).toBe('w--caf\u00e9');
  });

  it('still replaces what is not a letter, mark or digit', () => {
    expect(projectNameFromDir('/w/a\u202eb')).toBe('w--a-b'); // bidi override
    expect(projectNameFromDir('/w/\u7b14\u8bb0\u{1f4dd}')).toBe('w--\u7b14\u8bb0-'); // emoji
    expect(projectNameFromDir('/w/a\uff0cb')).toBe('w--a-b'); // fullwidth comma
    expect(projectNameFromDir('/w/a@b')).toBe('w--a-b');
  });

  it('stays within 100 UTF-8 bytes without splitting a character', () => {
    const name = projectNameFromDir(`/w/${'博'.repeat(60)}`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(100);
    expect(Buffer.from(name).toString('utf8')).toBe(name);
    expect(name).toBe(`w--${'博'.repeat(32)}`);
  });
});

describe('the bash Read tracker and the Node flush agree on the reads file', () => {
  function readInto(projectDir, env) {
    const home = join(dirname(dirname(projectDir)), 'home');
    mkdirSync(home, { recursive: true });
    const r = spawnSync('bash', [join(REPO, 'scripts/post-tool-use.sh')], {
      input: JSON.stringify({
        session_id: 's',
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'a.md') },
      }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_MEM_DIR: '',
        CLAUDE_PLUGIN_ROOT: REPO,
        ...env,
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(r.status, r.stderr).toBe(0);
    const rt = join(home, '.claude-mem-lite', 'runtime');
    return readdirSync(rt).filter((f) => f.startsWith('reads-'));
  }
  const proj = (name) => {
    const d = join(fixtures.track(join(tmpdir(), `mem-d9-${randomUUID().slice(0, 8)}`)), 'projects', name);
    mkdirSync(d, { recursive: true });
    return d;
  };

  it('with a host pid, the file is named for the process alone, in any script and any locale', () => {
    for (const LC_ALL of ['C', 'C.UTF-8']) {
      expect(readInto(proj('博客'), { CLAUDE_PID: '4101', LC_ALL })).toEqual(['reads-@h4101.txt']);
    }
  });

  it('without one, an ASCII project keeps its bash-built name', () => {
    expect(readInto(proj('todo-app'), { CLAUDE_PID: '' })).toEqual(['reads-projects--todo-app.txt']);
  });

  it('without one, a non-ASCII project is recorded by Node under the Node name, in any locale', () => {
    for (const LC_ALL of ['C', 'C.UTF-8']) {
      const d = proj('博客');
      const files = readInto(d, { CLAUDE_PID: '', LC_ALL });
      expect(files).toEqual(['reads-projects--博客.txt']);
      const rt = join(dirname(dirname(d)), 'home', '.claude-mem-lite', 'runtime');
      expect(readFileSync(join(rt, files[0]), 'utf8')).toBe(`${join(d, 'a.md')}\n`);
    }
  });
});
