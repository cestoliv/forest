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

/**
 * argv for listing *merged* PRs/MRs whose source/head branch is `branch` **and**
 * whose target branch is `baseBranch` (a local branch name, e.g. `main`).
 *
 * The target filter matters: callers ask "is this branch merged into *my* base?"
 * and do no git ancestry check, so without `--base`/`--target-branch` a branch
 * merged into `develop` would be reported as merged into `main`.
 */
export function buildMergedQuery(
  tool: ForgeTool,
  branch: string,
  baseBranch: string,
): string[] {
  if (tool === 'gh') {
    return [
      'pr',
      'list',
      '--head',
      branch,
      '--base',
      baseBranch,
      '--state',
      'merged',
      '--json',
      'number',
    ];
  }
  return [
    'mr',
    'list',
    '--merged',
    '--source-branch',
    branch,
    '--target-branch',
    baseBranch,
    '-F',
    'json',
  ];
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

/**
 * argv for listing *every* PR/MR whose source/head branch is `branch` and whose
 * target branch is `baseBranch` (see `buildMergedQuery` for why the target
 * filter is required).
 *
 * Deliberately unfiltered by state (`--state all` / `--all`) even though the
 * caller only asks about closed ones: a closed PR only means "this branch is
 * dead" if no PR from the same head is *still open*, so the decision needs both
 * facts. Asking for them in one query (rather than a closed query plus an open
 * one) keeps them consistent and keeps the failure mode simple — one call
 * either answers or throws, so a half-answer can never read as "no open PR".
 * `parseClosedResult` does the filtering.
 */
export function buildClosedQuery(
  tool: ForgeTool,
  branch: string,
  baseBranch: string,
): string[] {
  if (tool === 'gh') {
    return [
      'pr',
      'list',
      '--head',
      branch,
      '--base',
      baseBranch,
      '--state',
      'all',
      '--json',
      'state',
    ];
  }
  return [
    'mr',
    'list',
    '--all',
    '--source-branch',
    branch,
    '--target-branch',
    baseBranch,
    '-F',
    'json',
  ];
}

/**
 * Parse the CLI's JSON output (every PR/MR for this head → base, see
 * `buildClosedQuery`) → `true` only when the branch is genuinely dead: at least
 * one *closed-unmerged* PR/MR **and** none still open.
 *
 * Two states must be filtered out, both case-insensitively (gh shouts,
 * glab whispers):
 * - `MERGED`/`merged` — merged is not closed-unmerged. gh in particular models
 *   merged as a kind of closed, so it shows up here regardless.
 * - `OPEN`/`opened` — an open PR vetoes the whole signal. Closing a PR and
 *   opening a fresh one from the same branch is routine (a retarget, a botched
 *   PR, a rewritten description), and the stale closed PR must not then read as
 *   a death notice for a branch that is still in flight.
 *
 * Any non-array / unparseable output → `false`.
 */
export function parseClosedResult(stdout: string): boolean {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return false;
    const states = data.map((x) => String(x?.state).toUpperCase());
    // `OPENED` (glab) shares the `OPEN` (gh) prefix; no other state does.
    if (states.some((s) => s.startsWith('OPEN'))) return false;
    return states.includes('CLOSED');
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
 * Whether `branch` has a *merged* pull request / merge request **into
 * `baseBranch`** on the forge backing `remote`. `baseBranch` is the local branch
 * name (`main`, not `origin/main`) — it becomes the PR/MR target filter, so a
 * branch merged into some other base is not reported here. Resolves the remote
 * URL → host → CLI, queries it, and returns whether any such PR/MR exists. Fails
 * closed (`false`) on any error: missing CLI, offline, not authenticated,
 * unparseable remote, or no result.
 *
 * The match is by branch *name*, so in the rare case a branch is merged then
 * deleted and a brand-new branch of the same name is later created, the old
 * merged PR/MR still matches. `wt prune`'s per-branch (and dirty force-) confirm
 * prompts are the backstop against that.
 */
export function hasMergedPullRequest(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  remote = 'origin',
  runner: ForgeRunner = defaultRunner,
): boolean {
  try {
    const tool = selectForgeTool(
      parseRemoteHost(runner.remoteUrl(repoRoot, remote)),
    );
    if (!tool) return false;
    return parseMergedResult(
      runner.query(repoRoot, tool, buildMergedQuery(tool, branch, baseBranch)),
    );
  } catch {
    return false;
  }
}

/**
 * Whether `branch` is *dead* on the forge backing `remote`: it has a
 * closed-unmerged pull request / merge request **targeting `baseBranch`** and
 * no PR/MR from the same head is still open. Parallel to
 * `hasMergedPullRequest`, including the local-name `baseBranch` target filter:
 * resolves the remote URL → host → CLI, queries it, and lets
 * `parseClosedResult` decide. Fails closed (`false`) on any error: missing CLI,
 * offline, not authenticated, unparseable remote, or no result.
 *
 * The open-PR veto is what makes this a "dead branch" signal rather than a
 * "has ever been closed" one: reopening work as a second PR from the same
 * branch is routine, and the query is by branch *name*, so the superseded PR
 * matches just as well as the live one. Without the veto `wt prune` offers a
 * branch that is actively in review.
 *
 * Note this is orthogonal to git topology — a closed PR says nothing about
 * whether the branch is an ancestor of base, so callers must not gate this on
 * ancestry checks. The target-branch filter is what keeps it scoped to the
 * caller's base despite that.
 */
export function hasClosedPullRequest(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  remote = 'origin',
  runner: ForgeRunner = defaultRunner,
): boolean {
  try {
    const tool = selectForgeTool(
      parseRemoteHost(runner.remoteUrl(repoRoot, remote)),
    );
    if (!tool) return false;
    return parseClosedResult(
      runner.query(repoRoot, tool, buildClosedQuery(tool, branch, baseBranch)),
    );
  } catch {
    return false;
  }
}
