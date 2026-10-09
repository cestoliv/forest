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
// Everything fails closed (no PR data) so callers never offer a worktree for
// pruning on uncertainty (missing CLI, offline, unpushed branch, no PR/MR).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
 * argv for listing *every* PR/MR whose source/head branch is `branch` **and**
 * whose target branch is `baseBranch` (a local branch name, e.g. `main`).
 *
 * The target filter matters: callers ask "is this branch merged into *my* base?"
 * and do no git ancestry check, so without `--base`/`--target-branch` a branch
 * merged into `develop` would be reported as merged into `main`.
 *
 * Deliberately unfiltered by state (`--state all` / `--all`): one query answers
 * "merged?", "closed with no open PR?", and fills the prune card. A closed PR
 * only means "this branch is dead" if no PR from the same head is *still open*,
 * and one call either answers both or throws, so a half-answer can never read
 * as "no open PR".
 */
export function buildPullRequestQuery(
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
      'number,title,url,state,mergedAt,closedAt',
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

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  /** When it was merged or closed (ISO 8601); absent while open. */
  endedAt?: string;
}

export interface PullRequests {
  /** At least one PR/MR was merged into base. */
  merged: boolean;
  /** At least one PR/MR was closed unmerged, and none is still open. */
  closed: boolean;
  /** The most recent PR/MR, for display. */
  latest?: PullRequest;
}

/**
 * Parse the CLI's JSON output (every PR/MR for this head → base, gh or glab
 * fields) into the prune signals, or `null` when the output is unreadable.
 *
 * States compare case-insensitively (gh shouts, glab whispers):
 * - `MERGED`/`merged` → `merged`. gh models merged as a kind of closed, so it is
 *   never read as closed-unmerged.
 * - `OPEN`/`opened` vetoes `closed`. Closing a PR and opening a fresh one from
 *   the same branch is routine, and the stale closed PR must not then read as a
 *   death notice for a branch still in flight.
 *
 * Both CLIs list newest first, so `latest` is the first entry.
 */
export function parsePullRequests(stdout: string): PullRequests | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const prs: PullRequest[] = data.map((x) => {
    const raw = String(x?.state).toUpperCase();
    // `OPENED` (glab) shares the `OPEN` (gh) prefix; no other state has it.
    const state = raw.startsWith('OPEN')
      ? 'open'
      : raw === 'MERGED'
        ? 'merged'
        : raw === 'CLOSED'
          ? 'closed'
          : undefined;
    return {
      number: Number(x?.number ?? x?.iid),
      title: String(x?.title ?? ''),
      url: String(x?.url ?? x?.web_url ?? ''),
      // An unknown state (glab `locked`) is neither open nor ended: keep it out
      // of both signals by reading it as open, which only vetoes.
      state: state ?? 'open',
      endedAt:
        x?.mergedAt || x?.merged_at || x?.closedAt || x?.closed_at || undefined,
    };
  });
  const states = prs.map((p) => p.state);
  return {
    merged: states.includes('merged'),
    closed: !states.includes('open') && states.includes('closed'),
    latest: prs[0],
  };
}

/** Injectable side-effects, so the pure decision logic can be unit-tested. */
export interface ForgeRunner {
  remoteUrl(repoRoot: string, remote: string): Promise<string>;
  query(repoRoot: string, tool: ForgeTool, args: string[]): Promise<string>;
}

const execFileAsync = promisify(execFile);

const defaultRunner: ForgeRunner = {
  async remoteUrl(repoRoot, remote) {
    const { stdout } = await execFileAsync(
      'git',
      ['remote', 'get-url', remote],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    return stdout.trim();
  },
  async query(repoRoot, tool, args) {
    const { stdout } = await execFileAsync(tool, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
    });
    return stdout;
  },
};

/**
 * Every PR/MR from `branch` **into `baseBranch`** on the forge backing
 * `remote`, folded into the prune signals (see `parsePullRequests`).
 * `baseBranch` is the local branch name (`main`, not `origin/main`) — it
 * becomes the PR/MR target filter. Resolves the remote URL → host → CLI and
 * queries it. Fails closed (`null`, "no PR data") on any error: missing CLI,
 * offline, not authenticated, unparseable remote or output.
 *
 * The match is by branch *name*, so in the rare case a branch is merged then
 * deleted and a brand-new branch of the same name is later created, the old
 * merged PR/MR still matches. `wt prune`'s per-branch (and dirty force-) confirm
 * prompts are the backstop against that.
 */
export async function fetchPullRequests(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  remote = 'origin',
  runner: ForgeRunner = defaultRunner,
): Promise<PullRequests | null> {
  try {
    const tool = selectForgeTool(
      parseRemoteHost(await runner.remoteUrl(repoRoot, remote)),
    );
    if (!tool) return null;
    return parsePullRequests(
      await runner.query(
        repoRoot,
        tool,
        buildPullRequestQuery(tool, branch, baseBranch),
      ),
    );
  } catch {
    return null;
  }
}

/**
 * argv for listing the *open* PRs/MRs whose head is `branch` and whose target
 * is `baseBranch`. glab lists only open MRs by default.
 */
export function buildOpenQuery(
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
      'open',
      '--json',
      'number',
    ];
  }
  return [
    'mr',
    'list',
    '--source-branch',
    branch,
    '--target-branch',
    baseBranch,
    '-F',
    'json',
  ];
}

/**
 * Parse the CLI's JSON output → the first open PR/MR number (gh `number`,
 * glab `iid`), or `undefined` when there is none or the output is unreadable.
 */
export function parseOpenResult(stdout: string): number | undefined {
  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data) || data.length === 0) return undefined;
    const n = Number(data[0]?.number ?? data[0]?.iid);
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The number of an open PR/MR from `branch` into `baseBranch`, or `undefined`.
 * Only explains why `wt prune <branch>` does not flag a branch, so it fails
 * quietly (`undefined`) on any error, like the other forge lookups.
 */
export async function findOpenPullRequest(
  repoRoot: string,
  branch: string,
  baseBranch: string,
  remote = 'origin',
  runner: ForgeRunner = defaultRunner,
): Promise<number | undefined> {
  try {
    const tool = selectForgeTool(
      parseRemoteHost(await runner.remoteUrl(repoRoot, remote)),
    );
    if (!tool) return undefined;
    return parseOpenResult(
      await runner.query(
        repoRoot,
        tool,
        buildOpenQuery(tool, branch, baseBranch),
      ),
    );
  } catch {
    return undefined;
  }
}
