// src/lib/forge.ts
//
// Forge (GitHub / GitLab) merge detection. A merged pull request / merge
// request is the only unambiguous "this branch is merged" signal — git history
// alone cannot tell a fast-forward/merge-commit-merged branch (0 commits ahead,
// tip is an ancestor of base) apart from a brand-new branch that only has
// uncommitted work and whose base has since advanced. Both look identical.
//
// We shell out to the already-authenticated `gh` / `glab` CLIs (rather than
// raw REST + token plumbing): they auto-detect the host from the repo's remote,
// which transparently covers github.com, gitlab.com, and self-hosted GitLab.
// Everything fails closed (`false`) so callers never offer a worktree for
// pruning on uncertainty (missing CLI, offline, unpushed branch, no PR/MR).

import { execFileSync } from 'node:child_process';

export type ForgeTool = 'gh' | 'glab';

/**
 * Extract the host from a git remote URL. Handles scp-like syntax
 * (`git@host:owner/repo.git`), and `ssh://`, `https://`, `git://` URLs
 * (optionally with `user@` and `:port`). Returns the lowercased host, or
 * `null` if it can't be parsed.
 */
export function parseRemoteHost(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  // scp-like: [user@]host:path — no scheme, host ends at the first colon.
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)/);
  if (scp) return scp[1].toLowerCase();
  // scheme://[user@]host[:port]/path
  const schemed = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/i);
  if (schemed) return schemed[1].toLowerCase();
  return null;
}

/**
 * Pick the forge CLI for a host: GitHub (`github.com`, a `github.*` Enterprise
 * host, or a `*.github.com` subdomain) → `gh`; everything else → `glab`. `glab`
 * auto-detects gitlab.com and self-hosted GitLab from the repo remote, so a
 * hostname allowlist is unnecessary. The `github.`-prefix test (rather than a
 * bare `includes('github')`) avoids misrouting hosts like `gitlab.github.io` /
 * `gitlab.githubcorp.com` to `gh`. Returns `null` for an unparseable host.
 */
export function selectForgeTool(host: string | null): ForgeTool | null {
  if (!host) return null;
  if (host.startsWith('github.') || host.endsWith('.github.com')) return 'gh';
  return 'glab';
}

/** argv for listing *merged* PRs/MRs whose source/head branch is `branch`. */
export function buildMergedQuery(tool: ForgeTool, branch: string): string[] {
  if (tool === 'gh') {
    return [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'merged',
      '--json',
      'number',
    ];
  }
  return ['mr', 'list', '--merged', '--source-branch', branch, '-F', 'json'];
}

/**
 * Parse the CLI's JSON output → `true` when at least one merged PR/MR is
 * present. Both `gh --json` and `glab -F json` emit a JSON array. Any non-array
 * / unparseable output → `false`.
 */
export function parseMergedResult(stdout: string): boolean {
  try {
    const data = JSON.parse(stdout);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Injectable side-effects, so the pure decision logic can be unit-tested. */
export interface ForgeRunner {
  remoteUrl(repoRoot: string, remote: string): string;
  query(repoRoot: string, tool: ForgeTool, args: string[]): string;
}

const defaultRunner: ForgeRunner = {
  remoteUrl(repoRoot, remote) {
    return execFileSync('git', ['remote', 'get-url', remote], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  },
  query(repoRoot, tool, args) {
    return execFileSync(tool, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    });
  },
};

/**
 * Whether `branch` has a *merged* pull request / merge request on the forge
 * backing `remote`. Resolves the remote URL → host → CLI, queries it, and
 * returns whether any merged PR/MR exists. Fails closed (`false`) on any error:
 * missing CLI, offline, not authenticated, unparseable remote, or no result.
 *
 * The match is by branch *name*, so in the rare case a branch is merged then
 * deleted and a brand-new branch of the same name is later created, the old
 * merged PR/MR still matches. `wt prune`'s per-branch (and dirty force-) confirm
 * prompts are the backstop against that.
 */
export function hasMergedPullRequest(
  repoRoot: string,
  branch: string,
  remote = 'origin',
  runner: ForgeRunner = defaultRunner,
): boolean {
  try {
    const tool = selectForgeTool(
      parseRemoteHost(runner.remoteUrl(repoRoot, remote)),
    );
    if (!tool) return false;
    return parseMergedResult(
      runner.query(repoRoot, tool, buildMergedQuery(tool, branch)),
    );
  } catch {
    return false;
  }
}
