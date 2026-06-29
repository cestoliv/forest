// src/commands/list.ts

import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
  getGlobalConfig,
} from '../lib/config.js';
import {
  getRepoRoot,
  listWorktreeDirtyFiles,
  listWorktrees,
  removeWorktree,
  type Worktree,
} from '../lib/git.js';
import { openIde } from '../lib/ide.js';
import { getRegisteredRepos, registerRepo } from '../lib/registry.js';
import { runCommands } from '../lib/setup.js';
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
 * Build the leading wizard steps shared by create and agent: pick the repo
 * (global mode only) then enter the branch. Both write into `state`, and each
 * step preserves its prior answer so back-navigation doesn't lose input.
 */
function buildWorktreeSteps(
  repoRoot: string | null,
  store: ConfigStore,
  state: WorktreeTarget,
): Array<() => Promise<boolean>> {
  const steps: Array<() => Promise<boolean>> = [];

  if (!repoRoot) {
    const repos = getRegisteredRepos(store);
    steps.push(async () => {
      const picked = await runRepoPicker(repos, state.pickedRepo);
      if (!picked) return false;
      state.pickedRepo = picked;
      return true;
    });
  }

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
  mode: 'repo' | 'global';
  repoRoot: string | null;
}

export async function prepareListItems(
  options: { cwd?: string; store?: ConfigStore } = {},
): Promise<ListItems> {
  const { cwd = process.cwd(), store = createStore() } = options;

  let repoRoot: string | null = null;
  try {
    repoRoot = getRepoRoot(cwd);
  } catch {
    // not in a repo — fall through to global mode
  }

  if (repoRoot) {
    registerRepo(repoRoot, store);
    const items = listWorktrees(repoRoot, cwd);
    return { items, mode: 'repo', repoRoot };
  }

  const repos = getRegisteredRepos(store);
  const items = repos.flatMap((repo) => {
    try {
      return listWorktrees(repo, cwd);
    } catch {
      return [];
    }
  });
  return { items, mode: 'global', repoRoot: null };
}

export async function runList(
  options: { cwd?: string; store?: ConfigStore } = {},
): Promise<void> {
  const { store = createStore(), cwd = process.cwd() } = options;
  const { items, mode, repoRoot } = await prepareListItems({ cwd, store });

  if (items.length === 0 && mode === 'global') {
    console.log(
      pc.dim(
        'No repos registered. Run `wt create` inside a repo to get started.',
      ),
    );
    return;
  }

  const autoRefreshMinutes =
    mode === 'repo' && repoRoot
      ? getEffectiveConfig(repoRoot, store).auto_refresh_minutes
      : getGlobalConfig(store).auto_refresh_minutes;

  await runInteractiveList(
    items,
    mode,
    {
      onOpen: (item) => {
        const config = getEffectiveConfig(item.repoRoot, store);
        openIde(config.ide, config.ide_open_args, item.path);
      },

      onDelete: async (item) => {
        const confirmed = await clack.confirm({
          message: `Remove worktree ${pc.bold(item.branch)}? This cannot be undone.`,
        });
        if (clack.isCancel(confirmed) || !confirmed) return false;

        const config = getEffectiveConfig(item.repoRoot, store);
        if (config.teardown_commands.length > 0) {
          console.log(pc.dim('Running teardown commands...'));
          const result = await runCommands(config.teardown_commands, item.path);
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
          console.log(pc.green(`✓ Removed ${item.branch}`));
          return true;
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
              console.log(pc.green(`✓ Force-removed ${item.branch}`));
              return true;
            } catch (err2) {
              console.error(
                pc.red(`✗ Failed to force-remove: ${String(err2)}`),
              );
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
              console.log(pc.green(`✓ Force-removed ${item.branch}`));
              return true;
            } catch (err2) {
              console.error(
                pc.red(`✗ Failed to force-remove: ${String(err2)}`),
              );
              return false;
            }
          }
          console.error(pc.red(`✗ Failed to remove: ${msg}`));
          return false;
        }
      },

      onCreate: async () => {
        // Wizard: worktree (repo → branch). Esc steps back (repo picker) and
        // drops to the list from the first step; preserved input avoids re-typing.
        const state: WorktreeTarget = { pickedRepo: repoRoot ?? undefined };
        const steps = buildWorktreeSteps(repoRoot, store, state);

        if (!(await runWizard(steps))) return; // cancelled out → back to the list
        if (state.pickedRepo === undefined || state.branch === undefined)
          return;

        const { createWorktree } = await import('./create.js');
        await createWorktree(state.branch, { cwd: state.pickedRepo, store });
      },

      onAgent: async () => {
        const { createAgentWorktree, VALID_MODES } = await import('./agent.js');

        // Wizard: worktree (repo → branch) → plan prompt → permission mode. Esc
        // steps back one (and to the list from the first step). Entered values
        // are preserved so going back and forward doesn't lose work.
        const state: WorktreeTarget & { plan?: string; mode: string } = {
          pickedRepo: repoRoot ?? undefined,
          mode: 'plan',
        };
        const steps = buildWorktreeSteps(repoRoot, store, state);

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
          const chosen = await clack.select({
            message: 'Permission mode:',
            initialValue: state.mode,
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
          cwd: state.pickedRepo,
          store,
          mode: state.mode,
        });
      },

      refreshItems: async () => {
        const refreshed = await prepareListItems({ cwd, store });
        return refreshed.items;
      },
    },
    { autoRefreshMinutes },
  );
}
