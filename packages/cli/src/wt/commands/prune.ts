// src/commands/prune.ts

import path from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
} from '../lib/config.js';
import { findOpenPullRequest } from '../lib/forge.js';
import {
  countUniqueCommits,
  getRepoRoot,
  hasRemoteTrackingRef,
  isWorktreeClean,
  listWorktrees,
  splitBaseRef,
  type Worktree,
} from '../lib/git.js';
import { isInteractive } from '../lib/interactive.js';
import { runRepoPicker } from '../lib/tui.js';
import {
  buildPrunePredicate,
  deleteWorktree,
  fetchRepos,
  prepareListItems,
  pullMainWorktrees,
  warnIfCwdRemoved,
  wipeWorktrees,
} from './list.js';

export interface PruneOptions {
  cwd?: string;
  store?: ConfigStore;
  pull?: boolean;
  /** Prune only the worktree checked out on this branch. */
  branch?: string;
  /** Repo to look in for `branch`; skips the picker when several repos match. */
  repo?: string;
  /** Answer every confirmation with yes. */
  yes?: boolean;
  repoPicker?: (repos: string[]) => Promise<string | null>;
}

export async function runPrune(options: PruneOptions = {}): Promise<void> {
  const { cwd = process.cwd(), store = createStore(), pull = true } = options;

  if (options.branch !== undefined) {
    await pruneBranch(options.branch, { ...options, cwd, store, pull });
    warnIfCwdRemoved(cwd);
    return;
  }
  if (options.yes || options.repo) {
    throw new Error('--yes and --repo need a <branch>.');
  }

  const { items } = await prepareListItems({ cwd, store });

  if (items.length === 0) {
    console.log(
      pc.dim(
        'No repos registered. Run `wt create` inside a repo to get started.',
      ),
    );
    return;
  }

  const removed = await wipeWorktrees(items, store, { fetch: true, pull });
  if (removed.length > 0) {
    console.log(pc.green(`✓ Pruned ${removed.length} worktree(s).`));
  }

  // Non-interactive exit: if prune removed the worktree this command was run
  // from, the shell is now in a gone directory. Printed here (not inside
  // `wipeWorktrees`, which the TUI `P` also calls) so it lands last, on return
  // to the shell — the TUI covers its own case in `runList`.
  warnIfCwdRemoved(cwd);
}

/**
 * Remove the worktree checked out on `branch`. A worktree the prune predicate
 * flags gets the usual confirmation. Any other worktree gets the reasons it is
 * not flagged and a confirmation that defaults to No. Throws (non-zero exit)
 * when no worktree holds the branch or when it is the main worktree.
 */
async function pruneBranch(
  branch: string,
  options: PruneOptions & { cwd: string; store: ConfigStore; pull: boolean },
): Promise<void> {
  const { cwd, store, repoPicker = runRepoPicker } = options;

  let items: Worktree[];
  if (options.repo) {
    let repoRoot: string;
    try {
      repoRoot = getRepoRoot(path.resolve(cwd, options.repo));
    } catch {
      throw new Error(`${options.repo} is not a git repository`);
    }
    items = listWorktrees(repoRoot, cwd);
  } else {
    ({ items } = await prepareListItems({ cwd, store }));
  }

  const matches = items.filter((wt) => wt.branch === branch);
  if (matches.length === 0) {
    throw new Error(`No worktree is checked out on ${branch}.`);
  }

  let target = matches[0];
  if (matches.length > 1) {
    if (!isInteractive()) {
      throw new Error(
        `Several repos have a worktree on ${branch}. Pass --repo <path> to pick one.`,
      );
    }
    const picked = await repoPicker(matches.map((wt) => wt.repoRoot));
    if (!picked) return;
    target = matches.find((wt) => wt.repoRoot === picked) ?? target;
  }

  if (target.isMain) {
    throw new Error(
      `${branch} is checked out in the main worktree of ${path.basename(target.repoRoot)}. wt never removes it.`,
    );
  }

  fetchRepos([target], store);
  const flagged = buildPrunePredicate(store)(target);
  if (!flagged) {
    clack.log.warn(
      `${pc.bold(branch)} is not merged or closed: ${explainNotFlagged(target, store).join(', ')}.`,
    );
  }

  const removed = await deleteWorktree(target, store, {
    yes: options.yes,
    initialValue: flagged ? undefined : false,
  });
  if (removed && options.pull) {
    await pullMainWorktrees(items, new Set([target.repoRoot]), store);
  }
}

/** Why `buildPrunePredicate` does not flag `wt`, as short phrases. */
function explainNotFlagged(wt: Worktree, store: ConfigStore): string[] {
  const base = getEffectiveConfig(wt.repoRoot, store).base_branch;
  const { remote, branch: baseLocal } = splitBaseRef(base);
  if (wt.branch === base || wt.branch === baseLocal) {
    return [`it is the base branch (${base})`];
  }

  const reasons: string[] = [];
  const unique = countUniqueCommits(wt.repoRoot, wt.branch, base);
  if (unique) reasons.push(`${unique} unique commit(s) not in ${base}`);
  if (hasRemoteTrackingRef(wt.repoRoot, remote, wt.branch)) {
    const pr = findOpenPullRequest(wt.repoRoot, wt.branch, baseLocal, remote);
    if (pr !== undefined) reasons.push(`PR #${pr} open`);
  } else {
    reasons.push(`never pushed to ${remote}`);
  }
  if (!isWorktreeClean(wt.path)) reasons.push('uncommitted changes');
  return reasons.length > 0 ? reasons : ['no merge signal found'];
}
