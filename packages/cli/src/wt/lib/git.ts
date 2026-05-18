// src/lib/git.ts
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export interface Worktree {
  path: string;
  branch: string;
  isCurrent: boolean;
  repoRoot: string;
  lastCommit?: string;
}

export function getRepoRoot(cwd = process.cwd()): string {
  try {
    // Resolve symlinks on cwd so git's output matches the input path on macOS
    // (where /var/folders is a symlink to /private/var/folders)
    const realCwd = realpathSync(cwd);
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: realCwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
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
    .map((block) => {
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
  execFileSync(
    'git',
    ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath],
    { cwd: repoRoot, stdio: 'pipe' },
  );
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
