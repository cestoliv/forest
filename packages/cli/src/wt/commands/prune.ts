// src/commands/prune.ts

import pc from 'picocolors';
import { type ConfigStore, createStore } from '../lib/config.js';
import { prepareListItems, wipeWorktrees } from './list.js';

export async function runPrune(
  options: { cwd?: string; store?: ConfigStore } = {},
): Promise<void> {
  const { cwd = process.cwd(), store = createStore() } = options;
  const { items, mode } = await prepareListItems({ cwd, store });

  if (items.length === 0) {
    console.log(
      pc.dim(
        mode === 'global'
          ? 'No repos registered. Run `wt create` inside a repo to get started.'
          : 'No worktrees found.',
      ),
    );
    return;
  }

  const removed = await wipeWorktrees(items, store, { fetch: true });
  if (removed.length > 0) {
    console.log(pc.green(`✓ Pruned ${removed.length} worktree(s).`));
  }
}
