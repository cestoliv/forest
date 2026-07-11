// src/lib/git.ts
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { hasClosedPullRequest, hasMergedPullRequest } from './forge.js';

export interface Worktree {
  path: string;
  branch: string;
  isCurrent: boolean;
  /** The main worktree (first entry of `git worktree list`) — cannot be removed. */
  isMain: boolean;
  repoRoot: string;
  lastCommit?: string;
}

export function getRepoRoot(cwd = process.cwd()): string {
  try {
    // Resolve symlinks on cwd so git's output matches the input path on macOS
    // (where /var/folders is a symlink to /private/var/folders)
    const realCwd = realpathSync(cwd);
    // The main worktree is always the first entry of `git worktree list`.
    // `git rev-parse --show-toplevel` returns the *current* worktree instead,
    // so running inside a linked worktree would register that worktree as a
    // separate repo. Resolving to the main worktree keeps the repo identity
    // stable across all of its worktrees.
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: realCwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const firstLine = output.trim().split('\n')[0];
    return realpathSync(firstLine.slice('worktree '.length));
  } catch {
    throw new Error('Not in a git repository');
  }
}

export function listWorktrees(
  repoRoot: string,
  cwd = process.cwd(),
): Worktree[] {
  // Resolve symlinks so paths are consistent with git's canonical output
  const realRepoRoot = realpathSync(repoRoot);
  // `cwd` may no longer exist — e.g. the user just pruned the worktree they were
  // standing in, and the TUI auto-refresh re-runs with that captured, now-gone
  // path. Fall back to the raw value instead of throwing: a deleted cwd is no
  // longer in `git worktree list`, so it simply matches nothing and marks
  // nothing `isCurrent` (correct), rather than emptying the whole list.
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: realRepoRoot,
    encoding: 'utf8',
  });
  const worktrees = parseWorktreeList(output, realRepoRoot, realCwd);

  // Batch-fetch all last commit messages in a single shell invocation
  const script = worktrees
    .map(
      (wt) =>
        `(cd ${JSON.stringify(wt.path)} 2>/dev/null && git log -1 --format='%s' 2>/dev/null) || echo ''`,
    )
    .join('; echo "---SEP---"; ');

  let commits: string[] = [];
  try {
    const batchOutput = execFileSync('sh', ['-c', script], {
      encoding: 'utf8',
      timeout: 8000,
    });
    commits = batchOutput.split('---SEP---').map((s) => s.trim());
  } catch {
    // fallback: all empty
  }

  return worktrees.map((wt, i) => ({
    ...wt,
    lastCommit: commits[i] ?? '',
  }));
}

export function parseWorktreeList(
  output: string,
  repoRoot: string,
  cwd: string,
): Worktree[] {
  return output
    .trim()
    .split('\n\n')
    .map((block, index) => {
      const lines = block.trim().split('\n');
      const wtPath = lines[0].slice('worktree '.length);
      const branchLine = lines.find((l) => l.startsWith('branch '));
      const branch = branchLine
        ? branchLine.replace('branch refs/heads/', '')
        : '(detached)';
      return {
        path: wtPath,
        branch,
        isCurrent: cwd === wtPath || cwd.startsWith(wtPath + path.sep),
        // The main worktree is always the first entry of `git worktree list`.
        isMain: index === 0,
        repoRoot,
      };
    });
}

export function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
): void {
  if (baseBranch) {
    execFileSync(
      'git',
      ['worktree', 'add', '-b', branch, worktreePath, baseBranch],
      {
        cwd: repoRoot,
      },
    );
  } else {
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoRoot,
    });
  }
}

export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force = false,
): void {
  // Hard backstop: never remove the main worktree. `git worktree remove`
  // refuses to, but the force fallback below would `rmSync` the directory and
  // wipe the primary repo. Resolve symlinks so the comparison is canonical;
  // fall back to the raw paths if either no longer exists on disk.
  const resolve = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (resolve(worktreePath) === resolve(repoRoot)) {
    throw new Error('Refusing to remove the main worktree');
  }

  try {
    execFileSync(
      'git',
      ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath],
      { cwd: repoRoot, stdio: 'pipe' },
    );
  } catch (err) {
    if (!force) throw err;

    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    execFileSync('git', ['worktree', 'prune'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  }
}

export function listWorktreeDirtyFiles(worktreePath: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--short'], {
      cwd: worktreePath,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Whether the worktree has no uncommitted work at all — no modified tracked
 * files and no untracked ones (`git status --porcelain` prints nothing). An
 * untracked-only worktree still holds the user's work, so it counts as dirty.
 *
 * Unlike `listWorktreeDirtyFiles` (which returns `[]` on error, reading a broken
 * path as "clean"), this **fails closed**: any error → `false`. It gates a
 * delete decision, so uncertainty must never mean "safe to remove".
 */
export function isWorktreeClean(worktreePath: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

export function branchExists(repoRoot: string, branch: string): boolean {
  try {
    const local = execFileSync('git', ['branch', '--list', branch], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    if (local) return true;
    const remote = execFileSync(
      'git',
      ['ls-remote', '--heads', 'origin', branch],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 8000,
      },
    ).trim();
    return remote.length > 0;
  } catch {
    return false;
  }
}

/** Whether `ancestor` is an ancestor of `descendant` (`git merge-base
 * --is-ancestor`, exit 0 = yes). Any non-zero exit / error → false. */
function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Split a `base_branch` config value into its remote and local branch names:
 * `origin/main` → `{ remote: 'origin', branch: 'main' }`, and
 * `origin/feature/nested` → `{ remote: 'origin', branch: 'feature/nested' }`
 * (only the leading `<remote>/` is stripped). A value with no slash is taken as
 * a local branch on `origin`: `main` → `{ remote: 'origin', branch: 'main' }`.
 *
 * The local name is what the forge wants as a PR/MR target filter; the remote
 * name is what `hasRemoteTrackingRef` and the forge CLIs want.
 */
export function splitBaseRef(baseBranch: string): {
  remote: string;
  branch: string;
} {
  const slash = baseBranch.indexOf('/');
  if (slash === -1) return { remote: 'origin', branch: baseBranch };
  return {
    remote: baseBranch.slice(0, slash),
    branch: baseBranch.slice(slash + 1),
  };
}

/**
 * Whether a remote-tracking ref `refs/remotes/<remote>/<branch>` exists — i.e.
 * the branch was pushed and the ref is still present locally. A purely-local
 * branch that was never pushed cannot have a PR/MR, so this gates the forge
 * lookups.
 *
 * Caveat: `fetchRemote` runs a plain `git fetch <remote>`, which **honours the
 * user's `fetch.prune` / `remote.<name>.prune` gitconfig**. With `fetch.prune =
 * true` and a forge that auto-deletes the head branch on merge, this ref is gone
 * by the time prune runs, so every signal gated on it (the clean+pushed offline
 * path, `isBranchMergedOnForge`, `isBranchClosed`) silently reports `false` and
 * the merged worktree is not offered. That fails closed — nothing unsafe — but
 * it does mean prune can under-report for users with pruning fetches.
 */
export function hasRemoteTrackingRef(
  repoRoot: string,
  remote: string,
  branch: string,
): boolean {
  try {
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`],
      { cwd: repoRoot, stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The non-empty lines of `git cherry <base> <branch>`: one per commit reachable
 * from `branch` but not from `base`, prefixed `-` when an equivalent patch
 * already exists in base and `+` when it does not. An empty array means the
 * branch adds no commits at all.
 *
 * **Throws** on any git error (a bad base ref, an unknown branch). Callers must
 * catch and fail closed — never let a failure read as an empty (i.e. "nothing
 * unique") result.
 */
function cherryLines(
  repoRoot: string,
  branch: string,
  baseBranch: string,
): string[] {
  const out = execFileSync('git', ['cherry', baseBranch, branch], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return out.split('\n').filter((l) => l.trim().length > 0);
}

/**
 * Whether git alone can prove `branch` was merged into `baseBranch`, by patch
 * id: the branch has ≥1 commit of its own and every one already has a
 * patch-equivalent in base. That covers **squash** and **rebase** merges whose
 * replayed commits kept the same diff.
 *
 * This is offline, fast, and has no false positives: a branch with no commits of
 * its own (a fresh worktree, a fast-forward merge) produces no `git cherry`
 * output and is not flagged. It is also, deliberately, the *only* thing this
 * function knows — a branch merged by fast-forward, by a merge commit, or by a
 * squash that GitHub rebased onto a newer base (different patch id) is invisible
 * here. Those cases are decided by `hasNoUniqueCommits` and
 * `isBranchMergedOnForge` in the prune predicate, which have the extra context
 * (the worktree's dirty state, the forge) that this branch-level view lacks.
 *
 * Fails closed: any error (missing base ref, unknown branch) → false, so callers
 * never wipe on uncertainty.
 */
export function isBranchMerged(
  repoRoot: string,
  branch: string,
  baseBranch: string,
): boolean {
  try {
    const lines = cherryLines(repoRoot, branch, baseBranch);
    return lines.length > 0 && lines.every((l) => l.startsWith('-'));
  } catch {
    return false;
  }
}

/**
 * Whether `branch` carries no commits that base doesn't already have: `git
 * cherry` emits nothing *and* the tip is an ancestor of base. True for a branch
 * merged by fast-forward or by a merge commit, for a branch sitting exactly on
 * base's tip, and for a fresh worktree whose only work is uncommitted — git
 * cannot tell those apart at the branch level.
 *
 * So this is **not** on its own a "merged" signal. Callers must combine it with
 * context git doesn't have — see `buildPrunePredicate`, which additionally
 * requires the worktree to be clean (no uncommitted work to lose) and the branch
 * to have been pushed.
 *
 * The `isAncestor` conjunct is redundant in practice — a branch with no unique
 * commits is necessarily an ancestor of base — and is kept as a cheap,
 * independent second opinion: it holds the line if `git cherry`'s silence ever
 * means something other than "nothing of its own". Fails closed (`false`) on any
 * error, so a bad base ref can never make it true.
 */
export function hasNoUniqueCommits(
  repoRoot: string,
  branch: string,
  baseBranch: string,
): boolean {
  try {
    if (cherryLines(repoRoot, branch, baseBranch).length > 0) return false;
    return isAncestor(repoRoot, branch, baseBranch);
  } catch {
    return false;
  }
}

/**
 * Whether the forge (GitHub/GitLab) reports a **merged** PR/MR for `branch`.
 *
 * The forge is the only witness for a merge git cannot see: a squash that the
 * forge rebased onto a newer base gets a patch id that matches neither the
 * branch's commits nor an ancestry relation, and the branch stays *ahead* of
 * base. `isBranchMerged` and `hasNoUniqueCommits` are both false for it.
 *
 * Structurally identical to `isBranchClosed`: no git topology checks at all, and
 * the only git-side guard is the pushed-branch check — a purely-local branch
 * cannot have a PR/MR, so the (network) forge call is skipped. Because there is
 * no ancestry check, the PR/MR must be filtered to those *targeting* base, which
 * is why `baseBranch`'s local name is threaded through to `forgeCheck` — without
 * it, a branch merged into `develop` would count as merged into `main`.
 * `forgeCheck` is injectable for testing and itself fails closed; any error →
 * false.
 */
export function isBranchMergedOnForge(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  forgeCheck: (
    repoRoot: string,
    branch: string,
    baseBranch: string,
    remote: string,
  ) => boolean = hasMergedPullRequest,
): boolean {
  try {
    const { remote, branch: baseLocal } = splitBaseRef(baseBranch);
    if (!hasRemoteTrackingRef(repoRoot, remote, branch)) return false;
    return forgeCheck(repoRoot, branch, baseLocal, remote);
  } catch {
    return false;
  }
}

/**
 * Whether `branch`'s pull request / merge request was *closed without merging*
 * — the fix landed some other way, so the branch is dead and safe to prune.
 *
 * Unlike `isBranchMerged`, this does **no** git topology checks at all (no
 * `git cherry`, no ancestry, no tip comparison): a closed PR says nothing about
 * whether the branch is an ancestor of base, so this can legitimately prune a
 * branch that is *ahead* of base. The only git-side guard is the same
 * pushed-branch check `isBranchMergedOnForge` uses — a purely-local branch that
 * was never pushed cannot have a PR/MR, so the (network) forge call is skipped.
 * As there, `baseBranch`'s local name is threaded through to `forgeCheck` so the
 * PR/MR is filtered to those targeting base.
 *
 * `forgeCheck` is injectable for testing (default: real `gh`/`glab` lookup) and
 * itself fails closed, so an unavailable/offline forge yields "not closed".
 * Fails closed overall: any error → false, so callers never wipe on uncertainty.
 */
export function isBranchClosed(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  forgeCheck: (
    repoRoot: string,
    branch: string,
    baseBranch: string,
    remote: string,
  ) => boolean = hasClosedPullRequest,
): boolean {
  try {
    const { remote, branch: baseLocal } = splitBaseRef(baseBranch);
    // A never-pushed branch (no remote-tracking ref) cannot have a PR/MR, so
    // skip the network call — the common stale fresh-worktree case.
    if (!hasRemoteTrackingRef(repoRoot, remote, branch)) return false;
    return forgeCheck(repoRoot, branch, baseLocal, remote);
  } catch {
    return false;
  }
}

export function setUpstreamTracking(
  worktreePath: string,
  branch: string,
  remote = 'origin',
): void {
  try {
    execFileSync(
      'git',
      ['branch', '--set-upstream-to', `${remote}/${branch}`, branch],
      { cwd: worktreePath, stdio: 'pipe' },
    );
  } catch {
    // Silently ignore — the remote branch may not exist yet for new branches.
  }
}

export function fetchRemote(repoRoot: string, remote = 'origin'): void {
  execFileSync('git', ['fetch', remote], {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 30000,
  });
}

/**
 * Fast-forward the worktree's current branch to its upstream (`git pull
 * --ff-only`). Used after prune removes merged worktrees so the main worktree
 * picks up the merged changes.
 *
 * Unlike the fail-closed query helpers, this **throws on failure** so the caller
 * can surface git's message. `--ff-only` is deliberate: it never fabricates a
 * merge commit or a conflict in the primary checkout — it either fast-forwards
 * cleanly or refuses.
 */
export function pullFfOnly(worktreePath: string): void {
  execFileSync('git', ['pull', '--ff-only'], {
    cwd: worktreePath,
    stdio: 'pipe',
    timeout: 30000,
  });
}

/**
 * Whether `repoRoot` has a git remote named `remote`. Used to skip (and warn
 * about) fetching in local-only repos that have no remote configured. Fails
 * closed (`false`) on any error.
 */
export function remoteExists(repoRoot: string, remote = 'origin'): boolean {
  try {
    const out = execFileSync('git', ['remote'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return out.split('\n').some((line) => line.trim() === remote);
  } catch {
    return false;
  }
}

export function resolveWorktreePath(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): string {
  const repoName = path.basename(repoRoot);
  // Sanitize branch: replace slashes with dashes to prevent directory traversal
  const safeBranch = branch.replace(/\//g, '-');
  const resolved = path.resolve(
    repoRoot,
    worktreePath,
    `${repoName}-${safeBranch}`,
  );
  const expectedParent = path.resolve(repoRoot, worktreePath);
  if (
    !resolved.startsWith(expectedParent + path.sep) &&
    resolved !== expectedParent
  ) {
    throw new Error(
      `Branch name "${branch}" would resolve outside the expected worktree directory`,
    );
  }
  return resolved;
}
