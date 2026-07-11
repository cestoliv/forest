// src/commands/list.ts

import { existsSync } from 'node:fs';
import path from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
  getGlobalConfig,
} from '../lib/config.js';
import {
  fetchRemote,
  getRepoRoot,
  hasNoUniqueCommits,
  hasRemoteTrackingRef,
  isBranchClosed,
  isBranchMerged,
  isBranchMergedOnForge,
  isWorktreeClean,
  listWorktreeDirtyFiles,
  listWorktrees,
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

      onDelete: (item) => deleteWorktree(item, store),

      onWipe: (items) => wipeWorktrees(items, store, { fetch: true }),

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
 * or dirty files). Returns true iff the worktree was removed. Shared by the
 * TUI single-delete (`D`) and the prune flow so both behave identically.
 */
export async function deleteWorktree(
  item: Worktree,
  store: ConfigStore,
): Promise<boolean> {
  const confirmed = await clack.confirm({
    message: `Remove worktree ${pc.bold(item.branch)}? This cannot be undone.`,
  });
  if (clack.isCancel(confirmed) || !confirmed) return false;

  // Single success exit for all three removal paths (normal + two force
  // fallbacks): report the removal. The "your shell is now in a gone directory"
  // hint is deliberately NOT emitted here — it only matters once control returns
  // to the shell, and printed mid-delete it gets repainted over by the TUI's
  // next render. Each entry point prints it once at the end via
  // `warnIfCwdRemoved` instead.
  const reportRemoved = (label: string): true => {
    console.log(pc.green(`${label} ${item.branch}`));
    return true;
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
      const proceed = await clack.confirm({
        message: `Delete ${pc.bold(item.branch)} anyway?`,
      });
      if (clack.isCancel(proceed) || !proceed) return false;
    }
  }

  try {
    removeWorktree(item.repoRoot, item.path);
    return reportRemoved('✓ Removed');
  } catch (err) {
    const msg = String(err);
    if (msg.includes('cannot be moved or removed')) {
      clack.log.warn(
        'Worktree contains git submodules, which prevent standard removal.',
      );
      const force = await clack.confirm({
        message: `Force delete ${pc.bold(item.branch)}? The worktree directory will be removed directly.`,
      });
      if (clack.isCancel(force) || !force) return false;
      try {
        removeWorktree(item.repoRoot, item.path, true);
        return reportRemoved('✓ Force-removed');
      } catch (err2) {
        console.error(pc.red(`✗ Failed to force-remove: ${String(err2)}`));
        return false;
      }
    }
    if (msg.includes('modified or untracked files')) {
      const dirty = listWorktreeDirtyFiles(item.path);
      if (dirty.length > 0) {
        clack.log.warn(
          `Worktree has uncommitted changes:\n${dirty.map((f) => `  ${f}`).join('\n')}`,
        );
      }
      const force = await clack.confirm({
        message: `Force delete ${pc.bold(item.branch)}? All changes will be lost.`,
      });
      if (clack.isCancel(force) || !force) return false;
      try {
        removeWorktree(item.repoRoot, item.path, true);
        return reportRemoved('✓ Force-removed');
      } catch (err2) {
        console.error(pc.red(`✗ Failed to force-remove: ${String(err2)}`));
        return false;
      }
    }
    console.error(pc.red(`✗ Failed to remove: ${msg}`));
    return false;
  }
}

/**
 * Pure filter: keep only worktrees that are safe prunable candidates (merged or
 * closed). Excludes the main worktree (`isMain`) and detached-HEAD worktrees —
 * both path-independent — then applies the injected `isPrunable` predicate. The
 * current worktree is **not** excluded: prune treats the worktree you launched
 * from like any other (the per-branch confirm in `deleteWorktree` is the guard).
 */
export function selectWipeCandidates(
  items: Worktree[],
  isPrunable: (wt: Worktree) => boolean,
): Worktree[] {
  return items.filter(
    (wt) => !wt.isMain && wt.branch !== '(detached)' && isPrunable(wt),
  );
}

/** The git/forge signals `buildPrunePredicate` consults, injectable for tests. */
export interface PruneDeps {
  isBranchMerged: typeof isBranchMerged;
  hasNoUniqueCommits: typeof hasNoUniqueCommits;
  isWorktreeClean: typeof isWorktreeClean;
  hasRemoteTrackingRef: typeof hasRemoteTrackingRef;
  isBranchMergedOnForge: typeof isBranchMergedOnForge;
  isBranchClosed: typeof isBranchClosed;
}

/**
 * Build a per-worktree "is prunable" predicate. A worktree is prunable when any
 * of these holds, checked in order so the two offline signals short-circuit the
 * two (network) forge lookups away:
 *
 * 1. `isBranchMerged` — git proves it by patch id (squash / rebase merge).
 *
 * 2. The branch has no commits base doesn't already have (`hasNoUniqueCommits`:
 *    fast-forward or merge-commit merge, or a branch sitting on base's tip)
 *    **and** the worktree is clean **and** the branch was pushed. Git alone
 *    cannot separate "merged by fast-forward" from "fresh worktree holding only
 *    uncommitted work" — both have zero unique commits — so the worktree's dirty
 *    state is the discriminator, and requiring a remote-tracking ref keeps a
 *    just-created `wt create foo` from being offered for deletion. (The cost:
 *    an abandoned never-pushed worktree stays unprunable.)
 *
 * 3. `isBranchMergedOnForge` — the forge reports a merged PR/MR targeting base.
 *    Needed when a squash was rebased onto a newer base: its patch id matches
 *    nothing and the branch stays *ahead* of base, so both git signals above are
 *    false.
 *
 * 4. `isBranchClosed` — a PR/MR targeting base was closed without merging (dead
 *    branch).
 *
 * Every signal is scoped to the worktree's own repo's effective `base_branch`:
 * the git ones by construction, the forge ones because the PR/MR query filters
 * on the base as its target branch (a branch merged into `develop` is therefore
 * not prunable against `main`). A worktree sitting on the base branch itself is
 * never a candidate.
 */
export function buildPrunePredicate(
  store: ConfigStore,
  deps: Partial<PruneDeps> = {},
): (wt: Worktree) => boolean {
  const {
    isBranchMerged: merged = isBranchMerged,
    hasNoUniqueCommits: noUnique = hasNoUniqueCommits,
    isWorktreeClean: clean = isWorktreeClean,
    hasRemoteTrackingRef: pushed = hasRemoteTrackingRef,
    isBranchMergedOnForge: mergedOnForge = isBranchMergedOnForge,
    isBranchClosed: closed = isBranchClosed,
  } = deps;

  return (wt) => {
    const config = getEffectiveConfig(wt.repoRoot, store);
    const base = config.base_branch;
    const { remote, branch: baseLocal } = splitBaseRef(base);
    if (wt.branch === base || wt.branch === baseLocal) return false;

    if (merged(wt.repoRoot, wt.branch, base)) return true;
    if (
      noUnique(wt.repoRoot, wt.branch, base) &&
      clean(wt.path) &&
      pushed(wt.repoRoot, remote, wt.branch)
    )
      return true;
    if (mergedOnForge(wt.repoRoot, wt.branch, base)) return true;
    if (closed(wt.repoRoot, wt.branch, base)) return true;
    return false;
  };
}

/**
 * Find every merged worktree among `items` and remove it via `deleteWorktree`
 * (per-branch confirmation + force-confirmation). Optionally best-effort
 * fetches each repo's remote first so merge detection sees up-to-date refs.
 * Returns the worktrees that were actually removed.
 */
export async function wipeWorktrees(
  items: Worktree[],
  store: ConfigStore,
  options: { fetch?: boolean } = {},
): Promise<Worktree[]> {
  if (options.fetch) {
    const seen = new Set<string>();
    for (const wt of items) {
      if (seen.has(wt.repoRoot)) continue;
      seen.add(wt.repoRoot);
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
      try {
        fetchRemote(wt.repoRoot, remote);
      } catch (err) {
        console.warn(
          pc.yellow(
            `⚠ Could not fetch from ${remote} — using local state${err instanceof Error ? ` (${err.message})` : ''}`,
          ),
        );
      }
    }
  }

  const candidates = selectWipeCandidates(items, buildPrunePredicate(store));
  if (candidates.length === 0) {
    console.log(pc.dim('No merged or closed worktrees to wipe.'));
    return [];
  }

  const removed: Worktree[] = [];
  for (const candidate of candidates) {
    if (await deleteWorktree(candidate, store)) {
      removed.push(candidate);
    }
  }
  return removed;
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
