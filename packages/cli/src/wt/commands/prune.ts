// src/commands/prune.ts

import path from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
  getGlobalConfig,
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
  /** Prune again every `interval` minutes until Ctrl-C. */
  watch?: boolean;
  /** Minutes between watch passes; defaults to `auto_refresh_minutes`. */
  interval?: number;
  /** Waits between watch passes; resolves false when interrupted. */
  sleep?: (ms: number) => Promise<boolean>;
}

/**
 * Resolves true when the user cancelled a prompt or the spinner. Checks may
 * still be running then, so the caller exits the process.
 */
export async function runPrune(options: PruneOptions = {}): Promise<boolean> {
  const { cwd = process.cwd(), store = createStore(), pull = true } = options;

  if (options.branch !== undefined) {
    if (options.watch) throw new Error('--watch takes no <branch>.');
    await pruneBranch(options.branch, { ...options, cwd, store, pull });
    warnIfCwdRemoved(cwd);
    return false;
  }
  if (options.yes || options.repo) {
    throw new Error('--yes and --repo need a <branch>.');
  }
  if (options.interval !== undefined && !options.watch) {
    throw new Error('--interval needs --watch.');
  }

  const { items } = await prepareListItems({ cwd, store });

  if (items.length === 0) {
    console.log(
      pc.dim(
        'No repos registered. Run `wt create` inside a repo to get started.',
      ),
    );
    return false;
  }

  const pass = async (passItems: Worktree[]) => {
    const { removed, cancelled } = await wipeWorktrees(passItems, store, {
      fetch: true,
      pull,
      quiet: options.watch,
    });
    if (removed.length > 0) {
      console.log(pc.green(`✓ Pruned ${removed.length} worktree(s).`));
    }
    return cancelled;
  };

  let cancelled: boolean;
  if (options.watch) {
    const minutes =
      options.interval ?? getGlobalConfig(store).auto_refresh_minutes;
    if (!(minutes > 0 && Number.isFinite(minutes))) {
      throw new Error(
        `Invalid interval: ${minutes}. Pass a positive number of minutes.`,
      );
    }
    // Each pass lists again, so new worktrees and repos show up.
    cancelled = await watchPrune(
      async () => pass((await prepareListItems({ cwd, store })).items),
      minutes,
      options.sleep,
    );
  } else {
    cancelled = await pass(items);
  }
  if (cancelled) console.log(pc.dim('Prune cancelled.'));

  // Non-interactive exit: if prune removed the worktree this command was run
  // from, the shell is now in a gone directory. Printed here (not inside
  // `wipeWorktrees`, which the TUI `P` also calls) so it lands last, on return
  // to the shell — the TUI covers its own case in `runList`.
  warnIfCwdRemoved(cwd);
  return cancelled;
}

/**
 * Run `pass` (resolves true on a cancel), then wait `minutes`, until a pass
 * is cancelled or the wait is interrupted. Passes never overlap: the wait
 * starts only once a pass has finished, open prompts included. Resolves true
 * when a pass was cancelled.
 */
export async function watchPrune(
  pass: () => Promise<boolean>,
  minutes: number,
  sleep: (ms: number) => Promise<boolean> = sleepUnlessInterrupted,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const ms = minutes * 60_000;
  while (!(await pass())) {
    const at = new Date(now().getTime() + ms).toTimeString().slice(0, 5);
    console.log(
      pc.dim(
        `Watching — next check at ${at} (every ${minutes} min). Ctrl-C to stop.`,
      ),
    );
    if (!(await sleep(ms))) return false;
  }
  return true;
}

/** Wait `ms`. Ctrl-C ends the wait early (false) instead of killing the process. */
function sleepUnlessInterrupted(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onInterrupt = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      process.removeListener('SIGINT', onInterrupt);
      resolve(true);
    }, ms);
    process.once('SIGINT', onInterrupt);
  });
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

  await Promise.all(fetchRepos([target], store).values());
  const match = await buildPrunePredicate(store)(target);
  if (!match) {
    clack.log.warn(
      `${pc.bold(branch)} is not merged or closed: ${(await explainNotFlagged(target, store)).join(', ')}.`,
    );
  }

  const result = await deleteWorktree(target, store, {
    yes: options.yes,
    initialValue: match ? undefined : false,
    details: match ?? undefined,
  });
  if (result === 'removed' && options.pull) {
    await pullMainWorktrees(items, new Set([target.repoRoot]), store);
  }
}

/** Why `buildPrunePredicate` does not flag `wt`, as short phrases. */
async function explainNotFlagged(
  wt: Worktree,
  store: ConfigStore,
): Promise<string[]> {
  const base = getEffectiveConfig(wt.repoRoot, store).base_branch;
  const { remote, branch: baseLocal } = splitBaseRef(base);
  if (wt.branch === base || wt.branch === baseLocal) {
    return [`it is the base branch (${base})`];
  }

  const reasons: string[] = [];
  const unique = await countUniqueCommits(wt.repoRoot, wt.branch, base);
  if (unique) reasons.push(`${unique} unique commit(s) not in ${base}`);
  if (await hasRemoteTrackingRef(wt.repoRoot, remote, wt.branch)) {
    const pr = await findOpenPullRequest(
      wt.repoRoot,
      wt.branch,
      baseLocal,
      remote,
    );
    if (pr !== undefined) reasons.push(`PR #${pr} open`);
  } else {
    reasons.push(`never pushed to ${remote}`);
  }
  if (!isWorktreeClean(wt.path)) reasons.push('uncommitted changes');
  return reasons.length > 0 ? reasons : ['no merge signal found'];
}
