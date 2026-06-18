// src/lib/git.test.ts
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneBareAndCheckout } from '../test-utils.js';
import {
  addWorktree,
  branchExists,
  fetchRemote,
  getRepoRoot,
  listWorktreeDirtyFiles,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  resolveWorktreePath,
  setUpstreamTracking,
} from './git.js';

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  // Resolve symlinks so paths match git's canonical output (macOS /var -> /private/var)
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-git-')));
  repoDir = path.join(tmpDir, 'repo');
  execSync(`mkdir -p ${repoDir}`);
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "t@t.com"', { cwd: repoDir });
  execSync('git config user.name "T"', { cwd: repoDir });
  writeFileSync(path.join(repoDir, 'README.md'), '');
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getRepoRoot', () => {
  it('returns repo root when inside a repo', () => {
    expect(getRepoRoot(repoDir)).toBe(repoDir);
  });

  it('throws when not in a git repo', () => {
    expect(() => getRepoRoot(tmpdir())).toThrow('Not in a git repository');
  });

  it('returns the main repo root when run from inside a linked worktree', () => {
    const wtPath = path.join(tmpDir, 'repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    expect(getRepoRoot(wtPath)).toBe(repoDir);
  });
});

describe('listWorktrees', () => {
  it('lists the main worktree', () => {
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path).toBe(repoDir);
    expect(worktrees[0].isCurrent).toBe(true);
    expect(worktrees[0].repoRoot).toBe(repoDir);
  });

  it('lists additional worktrees', () => {
    const wtPath = path.join(tmpDir, 'repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees).toHaveLength(2);
    expect(worktrees.find((w) => w.branch === 'feature')).toBeDefined();
  });

  it('isCurrent is false for a sibling directory with the same prefix', () => {
    // Simulates: main worktree at /tmp/xxx/repo, cwd is /tmp/xxx/repo-extra
    // Uses parseWorktreeList directly to avoid realpathSync on a non-existent path
    const siblingCwd = `${repoDir}-extra`;
    const fakeOutput = `worktree ${repoDir}\nHEAD abc123\nbranch refs/heads/master\n`;
    const worktrees = parseWorktreeList(fakeOutput, repoDir, siblingCwd);
    expect(worktrees[0].isCurrent).toBe(false);
  });

  it('includes lastCommit matching the commit subject', () => {
    // beforeEach already created a commit with message "init"
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees[0].lastCommit).toBe('init');
  });

  it('returns empty lastCommit when the worktree has no commits', () => {
    const emptyDir = path.join(tmpDir, 'empty-repo');
    execSync(`mkdir -p ${emptyDir}`);
    execSync('git init', { cwd: emptyDir });
    execSync('git config user.email "t@t.com"', { cwd: emptyDir });
    execSync('git config user.name "T"', { cwd: emptyDir });
    // No commits — git log will fail; lastCommit should fall back to ''
    const worktrees = listWorktrees(
      realpathSync(emptyDir),
      realpathSync(emptyDir),
    );
    expect(worktrees[0].lastCommit).toBe('');
  });
});

describe('addWorktree', () => {
  it('creates a worktree with a new branch from base', () => {
    const wtPath = path.join(tmpDir, 'repo-feature');
    addWorktree(repoDir, wtPath, 'feature', 'HEAD');
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees.find((w) => w.branch === 'feature')).toBeDefined();
  });

  it('creates a worktree from an existing branch', () => {
    execSync('git checkout -b existing', { cwd: repoDir });
    execSync('git checkout -', { cwd: repoDir });
    const wtPath = path.join(tmpDir, 'repo-existing');
    addWorktree(repoDir, wtPath, 'existing');
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees.find((w) => w.branch === 'existing')).toBeDefined();
  });
});

describe('removeWorktree', () => {
  it('removes an additional worktree', () => {
    const wtPath = path.join(tmpDir, 'repo-to-remove');
    addWorktree(repoDir, wtPath, 'to-remove', 'HEAD');
    removeWorktree(repoDir, wtPath);
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees).toHaveLength(1);
  });

  it('force-removes a worktree with uncommitted changes', () => {
    const wtPath = path.join(tmpDir, 'repo-dirty');
    addWorktree(repoDir, wtPath, 'dirty', 'HEAD');
    writeFileSync(path.join(wtPath, 'dirty.txt'), 'uncommitted');
    expect(() => removeWorktree(repoDir, wtPath)).toThrow();
    removeWorktree(repoDir, wtPath, true);
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees.find((w) => w.branch === 'dirty')).toBeUndefined();
  });

  it('falls back to manual removal when git worktree remove fails', () => {
    const wtPath = path.join(tmpDir, 'repo-fallback');
    addWorktree(repoDir, wtPath, 'fallback', 'HEAD');
    writeFileSync(path.join(wtPath, '.git'), 'garbage');
    removeWorktree(repoDir, wtPath, true);
    expect(existsSync(wtPath)).toBe(false);
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees.find((w) => w.branch === 'fallback')).toBeUndefined();
  });

  it('force-removes when directory is already deleted', () => {
    const wtPath = path.join(tmpDir, 'repo-gone');
    addWorktree(repoDir, wtPath, 'gone', 'HEAD');
    rmSync(wtPath, { recursive: true, force: true });
    removeWorktree(repoDir, wtPath, true);
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees.find((w) => w.branch === 'gone')).toBeUndefined();
  });

  it('does not fall back when force is false', () => {
    const wtPath = path.join(tmpDir, 'repo-no-fallback');
    addWorktree(repoDir, wtPath, 'no-fallback', 'HEAD');
    writeFileSync(path.join(wtPath, '.git'), 'garbage');
    expect(() => removeWorktree(repoDir, wtPath)).toThrow();
    expect(existsSync(wtPath)).toBe(true);
  });

  it('force-removes a worktree containing submodules', () => {
    const subDir = path.join(tmpDir, 'sub-repo');
    execSync(`mkdir -p ${subDir}`);
    execSync('git init', { cwd: subDir });
    execSync('git config user.email "t@t.com"', { cwd: subDir });
    execSync('git config user.name "T"', { cwd: subDir });
    writeFileSync(path.join(subDir, 'sub.txt'), '');
    execSync('git add .', { cwd: subDir });
    execSync('git commit -m "sub init"', { cwd: subDir });

    execSync(`git -c protocol.file.allow=always submodule add ${subDir} sub`, {
      cwd: repoDir,
    });
    execSync('git commit -m "add submodule"', { cwd: repoDir });

    const wtPath = path.join(tmpDir, 'repo-with-sub');
    addWorktree(repoDir, wtPath, 'with-sub', 'HEAD');
    execSync('git -c protocol.file.allow=always submodule update --init', {
      cwd: wtPath,
    });

    expect(() => removeWorktree(repoDir, wtPath)).toThrow(
      'cannot be moved or removed',
    );

    removeWorktree(repoDir, wtPath, true);
    expect(existsSync(wtPath)).toBe(false);
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees.find((w) => w.branch === 'with-sub')).toBeUndefined();
  });
});

describe('listWorktreeDirtyFiles', () => {
  it('returns empty array for a clean worktree', () => {
    expect(listWorktreeDirtyFiles(repoDir)).toEqual([]);
  });

  it('returns modified tracked files', () => {
    writeFileSync(path.join(repoDir, 'README.md'), 'changed');
    const files = listWorktreeDirtyFiles(repoDir);
    expect(files.some((f) => f.includes('README.md'))).toBe(true);
  });

  it('returns untracked files', () => {
    writeFileSync(path.join(repoDir, 'new.txt'), 'new');
    const files = listWorktreeDirtyFiles(repoDir);
    expect(files.some((f) => f.includes('new.txt'))).toBe(true);
  });

  it('returns empty array when called with a non-existent path', () => {
    expect(listWorktreeDirtyFiles('/nonexistent/path')).toEqual([]);
  });
});

describe('branchExists', () => {
  it('returns true for an existing local branch', () => {
    execSync('git checkout -b my-branch', { cwd: repoDir });
    execSync('git checkout -', { cwd: repoDir });
    expect(branchExists(repoDir, 'my-branch')).toBe(true);
  });

  it('returns false for a non-existent branch', () => {
    expect(branchExists(repoDir, 'no-such-branch')).toBe(false);
  });
});

describe('fetchRemote', () => {
  let bareDir: string;
  let cloneDir: string;

  beforeEach(() => {
    ({ bareDir, cloneDir } = cloneBareAndCheckout(tmpDir, repoDir));
  });

  it('updates local tracking refs from the remote', () => {
    // Push a new commit directly to the bare remote
    execSync(`git remote add bare ${bareDir}`, { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'new.txt'), 'new');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "remote-ahead"', { cwd: repoDir });
    execSync('git push bare master', { cwd: repoDir });

    // Before fetch, clone's origin/master is stale
    const before = execSync('git rev-parse origin/master', {
      cwd: cloneDir,
      encoding: 'utf8',
    }).trim();

    fetchRemote(cloneDir, 'origin');

    const after = execSync('git rev-parse origin/master', {
      cwd: cloneDir,
      encoding: 'utf8',
    }).trim();

    expect(after).not.toBe(before);
  });

  it('throws when the remote does not exist', () => {
    expect(() => fetchRemote(cloneDir, 'nonexistent')).toThrow();
  });
});

describe('resolveWorktreePath', () => {
  it('resolves path using worktree_path and branch', () => {
    const result = resolveWorktreePath(
      '/home/user/projects/my-repo',
      '../',
      'feature',
    );
    expect(result).toBe('/home/user/projects/my-repo-feature');
  });

  it('sanitizes slashes in branch names', () => {
    const result = resolveWorktreePath(
      '/home/user/projects/my-repo',
      '../',
      'feature/my-task',
    );
    expect(result).toBe('/home/user/projects/my-repo-feature-my-task');
  });
});

describe('setUpstreamTracking', () => {
  let cloneDir: string;

  beforeEach(() => {
    ({ cloneDir } = cloneBareAndCheckout(tmpDir, repoDir));
  });

  it('sets upstream tracking for a branch with a remote counterpart', () => {
    execSync('git checkout -b feature', { cwd: cloneDir });
    execSync('git push origin feature', { cwd: cloneDir });
    execSync('git checkout -', { cwd: cloneDir });

    const wtPath = path.join(tmpDir, 'clone-feature');
    addWorktree(cloneDir, wtPath, 'feature');
    setUpstreamTracking(wtPath, 'feature', 'origin');

    const remote = execSync('git config branch.feature.remote', {
      cwd: wtPath,
      encoding: 'utf8',
    }).trim();
    const merge = execSync('git config branch.feature.merge', {
      cwd: wtPath,
      encoding: 'utf8',
    }).trim();
    expect(remote).toBe('origin');
    expect(merge).toBe('refs/heads/feature');
  });

  it('silently ignores when the remote branch does not exist', () => {
    const wtPath = path.join(tmpDir, 'clone-new');
    addWorktree(cloneDir, wtPath, 'brand-new', 'HEAD');

    expect(() =>
      setUpstreamTracking(wtPath, 'brand-new', 'origin'),
    ).not.toThrow();
  });
});
