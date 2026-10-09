// src/commands/list.ts

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
  getGlobalConfig,
} from '../lib/config.js';
import { fetchPullRequests, type PullRequests } from '../lib/forge.js';
import {
  countCommitsAhead,
  countDirtyFiles,
  fetchRemoteAsync,
  getRepoRoot,
  hasNoUniqueCommits,
  hasRemoteTrackingRef,
  isBranchMerged,
  isWorktreeClean,
  lastCommitAge,
  listWorktreeDirtyFiles,
  listWorktrees,
  pullFfOnly,
  remoteExists,
  removeWorktree,
  splitBaseRef,
  type Worktree,
} from '../lib/git.js';
import { openIde } from '../lib/ide.js';
import { stopOrcaWorktree } from '../lib/orca.js';
import { getRegisteredRepos, registerRepo } from '../lib/registry.js';
import { runCommands } from '../lib/setup.js';
import { buildTemplateVars, expandTemplate } from '../lib/template.js';
import {
  runBranchInput,
  runInteractiveList,
  runRepoPicker,
  runWizard,
} from '../lib/tui.js';

/** Shared wizard state for the create/agent flows. */
interface WorktreeTarget {
  pickedRepo?: string;
  branch?: string;
}

/**
 * Build the leading wizard steps shared by create and agent: always pick the
 * repo, then enter the branch. Both write into `state`, and each step preserves
 * its prior answer so back-navigation doesn't lose input.
 */
function buildWorktreeSteps(
  store: ConfigStore,
  state: WorktreeTarget,
): Array<() => Promise<boolean>> {
  const steps: Array<() => Promise<boolean>> = [];

  const repos = getRegisteredRepos(store);
  steps.push(async () => {
    const picked = await runRepoPicker(repos, state.pickedRepo);
    if (!picked) return false;
    state.pickedRepo = picked;
    return true;
  });

  steps.push(async () => {
    const entered = await runBranchInput(
      state.pickedRepo as string,
      state.branch ?? '',
    );
    if (!entered) return false;
    state.branch = entered;
    return true;
  });

  return steps;
}

export interface ListItems {
  items: Worktree[];
}

export async function prepareListItems(
  options: { cwd?: string; store?: ConfigStore } = {},
): Promise<ListItems> {
  // Keep this synchronous under the hood (no `await` that yields to the
  // macrotask queue, e.g. a network call): a refresh tick that yielded could let
  // a keypress land mid-tick and fire this tick's `render()` after the TUI has
  // resolved, repainting over the on-exit `warnIfCwdRemoved` hint.
  const { cwd = process.cwd(), store = createStore() } = options;

  // Auto-register the current repo for discovery (never scope to it): the list
  // is always global. Passing `cwd` to `listWorktrees` still marks the current
  // worktree so it renders as `(current)`.
  try {
    registerRepo(getRepoRoot(cwd), store);
  } catch {
    // not in a repo — nothing to auto-register
  }

  const items = getRegisteredRepos(store).flatMap((repo) => {
    try {
      return listWorktrees(repo, cwd);
    } catch {
      return [];
    }
  });
  return { items };
}

export async function runList(
  options: { cwd?: string; store?: ConfigStore } = {},
): Promise<void> {
  const { store = createStore(), cwd = process.cwd() } = options;
  const { items } = await prepareListItems({ cwd, store });

  if (items.length === 0) {
    console.log(
      pc.dim(
        'No repos registered. Run `wt create` inside a repo to get started.',
      ),
    );
    return;
  }

  const autoRefreshMinutes = getGlobalConfig(store).auto_refresh_minutes;

  await runInteractiveList(
    items,
    {
      onOpen: (item) => {
        const config = getEffectiveConfig(item.repoRoot, store);
        openIde(config.ide, config.ide_open_args, item.path);
      },

      onDelete: async (item) =>
        (await deleteWorktree(item, store)) === 'removed',

      onWipe: async (items) =>
        (await wipeWorktrees(items, store, { fetch: true })).removed,

      onCreate: async () => {
        // Wizard: worktree (repo → branch). Esc steps back (repo picker) and
        // drops to the list from the first step; preserved input avoids re-typing.
        const state: WorktreeTarget = {};
        const steps = buildWorktreeSteps(store, state);

        if (!(await runWizard(steps))) return; // cancelled out → back to the list
        if (state.pickedRepo === undefined || state.branch === undefined)
          return;

        const { createWorktree } = await import('./create.js');
        await createWorktree(state.branch, {
          repoRoot: state.pickedRepo,
          store,
          // Interactive TUI action: reveal the opened worktree (Orca --focus).
          focus: true,
        });
      },

      onAgent: async () => {
        const { createAgentWorktree, VALID_MODES } = await import('./agent.js');

        // Wizard: worktree (repo → branch) → plan prompt → permission mode. Esc
        // steps back one (and to the list from the first step). Entered values
        // are preserved so going back and forward doesn't lose work.
        const state: WorktreeTarget & { plan?: string; mode?: string } = {};
        const steps = buildWorktreeSteps(store, state);

        steps.push(async () => {
          const entered = await clack.text({
            message: 'Plan prompt for the agent:',
            initialValue: state.plan,
            validate: (v) => (!v || v.length === 0 ? 'Required' : undefined),
          });
          if (clack.isCancel(entered)) return false;
          state.plan = entered;
          return true;
        });

        steps.push(async () => {
          // Preselect the configured default for the chosen repo (the repo step
          // has already run by now), unless the user already picked a mode.
          const configuredMode = state.pickedRepo
            ? getEffectiveConfig(state.pickedRepo, store).agent_mode
            : undefined;
          const chosen = await clack.select({
            message: 'Permission mode:',
            initialValue: state.mode ?? configuredMode,
            options: VALID_MODES.map((m) => ({ value: String(m), label: m })),
          });
          if (clack.isCancel(chosen)) return false;
          state.mode = chosen;
          return true;
        });

        if (!(await runWizard(steps))) return; // cancelled out → back to the list
        if (
          state.pickedRepo === undefined ||
          state.branch === undefined ||
          state.plan === undefined
        )
          return;

        await createAgentWorktree(state.branch, state.plan, {
          repoRoot: state.pickedRepo,
          store,
          mode: state.mode,
          // Interactive TUI action: reveal the agent's terminal (Orca --focus).
          focus: true,
        });
      },

      refreshItems: async () => {
        const refreshed = await prepareListItems({ cwd, store });
        return refreshed.items;
      },
    },
    { autoRefreshMinutes },
  );

  // The TUI has torn down and restored the terminal by the time the promise
  // resolves, so this is the last thing printed before the shell prompt — the
  // right place for the dead-cwd hint (covers `D` and `P`, and an externally
  // deleted cwd). Uses the cwd captured at startup.
  warnIfCwdRemoved(cwd);
}

/**
 * Remove a single worktree with per-branch confirmation, running
 * `teardown_commands` first and force-confirming when git refuses (submodules
 * or dirty files). Shared by the TUI single-delete (`D`) and the prune flow so
 * both behave identically.
 *
 * Resolves `'cancelled'` when the user cancels any prompt (Ctrl-C/Esc), so
 * prune can stop at once instead of moving on to the next worktree.
 * `'declined'` covers a No answer and a removal git refused.
 *
 * `yes` answers every prompt with yes (`wt prune <branch> --yes`).
 * `initialValue` preselects the first prompt's answer: `wt prune <branch>`
 * passes `false` for a worktree no prune signal flags. `details` replaces the
 * one-line first prompt with the prune card.
 */
export async function deleteWorktree(
  item: Worktree,
  store: ConfigStore,
  options: { yes?: boolean; initialValue?: boolean; details?: PruneMatch } = {},
): Promise<'removed' | 'declined' | 'cancelled'> {
  // Prune runs globally across every registered repo, so the same branch name
  // can appear in multiple projects (e.g. a `back` and a `front` repo sharing a
  // feature branch). Prefix the branch with the project (repo dir basename, the
  // same value as the `{{project}}` template var) so each confirmation is
  // unambiguous about which worktree it's about to remove.
  const name = `${path.basename(item.repoRoot)}/${item.branch}`;

  let cancelled = false;
  const ask = async (message: string, initialValue?: boolean) => {
    if (options.yes) return true;
    const answer = await clack.confirm({ message, initialValue });
    if (clack.isCancel(answer)) {
      cancelled = true;
      return false;
    }
    return answer;
  };
  const notRemoved = () => (cancelled ? 'cancelled' : 'declined');

  if (options.details && !options.yes) {
    clack.note(formatPruneCard(item, options.details), pc.bold(name));
  }
  if (
    !(await ask(
      options.details
        ? 'Remove this worktree?'
        : `Remove worktree ${pc.bold(name)}? This cannot be undone.`,
      options.initialValue,
    ))
  )
    return notRemoved();

  // Single success exit for all three removal paths (normal + two force
  // fallbacks): report the removal. The "your shell is now in a gone directory"
  // hint is deliberately NOT emitted here — it only matters once control returns
  // to the shell, and printed mid-delete it gets repainted over by the TUI's
  // next render. Each entry point prints it once at the end via
  // `warnIfCwdRemoved` instead.
  const reportRemoved = (label: string) => {
    console.log(pc.green(`${label} ${name}`));
    return 'removed' as const;
  };

  // Stop the worktree's Orca agent/terminal first: a live PTY whose cwd sits
  // inside the worktree can make teardown commands and `git worktree remove`
  // fail. Best-effort and silent — it never launches Orca and no-ops for
  // worktrees Orca never saw, so it can never block a delete.
  //
  // The ordering relies on `orca terminal stop` being synchronous, which was
  // verified against the installed Orca CLI: when it returns, the PTY's child
  // process is already reaped and `orca terminal list` reports 0 terminals, so
  // `removeWorktree` below never races a dying shell. No post-stop wait needed.
  try {
    await stopOrcaWorktree({ worktreePath: item.path });
  } catch {
    // unreachable (stopOrcaWorktree swallows), but deletion must never depend on it
  }

  const config = getEffectiveConfig(item.repoRoot, store);
  if (config.teardown_commands.length > 0) {
    console.log(pc.dim('Running teardown commands...'));
    const vars = buildTemplateVars({
      branch: item.branch,
      repoRoot: item.repoRoot,
      worktreePath: item.path,
    });
    const result = await runCommands(
      config.teardown_commands.map((c) => expandTemplate(c, vars)),
      item.path,
    );
    if (!result.success) {
      clack.log.warn(
        `Teardown command failed: ${result.failedCommand} (exit code ${result.exitCode})`,
      );
      if (!(await ask(`Delete ${pc.bold(name)} anyway?`))) return notRemoved();
    }
  }

  try {
    removeWorktree(item.repoRoot, item.path);
    return reportRemoved('✓ Removed');
  } catch (err) {
    const msg = String(err);
    const reason = forceReason(msg, item.path, name);
    if (!reason) {
      console.error(pc.red(`✗ Failed to remove ${name}: ${msg}`));
      return 'declined';
    }

    if (reason.warning) clack.log.warn(reason.warning);
    if (!(await ask(reason.question))) return notRemoved();
    try {
      removeWorktree(item.repoRoot, item.path, true);
      return reportRemoved('✓ Force-removed');
    } catch (err2) {
      console.error(
        pc.red(`✗ Failed to force-remove ${name}: ${String(err2)}`),
      );
      return 'declined';
    }
  }
}

/**
 * The three ways `git worktree remove` refuses a removal that a force retry
 * can still carry out: submodules, uncommitted changes, and a lock left by an
 * agent that claimed the worktree (often a dead one — the lock outlives the
 * process). Returns the warning to print and the question to ask, or
 * `undefined` for a failure force cannot fix.
 */
function forceReason(
  msg: string,
  worktreePath: string,
  name: string,
): { warning?: string; question: string } | undefined {
  if (msg.includes('cannot be moved or removed')) {
    return {
      warning:
        'Worktree contains git submodules, which prevent standard removal.',
      question: `Force delete ${pc.bold(name)}? The worktree directory will be removed directly.`,
    };
  }
  if (msg.includes('locked working tree')) {
    const lock = /lock reason: (.*)/.exec(msg)?.[1].trim();
    return {
      warning: `Worktree is locked${lock ? `: ${lock}` : ''}.`,
      question: `Force delete ${pc.bold(name)}? The lock will be overridden.`,
    };
  }
  if (msg.includes('modified or untracked files')) {
    const dirty = listWorktreeDirtyFiles(worktreePath);
    return {
      warning:
        dirty.length > 0
          ? `Worktree has uncommitted changes:\n${dirty.map((f) => `  ${f}`).join('\n')}`
          : undefined,
      question: `Force delete ${pc.bold(name)}? All changes will be lost.`,
    };
  }
  return undefined;
}

/**
 * Pure filter: the worktrees prune may check. Excludes the main worktree
 * (`isMain`) and detached-HEAD worktrees, both path-independent. The current
 * worktree is **not** excluded: prune treats the worktree you launched from
 * like any other (the per-branch confirm in `deleteWorktree` is the guard).
 */
export function selectWipeCandidates(items: Worktree[]): Worktree[] {
  return items.filter((wt) => !wt.isMain && wt.branch !== '(detached)');
}

/** The git/forge calls `buildPrunePredicate` makes, injectable for tests. */
export interface PruneDeps {
  isBranchMerged: typeof isBranchMerged;
  hasNoUniqueCommits: typeof hasNoUniqueCommits;
  countDirtyFiles: typeof countDirtyFiles;
  hasRemoteTrackingRef: typeof hasRemoteTrackingRef;
  fetchPullRequests: typeof fetchPullRequests;
  countCommitsAhead: typeof countCommitsAhead;
  lastCommitAge: typeof lastCommitAge;
}

/** Which of the four prune signals matched. */
export type PruneReason = 'patch' | 'fast-forward' | 'pr-merged' | 'pr-closed';

/** Why a worktree is prunable, plus what its prune card shows. */
export interface PruneMatch {
  reason: PruneReason;
  /** Local name of the base branch (`main`). */
  base: string;
  /** `null` when the forge gave no data or the branch was never pushed. */
  pullRequests: PullRequests | null;
  ahead?: number;
  lastCommit?: string;
  /** Entries in `git status --porcelain`; `undefined` when git failed. */
  dirtyFiles?: number;
}

/**
 * Build a per-worktree prune check. It resolves a `PruneMatch` when any of
 * these holds, checked in order so the offline signals short-circuit the
 * (network) forge lookup away, and `null` otherwise:
 *
 * 1. `patch` — `isBranchMerged`: git proves it by patch id (squash / rebase).
 *
 * 2. `fast-forward` — the branch has no commits base doesn't already have
 *    (`hasNoUniqueCommits`: fast-forward or merge-commit merge, or a branch
 *    sitting on base's tip) **and** the worktree is clean **and** the branch was
 *    pushed. Git alone cannot separate "merged by fast-forward" from "fresh
 *    worktree holding only uncommitted work" — both have zero unique commits —
 *    so the dirty state is the discriminator, and requiring a remote-tracking
 *    ref keeps a just-created `wt create foo` from being offered for deletion.
 *
 * 3. `pr-merged` — the forge reports a merged PR/MR targeting base. Needed when
 *    a squash was rebased onto a newer base: its patch id matches nothing and
 *    the branch stays *ahead* of base, so both git signals above are false.
 *
 * 4. `pr-closed` — a PR/MR targeting base was closed without merging and none
 *    is still open (dead branch).
 *
 * 3 and 4 share one forge query (`fetchPullRequests`), skipped for a branch
 * that was never pushed (it cannot have a PR/MR). They do no topology check, so
 * the query filters on base's local name as the PR/MR *target*: a branch
 * merged into `develop` is not prunable against `main`. A worktree on the base
 * branch itself is never a candidate.
 *
 * On a match it also gathers the card data (PR, commits ahead, last commit,
 * dirty count) so the prompt renders with no delay. A git-only match runs the
 * forge query here for the card only.
 */
export function buildPrunePredicate(
  store: ConfigStore,
  deps: Partial<PruneDeps> = {},
): (wt: Worktree) => Promise<PruneMatch | null> {
  const d: PruneDeps = {
    isBranchMerged,
    hasNoUniqueCommits,
    countDirtyFiles,
    hasRemoteTrackingRef,
    fetchPullRequests,
    countCommitsAhead,
    lastCommitAge,
    ...deps,
  };

  return async (wt) => {
    const base = getEffectiveConfig(wt.repoRoot, store).base_branch;
    const { remote, branch: baseLocal } = splitBaseRef(base);
    if (wt.branch === base || wt.branch === baseLocal) return null;

    let dirty: Promise<number | undefined> | undefined;
    const dirtyFiles = () => {
      dirty ??= d.countDirtyFiles(wt.path);
      return dirty;
    };
    let pushed: Promise<boolean> | undefined;
    const isPushed = () => {
      pushed ??= d.hasRemoteTrackingRef(wt.repoRoot, remote, wt.branch);
      return pushed;
    };
    let prs: Promise<PullRequests | null> | undefined;
    const pullRequests = () => {
      prs ??= isPushed().then((p) =>
        p
          ? d.fetchPullRequests(wt.repoRoot, wt.branch, baseLocal, remote)
          : null,
      );
      return prs;
    };

    let reason: PruneReason | undefined;
    if (await d.isBranchMerged(wt.repoRoot, wt.branch, base)) reason = 'patch';
    else if (
      (await d.hasNoUniqueCommits(wt.repoRoot, wt.branch, base)) &&
      (await dirtyFiles()) === 0 &&
      (await isPushed())
    )
      reason = 'fast-forward';
    else if ((await pullRequests())?.merged) reason = 'pr-merged';
    else if ((await pullRequests())?.closed) reason = 'pr-closed';
    if (!reason) return null;

    const [pullRequestsResult, ahead, lastCommit, dirtyCount] =
      await Promise.all([
        pullRequests(),
        d.countCommitsAhead(wt.repoRoot, wt.branch, base),
        d.lastCommitAge(wt.repoRoot, wt.branch),
        dirtyFiles(),
      ]);
    return {
      reason,
      base: baseLocal,
      pullRequests: pullRequestsResult,
      ahead,
      lastCommit,
      dirtyFiles: dirtyCount,
    };
  };
}

/** `3 days ago` for an ISO date, against `now`. */
export function formatAge(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds)) return '';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size)
      return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}

/** The body of the prune card shown above the confirm (title: the worktree). */
export function formatPruneCard(
  wt: Worktree,
  match: PruneMatch,
  now = Date.now(),
): string {
  const reasons: Record<PruneReason, string> = {
    patch: `merged (patch in ${match.base})`,
    'fast-forward': 'fast-forward merged',
    'pr-merged': `PR merged into ${match.base}`,
    'pr-closed': 'PR closed without merge',
  };
  const row = (label: string, value: string) =>
    `${pc.dim(label.padEnd(8))} ${value}`;
  const lines = [row('Reason', reasons[match.reason])];

  const pr = match.pullRequests?.latest;
  if (pr) {
    lines.push(row('PR', `#${pr.number} ${pr.title}`));
    if (pr.url) lines.push(row('', pc.cyan(pr.url)));
    const age = pr.endedAt ? formatAge(pr.endedAt, now) : '';
    lines.push(row('Status', age ? `${pr.state} ${age}` : pr.state));
  } else {
    lines.push(row('PR', pc.dim('none found')));
  }

  const commits = [
    match.ahead === undefined
      ? undefined
      : `${match.ahead} ahead of ${match.base}`,
    match.lastCommit && `last commit ${match.lastCommit}`,
  ].filter(Boolean);
  if (commits.length > 0) lines.push(row('Commits', commits.join(' · ')));

  const home = homedir();
  const shownPath =
    wt.path === home || wt.path.startsWith(home + path.sep)
      ? `~${wt.path.slice(home.length)}`
      : wt.path;
  lines.push(row('Path', shownPath));

  const dirty = match.dirtyFiles;
  lines.push(
    row(
      'State',
      dirty === 0
        ? 'clean'
        : pc.yellow(
            dirty === undefined ? 'unknown' : `${dirty} uncommitted file(s)`,
          ),
    ),
  );
  return lines.join('\n');
}

/** The git helpers `pullMainWorktrees` consults, injectable for tests. */
export interface PullDeps {
  pull: typeof pullFfOnly;
  isWorktreeClean: typeof isWorktreeClean;
  remoteExists: typeof remoteExists;
}

/**
 * After a prune, fast-forward each affected repo's main worktree so the primary
 * checkout picks up the merged changes. `removedRepoRoots` is the set of repo
 * roots whose worktrees were just removed (deduped by the caller).
 *
 * Guards are skip-with-reason — never throws out of the loop, so a single
 * repo's failure can't abort pruning the rest:
 * - main worktree not found → silent skip.
 * - main not on the base branch (detached, or a feature checked out) → skip note.
 * - dirty main → warn and skip (never fabricate a stash/merge).
 * - no matching remote → clean skip note.
 * - otherwise `git pull --ff-only`; report success or surface git's message.
 */
export async function pullMainWorktrees(
  items: Worktree[],
  removedRepoRoots: Set<string>,
  store: ConfigStore,
  deps: Partial<PullDeps> = {},
): Promise<void> {
  const {
    pull = pullFfOnly,
    isWorktreeClean: clean = isWorktreeClean,
    remoteExists: hasRemote = remoteExists,
  } = deps;

  for (const repoRoot of removedRepoRoots) {
    const project = path.basename(repoRoot);
    const mainWt = items.find((w) => w.repoRoot === repoRoot && w.isMain);
    if (!mainWt) continue;

    const base = getEffectiveConfig(repoRoot, store).base_branch;
    const { remote, branch } = splitBaseRef(base);

    if (mainWt.branch !== branch) {
      console.log(
        pc.dim(
          `Skipped pull ${project} — main worktree is on ${mainWt.branch}, not ${branch}`,
        ),
      );
      continue;
    }
    if (!clean(mainWt.path)) {
      console.warn(
        pc.yellow(`⚠ Skipped pull ${project} — uncommitted changes`),
      );
      continue;
    }
    if (!hasRemote(repoRoot, remote)) {
      console.log(pc.dim(`Skipped pull ${project} — no "${remote}" remote`));
      continue;
    }

    try {
      pull(mainWt.path);
      console.log(pc.green(`✓ Pulled ${project} (${branch})`));
    } catch (err) {
      console.warn(
        pc.yellow(
          `⚠ Could not pull ${project}: ${err instanceof Error ? err.message : String(err)} — pull manually`,
        ),
      );
    }
  }
}

/**
 * Best-effort fetch of each repo's base remote, once per repo and all in
 * parallel, so merge detection sees up-to-date refs. A missing remote or a
 * failed fetch only warns. Returns one promise per repo root (never rejects),
 * so each worktree waits only for its own repo.
 */
export function fetchRepos(
  items: Worktree[],
  store: ConfigStore,
): Map<string, Promise<void>> {
  const fetches = new Map<string, Promise<void>>();
  for (const wt of items) {
    if (fetches.has(wt.repoRoot)) continue;
    const parts = getEffectiveConfig(wt.repoRoot, store).base_branch.split(
      '/',
      2,
    );
    if (parts.length !== 2) continue;
    const remote = parts[0] || 'origin';
    if (!remoteExists(wt.repoRoot, remote)) {
      console.warn(
        pc.yellow(
          `⚠ ${path.basename(wt.repoRoot)} has no "${remote}" remote — falling back to local git`,
        ),
      );
      continue;
    }
    fetches.set(
      wt.repoRoot,
      fetchRemoteAsync(wt.repoRoot, remote).catch((err) => {
        console.warn(
          pc.yellow(
            `⚠ Could not fetch from ${remote} — using local state${err instanceof Error ? ` (${err.message})` : ''}`,
          ),
        );
      }),
    );
  }
  return fetches;
}

/** How many worktrees `wipeWorktrees` checks at once. */
const CHECK_CONCURRENCY = 6;

/**
 * Find every prunable worktree among `items` and remove it via
 * `deleteWorktree` (prune card + per-branch confirmation + force-confirmation).
 *
 * Streams: repos fetch in parallel (when `fetch` is set), worktrees are checked
 * `CHECK_CONCURRENCY` at a time in `items` order, and each match is prompted as
 * soon as it is found while the checks continue. Prompts never overlap. A
 * spinner shows progress while nothing is ready to prompt.
 *
 * A cancel (Ctrl-C at a prompt or at the spinner) stops at once: no more
 * prompts, no pull, and pending check results are discarded. Otherwise, once
 * every check is done and the last prompt answered, fast-forwards each
 * affected repo's main worktree (`pullMainWorktrees`) unless `pull` is false.
 * `quiet` drops the "nothing to wipe" line (watch mode).
 */
export async function wipeWorktrees(
  items: Worktree[],
  store: ConfigStore,
  options: {
    fetch?: boolean;
    pull?: boolean;
    quiet?: boolean;
    deps?: Partial<PruneDeps>;
  } = {},
): Promise<{ removed: Worktree[]; cancelled: boolean }> {
  const fetches = options.fetch
    ? fetchRepos(items, store)
    : new Map<string, Promise<void>>();
  const predicate = buildPrunePredicate(store, options.deps);
  const queue = selectWipeCandidates(items);
  const ready: { wt: Worktree; match: PruneMatch }[] = [];
  let checked = 0;
  let next = 0;
  let checking = true;
  let cancelled = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const progress = () => `Checking worktrees… (${checked}/${queue.length})`;
  const spin = clack.spinner({
    onCancel: () => {
      cancelled = true;
      notify();
    },
  });
  let spinning = false;

  const worker = async () => {
    while (next < queue.length && !cancelled) {
      const wt = queue[next++];
      await fetches.get(wt.repoRoot);
      const match = await predicate(wt).catch(() => null);
      checked++;
      if (spinning) spin.message(progress());
      if (match && !cancelled) ready.push({ wt, match });
      notify();
    }
  };
  void Promise.all(
    Array.from({ length: CHECK_CONCURRENCY }, () => worker()),
  ).then(() => {
    checking = false;
    notify();
  });

  const removed: Worktree[] = [];
  let found = 0;
  while (!cancelled) {
    const candidate = ready.shift();
    if (!candidate) {
      if (!checking) break;
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      if (!spinning) {
        spin.start(progress());
        spinning = true;
      }
      await woken;
      continue;
    }
    if (spinning) {
      spin.clear();
      spinning = false;
    }
    found++;
    const result = await deleteWorktree(candidate.wt, store, {
      details: candidate.match,
    });
    if (result === 'cancelled') cancelled = true;
    if (result === 'removed') removed.push(candidate.wt);
  }
  if (spinning) spin.clear();
  if (cancelled) return { removed, cancelled };

  if (found === 0 && !options.quiet) {
    console.log(pc.dim('No merged or closed worktrees to wipe.'));
  }
  if (removed.length > 0 && (options.pull ?? true)) {
    await pullMainWorktrees(
      items,
      new Set(removed.map((w) => w.repoRoot)),
      store,
    );
  }
  return { removed, cancelled };
}

/** The nearest ancestor of `p` that still exists on disk (the filesystem root
 * always does), used as a safe `cd` suggestion when `p` itself is gone. */
function nearestExistingAncestor(p: string): string {
  let dir = path.dirname(p);
  while (dir !== path.dirname(dir)) {
    if (existsSync(dir)) return dir;
    dir = path.dirname(dir);
  }
  return dir;
}

/**
 * Print a one-line hint **iff** `cwd` no longer exists on disk — i.e. the user
 * removed the worktree their shell was standing in. Call this once at each entry
 * point, at the very end, when control is about to return to the shell (and, for
 * the TUI, after the terminal has been restored) so it lands as the last thing
 * printed and can't be repainted over.
 *
 * It's existence-based, which makes it path-independent: removing some *other*
 * worktree leaves `cwd` intact and this stays silent; only losing the directory
 * you're actually in triggers it. When no explicit `cd` target is given it
 * suggests the nearest still-existing ancestor of the gone directory.
 */
export function warnIfCwdRemoved(cwd: string, suggestion?: string): void {
  if (existsSync(cwd)) return;
  const target = suggestion ?? nearestExistingAncestor(cwd);
  console.warn(
    pc.yellow(
      `⚠ Your current directory no longer exists (${cwd}) — cd ${target} (or elsewhere).`,
    ),
  );
}
