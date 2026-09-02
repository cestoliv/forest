// src/commands/count.test.ts
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import { runCount } from './count.js';

let tmpDir: string;

function initRepo(dir: string): void {
  execSync(`mkdir -p ${dir}`);
  execSync('git init', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "T"', { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '');
  execSync('git add .', { cwd: dir });
  execSync('git commit -m "init"', { cwd: dir });
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-count-')));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runCount', () => {
  it('excludes the main checkout from the count', async () => {
    const repoDir = path.join(tmpDir, 'my-repo');
    initRepo(repoDir);
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir] }, store);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCount({ cwd: repoDir, store });

    expect(logSpy.mock.calls[0][0]).toBe('Total: 0 worktrees');
  });

  it('uses singular wording for a single worktree', async () => {
    const repoDir = path.join(tmpDir, 'my-repo');
    initRepo(repoDir);
    execSync(`git worktree add -b a ${path.join(tmpDir, 'my-repo-a')}`, {
      cwd: repoDir,
    });
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir] }, store);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCount({ cwd: repoDir, store });

    expect(logSpy.mock.calls[0][0]).toBe('Total: 1 worktree');
  });

  it('prints the "no repos registered" hint when nothing is registered', async () => {
    const store = createStore(path.join(tmpDir, 'config'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCount({ cwd: tmpDir, store });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('No repos registered');
  });

  it('aggregates repos, zero-fills an idle one, and renders the exact lines', async () => {
    const forestDir = path.join(tmpDir, 'forest');
    const overloadDir = path.join(tmpDir, 'overload');
    const websiteDir = path.join(tmpDir, 'website');
    initRepo(forestDir);
    initRepo(overloadDir);
    initRepo(websiteDir);
    execSync(`git worktree add -b a ${path.join(tmpDir, 'forest-a')}`, {
      cwd: forestDir,
    });
    execSync(`git worktree add -b b ${path.join(tmpDir, 'forest-b')}`, {
      cwd: forestDir,
    });
    execSync(`git worktree add -b c ${path.join(tmpDir, 'overload-c')}`, {
      cwd: overloadDir,
    });
    // website has no linked worktree — the registered repo must still print 0.

    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [forestDir, overloadDir, websiteDir] }, store);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCount({ cwd: tmpDir, store });

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual([
      'Total: 3 worktrees',
      '',
      '  forest     2',
      '  overload   1',
      '  website    0',
    ]);
  });
});
