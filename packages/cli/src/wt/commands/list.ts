// src/commands/list.ts

import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
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
import { runInteractiveList } from '../lib/tui.js';

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

  await runInteractiveList(items, mode, {
    onOpen: (item) => {
      const config = getEffectiveConfig(item.repoRoot, store);
      openIde(config.ide, config.ide_open_args, item.path);
    },

    onDelete: async (item) => {
      const confirmed = await clack.confirm({
        message: `Remove worktree ${pc.bold(item.branch)}? This cannot be undone.`,
      });
      if (clack.isCancel(confirmed) || !confirmed) return false;
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
            console.log(pc.green(`✓ Force-removed ${item.branch}`));
            return true;
          } catch (err2) {
            console.error(pc.red(`✗ Failed to force-remove: ${String(err2)}`));
            return false;
          }
        }
        console.error(pc.red(`✗ Failed to remove: ${msg}`));
        return false;
      }
    },

    onCreate: async () => {
      if (repoRoot) {
        const { createWorktree } = await import('./create.js');
        await createWorktree(undefined, { cwd: repoRoot, store });
      }
    },
  });
}
