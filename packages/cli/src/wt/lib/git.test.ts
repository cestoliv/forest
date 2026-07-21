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
  hasNoUniqueCommits,
  isBranchClosed,
  isBranchMerged,
  isBranchMergedOnForge,
  isWorktreeClean,
  listWorktreeDirtyFiles,
  listWorktrees,
  parseWorktreeList,
  remoteExists,
  removeWorktree,
  resolveWorktreePath,
  setUpstreamTracking,
  slugifyBranch,
  splitBaseRef,
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

// git init may default to 'master' or 'main' depending on the host config.
const base = (): string =>
  execSync('git branch --show-current', {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();

// Set up an ambiguous fast-forward / merge-commit branch: its commit lands
// verbatim in base, so the tip becomes a strict ancestor of base and
// `git cherry` emits nothing. Git alone cannot decide — only the forge can.
// `pushed` simulates the branch having been pushed (a remote-tracking ref),
// which gates the forge lookup.
const setupMergedFf = (pushed = true): string => {
  const b = base();
  execSync('git checkout -b merged-ff', { cwd: repoDir });
  writeFileSync(path.join(repoDir, 'ff.txt'), 'ff content');
  execSync('git add . && git commit -m "ff work"', { cwd: repoDir });
  if (pushed) {
    execSync('git update-ref refs/remotes/origin/merged-ff merged-ff', {
      cwd: repoDir,
    });
  }
  execSync(`git checkout ${b}`, { cwd: repoDir });
  execSync('git merge --no-ff -m "merge merged-ff" merged-ff', {
    cwd: repoDir,
  });
  return b;
};

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
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[0].repoRoot).toBe(repoDir);
  });

  it('lists additional worktrees', () => {
    const wtPath = path.join(tmpDir, 'repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees).toHaveLength(2);
    const feature = worktrees.find((w) => w.branch === 'feature');
    expect(feature).toBeDefined();
    // Only the main worktree is flagged; linked worktrees are not.
    expect(feature?.isMain).toBe(false);
    expect(worktrees.filter((w) => w.isMain)).toHaveLength(1);
    expect(worktrees[0].isMain).toBe(true);
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

  it('tolerates a non-existent cwd without throwing or emptying the list', () => {
    // A deleted cwd (e.g. the just-pruned current worktree, seen again on the
    // TUI auto-refresh) must not make `realpathSync(cwd)` throw. The worktrees
    // still list; none is marked current since the gone path matches nothing.
    const worktrees = listWorktrees(
      repoDir,
      path.join(tmpDir, 'does-not-exist'),
    );
    expect(worktrees.some((w) => w.path === repoDir)).toBe(true);
    expect(worktrees.every((w) => !w.isCurrent)).toBe(true);
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
  it('refuses to remove the main worktree and leaves it intact', () => {
    expect(() => removeWorktree(repoDir, repoDir)).toThrow(
      'Refusing to remove the main worktree',
    );
    // Even with force, the main repo directory must survive.
    expect(() => removeWorktree(repoDir, repoDir, true)).toThrow(
      'Refusing to remove the main worktree',
    );
    expect(existsSync(repoDir)).toBe(true);
    expect(existsSync(path.join(repoDir, '.git'))).toBe(true);
  });

  it('removes an additional worktree', () => {
    const wtPath = path.join(tmpDir, 'repo-to-remove');
    addWorktree(repoDir, wtPath, 'to-remove', 'HEAD');
    removeWorktree(repoDir, wtPath);
    const worktrees = listWorktrees(repoDir, repoDir);
    expect(worktrees).toHaveLength(1);
  });

  it('removes the worktree that is the process cwd (cwd-independent)', () => {
    // Documents that `removeWorktree` uses `cwd: repoRoot`, never
    // `process.cwd()`, so pruning the worktree you are standing in works.
    const wtPath = path.join(tmpDir, 'repo-cwd');
    addWorktree(repoDir, wtPath, 'cwd-wt', 'HEAD');
    // singleFork/serial: restore to the pre-test cwd (a stable dir outside
    // tmpDir, which afterEach deletes) so no later test inherits a gone cwd.
    const origCwd = process.cwd();
    process.chdir(realpathSync(wtPath));
    try {
      removeWorktree(repoDir, wtPath);
      const worktrees = listWorktrees(repoDir, repoDir);
      expect(worktrees.find((w) => w.branch === 'cwd-wt')).toBeUndefined();
    } finally {
      process.chdir(origCwd);
    }
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

describe('remoteExists', () => {
  it('returns true for a configured remote', () => {
    const { cloneDir } = cloneBareAndCheckout(tmpDir, repoDir);
    expect(remoteExists(cloneDir, 'origin')).toBe(true);
  });

  it('returns false for a missing remote', () => {
    const { cloneDir } = cloneBareAndCheckout(tmpDir, repoDir);
    expect(remoteExists(cloneDir, 'upstream')).toBe(false);
  });

  it('returns false for a local-only repo with no remotes', () => {
    // repoDir is initialized without any remote
    expect(remoteExists(repoDir, 'origin')).toBe(false);
  });

  it('fails closed (false) on a non-repo path', () => {
    expect(remoteExists(path.join(tmpDir, 'does-not-exist'))).toBe(false);
  });
});

describe('slugifyBranch', () => {
  it('replaces spaces with dashes', () => {
    expect(slugifyBranch('detection issues 13-07')).toBe(
      'detection-issues-13-07',
    );
  });

  it('leaves an already-valid branch name untouched', () => {
    expect(slugifyBranch('feat/my-task')).toBe('feat/my-task');
  });

  it('preserves slashes for namespaced branches', () => {
    expect(slugifyBranch('feature/some cool thing')).toBe(
      'feature/some-cool-thing',
    );
  });

  it('strips characters git forbids in ref names', () => {
    expect(slugifyBranch('fix: bug ~^:?*[]\\ here')).toBe('fix-bug-here');
  });

  it('collapses repeated separators', () => {
    expect(slugifyBranch('a   b---c///d')).toBe('a-b-c/d');
  });

  it('collapses ".." which git forbids', () => {
    expect(slugifyBranch('foo..bar')).toBe('foo-bar');
  });

  it('trims separators git forbids at the edges', () => {
    expect(slugifyBranch('  /.-foo bar-./  ')).toBe('foo-bar');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(slugifyBranch('  ~^:  ')).toBe('');
  });

  it('produces a name accepted by git check-ref-format', () => {
    const slug = slugifyBranch('detection issues 13-07');
    // Throws (non-zero exit) if the name is invalid.
    execSync(`git check-ref-format "refs/heads/${slug}"`);
    expect(slug).toBe('detection-issues-13-07');
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

describe('isBranchMerged', () => {
  it('returns true for a single-commit branch that was squash-merged', () => {
    const b = base();
    execSync('git checkout -b squashed', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 's.txt'), 'squash content');
    execSync('git add . && git commit -m "squash work"', { cwd: repoDir });
    execSync(`git checkout ${b}`, { cwd: repoDir });
    // Squash merge: the branch's diff lands on base as a brand-new commit, so
    // the branch tip is NOT an ancestor — only the patch-id (git cherry) check
    // can detect this.
    execSync('git merge --squash squashed', { cwd: repoDir });
    execSync('git commit -m "squash work (squashed)"', { cwd: repoDir });

    expect(isBranchMerged(repoDir, 'squashed', b)).toBe(true);
  });

  it('returns true for a branch whose commit was rebased/cherry-picked onto base', () => {
    const b = base();
    execSync('git checkout -b rebased', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'r.txt'), 'rebased content');
    execSync('git add . && git commit -m "rebased work"', { cwd: repoDir });
    const sha = execSync('git rev-parse HEAD', {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    execSync(`git checkout ${b}`, { cwd: repoDir });
    // Advance base first so replaying the branch's patch lands on a different
    // parent — a new sha with the same patch id (a genuine rebase-merge), not a
    // fast-forward that would reuse the original commit verbatim.
    writeFileSync(path.join(repoDir, 'base.txt'), 'base moved on');
    execSync('git add . && git commit -m "base advances"', { cwd: repoDir });
    execSync(`git cherry-pick ${sha}`, { cwd: repoDir });

    expect(isBranchMerged(repoDir, 'rebased', b)).toBe(true);
  });

  it('returns false for a branch merged by a merge commit (no patch-id match)', () => {
    // Its commit lands verbatim in base, so `git cherry` emits nothing. Pure
    // topology cannot call this merged — `hasNoUniqueCommits` covers it.
    const b = setupMergedFf();
    expect(isBranchMerged(repoDir, 'merged-ff', b)).toBe(false);
  });

  it('returns false for a brand-new branch with no commits of its own', () => {
    const b = base();
    // A freshly-created worktree branch points at base and has done no work; it
    // must not be reported as merged (otherwise prune would offer to delete it).
    execSync('git branch fresh', { cwd: repoDir });

    expect(isBranchMerged(repoDir, 'fresh', b)).toBe(false);
  });

  it('returns false for a branch with commits not on base', () => {
    const b = base();
    execSync('git checkout -b unmerged', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'u.txt'), 'unmerged');
    execSync('git add . && git commit -m "unmerged work"', { cwd: repoDir });

    expect(isBranchMerged(repoDir, 'unmerged', b)).toBe(false);
  });

  it('returns false (no throw) when the base ref does not exist', () => {
    expect(isBranchMerged(repoDir, base(), 'origin/does-not-exist')).toBe(
      false,
    );
  });
});

describe('splitBaseRef', () => {
  it('splits a <remote>/<branch> ref', () => {
    expect(splitBaseRef('origin/main')).toEqual({
      remote: 'origin',
      branch: 'main',
    });
  });

  it('strips only the leading remote from a nested branch name', () => {
    expect(splitBaseRef('origin/feature/nested')).toEqual({
      remote: 'origin',
      branch: 'feature/nested',
    });
  });

  it('defaults a slashless value to the origin remote', () => {
    expect(splitBaseRef('main')).toEqual({ remote: 'origin', branch: 'main' });
  });
});

describe('hasNoUniqueCommits', () => {
  it('returns true when the branch tip equals the base tip', () => {
    const b = base();
    execSync('git branch fresh', { cwd: repoDir });
    expect(hasNoUniqueCommits(repoDir, 'fresh', b)).toBe(true);
  });

  it('returns true for a branch merged with a merge commit', () => {
    const b = setupMergedFf(false);
    expect(hasNoUniqueCommits(repoDir, 'merged-ff', b)).toBe(true);
  });

  it('returns false for a branch with a commit not on base', () => {
    const b = base();
    execSync('git checkout -b ahead', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'a.txt'), 'ahead');
    execSync('git add . && git commit -m "ahead work"', { cwd: repoDir });
    expect(hasNoUniqueCommits(repoDir, 'ahead', b)).toBe(false);
  });

  it('returns true for a branch left behind as base advances', () => {
    // A fresh worktree branch whose base has since moved on is indistinguishable
    // from a fast-forward-merged one at the branch level. Reporting true here is
    // only safe because `buildPrunePredicate` ANDs this with `isWorktreeClean`
    // and `hasRemoteTrackingRef` — an in-progress or never-pushed worktree is
    // still never pruned on this path.
    const b = base();
    execSync('git branch stale', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'base.txt'), 'base moved on');
    execSync('git add . && git commit -m "base advances"', { cwd: repoDir });

    expect(hasNoUniqueCommits(repoDir, 'stale', b)).toBe(true);
  });

  it('fails closed (false) when the base ref does not exist', () => {
    expect(hasNoUniqueCommits(repoDir, base(), 'origin/does-not-exist')).toBe(
      false,
    );
  });
});

describe('isWorktreeClean', () => {
  it('returns true for a clean worktree', () => {
    expect(isWorktreeClean(repoDir)).toBe(true);
  });

  it('returns false when a tracked file is modified', () => {
    writeFileSync(path.join(repoDir, 'README.md'), 'changed');
    expect(isWorktreeClean(repoDir)).toBe(false);
  });

  it('returns false when only untracked files are present', () => {
    // Untracked work is still the user's work — never prune over it.
    writeFileSync(path.join(repoDir, 'new.txt'), 'new');
    expect(isWorktreeClean(repoDir)).toBe(false);
  });

  it('fails closed (false) on a non-existent path', () => {
    // Contrast with `listWorktreeDirtyFiles`, which reads a bad path as "clean".
    expect(isWorktreeClean('/nonexistent/path')).toBe(false);
  });
});

describe('isBranchMergedOnForge', () => {
  // A squash-merge that the forge rebased onto a newer base: the squash commit's
  // patch id differs from the branch commit's, and the branch is still 1 commit
  // *ahead* of base. Git can see neither the patch equivalence nor an ancestry
  // relation — the forge is the only witness. `pushed` gates the forge lookup.
  const setupRebasedSquash = (pushed = true): string => {
    const b = base();
    execSync('git checkout -b offline', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'offline.txt'), 'offline work');
    execSync('git add . && git commit -m "offline work"', { cwd: repoDir });
    if (pushed) {
      execSync('git update-ref refs/remotes/origin/offline offline', {
        cwd: repoDir,
      });
    }
    execSync(`git checkout ${b}`, { cwd: repoDir });
    // Base advances, then the squash lands with a *different* patch than the
    // branch commit (the rebase re-resolved it against the new base).
    writeFileSync(path.join(repoDir, 'base.txt'), 'base moved on');
    execSync('git add . && git commit -m "base advances"', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'offline.txt'), 'offline work, rebased');
    execSync('git add . && git commit -m "offline (#50)"', { cwd: repoDir });
    return b;
  };

  it('returns true for a rebased squash-merge that git cannot see', () => {
    const b = setupRebasedSquash();
    // Both git-only signals genuinely fail on this branch.
    expect(isBranchMerged(repoDir, 'offline', b)).toBe(false);
    expect(hasNoUniqueCommits(repoDir, 'offline', b)).toBe(false);

    expect(isBranchMergedOnForge(repoDir, 'offline', b, () => true)).toBe(true);
  });

  it('does not consult the forge for a branch that was never pushed', () => {
    const b = setupRebasedSquash(false);
    let called = false;
    const forge = () => {
      called = true;
      return true;
    };
    // No remote-tracking ref → it cannot have a merged PR/MR → skip the lookup.
    expect(isBranchMergedOnForge(repoDir, 'offline', b, forge)).toBe(false);
    expect(called).toBe(false);
  });

  it('returns false when the forge reports no merged PR/MR', () => {
    const b = setupRebasedSquash();
    expect(isBranchMergedOnForge(repoDir, 'offline', b, () => false)).toBe(
      false,
    );
  });

  it('passes the local base branch name and the remote to the forge check', () => {
    // No ancestry check happens here, so the forge query must be filtered to
    // PRs/MRs targeting base — which requires the local name, not `origin/main`.
    setupRebasedSquash();
    execSync('git update-ref refs/remotes/upstream/offline offline', {
      cwd: repoDir,
    });
    let seen: string[] = [];
    const forge = (
      _r: string,
      _b: string,
      baseLocal: string,
      remote: string,
    ) => {
      seen = [baseLocal, remote];
      return true;
    };
    expect(
      isBranchMergedOnForge(repoDir, 'offline', 'upstream/release/1.x', forge),
    ).toBe(true);
    expect(seen).toEqual(['release/1.x', 'upstream']);
  });

  it('fails closed (false) when the forge check throws', () => {
    const b = setupRebasedSquash();
    const forge = () => {
      throw new Error('forge exploded');
    };
    expect(isBranchMergedOnForge(repoDir, 'offline', b, forge)).toBe(false);
  });
});

describe('isBranchClosed', () => {
  // A pushed branch that is AHEAD of base: it has a commit that never landed on
  // base (its PR was closed without merging, the fix applied elsewhere). Git
  // cannot detect this — `isBranchMerged` returns false — so only the forge
  // (a closed PR/MR) can decide. `pushed` simulates a remote-tracking ref,
  // which gates the forge lookup.
  const setupClosedAhead = (pushed = true): string => {
    const b = base();
    execSync('git checkout -b closed-ahead', { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'c.txt'), 'closed content');
    execSync('git add . && git commit -m "closed work"', { cwd: repoDir });
    if (pushed) {
      execSync('git update-ref refs/remotes/origin/closed-ahead closed-ahead', {
        cwd: repoDir,
      });
    }
    execSync(`git checkout ${b}`, { cwd: repoDir });
    return b;
  };

  it('returns true for a pushed branch ahead of base when the forge reports a closed PR/MR', () => {
    const b = setupClosedAhead();
    // The branch is ahead of base and never merged, so `isBranchMerged` is
    // false — the closed-PR path is doing the work here.
    expect(isBranchMerged(repoDir, 'closed-ahead', b)).toBe(false);
    expect(isBranchClosed(repoDir, 'closed-ahead', b, () => true)).toBe(true);
  });

  it('does not consult the forge for a branch that was never pushed', () => {
    const b = setupClosedAhead(false);
    let called = false;
    const forge = () => {
      called = true;
      return true;
    };
    // No remote-tracking ref → it cannot have a PR/MR → skip the lookup.
    expect(isBranchClosed(repoDir, 'closed-ahead', b, forge)).toBe(false);
    expect(called).toBe(false);
  });

  it('returns false when the forge reports no closed PR/MR', () => {
    const b = setupClosedAhead();
    expect(isBranchClosed(repoDir, 'closed-ahead', b, () => false)).toBe(false);
  });

  it('passes the local base branch name and the remote to the forge check', () => {
    setupClosedAhead();
    execSync('git update-ref refs/remotes/upstream/closed-ahead closed-ahead', {
      cwd: repoDir,
    });
    let seen: string[] = [];
    const forge = (
      _r: string,
      _b: string,
      baseLocal: string,
      remote: string,
    ) => {
      seen = [baseLocal, remote];
      return true;
    };
    expect(
      isBranchClosed(repoDir, 'closed-ahead', 'upstream/release/1.x', forge),
    ).toBe(true);
    expect(seen).toEqual(['release/1.x', 'upstream']);
  });

  it('fails closed (false) when the forge check throws', () => {
    const b = setupClosedAhead();
    const forge = () => {
      throw new Error('forge exploded');
    };
    expect(isBranchClosed(repoDir, 'closed-ahead', b, forge)).toBe(false);
  });
});
