import { execFileSync } from 'node:child_process';
import type { AgentSpawnerConfig } from './config.js';

/**
 * The branch of every worktree a repo currently holds, so a worktree you
 * created by hand is in the list too. Two kinds of entry are not: the first
 * one, the main checkout, which is the repo itself rather than a spawned
 * workspace, and any entry git flags `prunable`, whose directory is already
 * gone. A detached worktree still occupies a slot, and contributes an empty
 * string, which matches no branch name the daemon builds.
 *
 * One `git worktree list` answers both questions a cap asks: how many
 * worktrees a repo holds, and whether one of them is already the branch a task
 * would use.
 */
export function listWorktreeBranches(repoPath: string): string[] {
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return output
      .trim()
      .split('\n\n')
      .filter((block, i) => i > 0 && !/^prunable/m.test(block))
      .map(
        (block) =>
          block
            .split('\n')
            .find((line) => line.startsWith('branch '))
            ?.replace('branch refs/heads/', '') ?? '',
      );
  } catch {
    // A path that is not a readable repo holds nothing, so a typo in a rule
    // never wedges the daemon behind a cap it cannot measure.
    return [];
  }
}

/**
 * Return why `repoPath` cannot take another worktree for `branch`, or null when
 * it can. Checks the repo's own cap first, then the global one, which sums
 * every repo the routing rules point at. A cap of 0 (or an absent per-repo
 * entry) means unlimited.
 *
 * `branches` is called once per repo path, so pass a memoised reader when one
 * tick asks about several tasks (`runTick` does).
 */
export function checkCapacity(
  config: AgentSpawnerConfig,
  repoPath: string,
  branch: string,
  branches: (repoPath: string) => string[] = listWorktreeBranches,
): string | null {
  const here = branches(repoPath);
  // A branch that already has a worktree adds none: `wt agent` reuses it (see
  // `promptExistingWorktree`). No cap may hold that task, or a retry after an
  // "Agent Error" would stall for good once the repo is full.
  if (here.includes(branch)) return null;

  const repoCap = config.maxWorktreesPerRepo[repoPath] ?? 0;
  if (repoCap > 0 && here.length >= repoCap) {
    return `repo at cap (${here.length}/${repoCap})`;
  }

  if (config.maxWorktrees > 0) {
    const paths = [...new Set(config.rules.map((rule) => rule.path))];
    const used = paths.reduce((total, p) => total + branches(p).length, 0);
    if (used >= config.maxWorktrees) {
      return `global cap reached (${used}/${config.maxWorktrees})`;
    }
  }

  return null;
}
