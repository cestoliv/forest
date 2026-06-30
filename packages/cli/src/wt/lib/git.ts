// src/lib/git.ts
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { hasMergedPullRequest } from './forge.js';

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
  const realCwd = realpathSync(cwd);
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

/** Whether a remote-tracking ref `refs/remotes/<remote>/<branch>` exists — i.e.
 * the branch was pushed (and not pruned locally; `wt`'s fetch never `--prune`s,
 * so this stays true for a branch whose remote was deleted after merge). A
 * purely-local branch that was never pushed cannot have a merged PR/MR. */
function hasRemoteTrackingRef(
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
 * Whether `branch` has been merged into `baseBranch`. Detected in three tiers,
 * stopping at the first that decides:
 *
 * 1. Squash / rebase-merge — patch id via `git cherry <base> <branch>`: the
 *    branch has ≥1 commit and every one already has a patch-equivalent in base.
 *    This is offline, fast, and has no false positives (a branch with no commits
 *    of its own, e.g. a worktree holding only uncommitted work, produces no
 *    `git cherry` output and is not flagged).
 *
 * 2. Ambiguous fast-forward / merge-commit — the branch tip is an ancestor of
 *    base and strictly behind it (tip ≠ base tip), so its commits live verbatim
 *    in base. Git cannot tell this apart from a worktree whose only work is
 *    uncommitted and whose base has since advanced — both are 0 commits ahead.
 *    The merged PR/MR on the forge is the only reliable signal, so `forgeCheck`
 *    (gh/glab) decides — but only for branches that were actually pushed (a
 *    remote-tracking ref exists); a purely-local branch cannot have a merged
 *    PR/MR, so the (network) forge call is skipped. A worktree sitting exactly
 *    on base (tip = base tip) is never even queried — no committed work.
 *
 * 3. Otherwise → not merged.
 *
 * `forgeCheck` is injectable for testing (default: real `gh`/`glab` lookup) and
 * itself fails closed, so an unavailable/offline forge yields "not merged".
 * Fails closed overall: any error (missing base ref, unknown branch) → false,
 * so callers never wipe on uncertainty.
 */
export function isBranchMerged(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  forgeCheck: (
    repoRoot: string,
    branch: string,
    remote: string,
  ) => boolean = hasMergedPullRequest,
): boolean {
  try {
    // Tier 1: `git cherry <upstream=base> <head=branch>`: '+' = commit only on
    // the branch (unmerged), '-' = a patch-equivalent exists in base. This also
    // validates the base ref — a bad base makes `git cherry` throw → false.
    const out = execFileSync('git', ['cherry', baseBranch, branch], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const lines = out.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0 && lines.every((l) => l.startsWith('-'))) return true;

    // Tier 2: ambiguous fast-forward / merge-commit. Resolve tips lazily — only
    // needed here, never when tier 1 already decided.
    const revParse = (ref: string): string =>
      execFileSync('git', ['rev-parse', ref], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    if (revParse(branch) === revParse(baseBranch)) return false;
    if (!isAncestor(repoRoot, branch, baseBranch)) return false;

    // `base_branch` is conventionally `<remote>/<branch>` (e.g. origin/main).
    const remote = baseBranch.includes('/')
      ? baseBranch.split('/', 1)[0]
      : 'origin';
    // Skip the forge lookup for never-pushed branches — the common stale
    // fresh-worktree case — since they cannot have a merged PR/MR.
    if (!hasRemoteTrackingRef(repoRoot, remote, branch)) return false;
    return forgeCheck(repoRoot, branch, remote);
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
