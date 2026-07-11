// src/commands/prune.ts

import pc from 'picocolors';
import { type ConfigStore, createStore } from '../lib/config.js';
import { prepareListItems, warnIfCwdRemoved, wipeWorktrees } from './list.js';

export async function runPrune(
  options: { cwd?: string; store?: ConfigStore } = {},
): Promise<void> {
  const { cwd = process.cwd(), store = createStore() } = options;
  const { items } = await prepareListItems({ cwd, store });

  if (items.length === 0) {
    console.log(
      pc.dim(
        'No repos registered. Run `wt create` inside a repo to get started.',
      ),
    );
    return;
  }

  const removed = await wipeWorktrees(items, store, { fetch: true });
  if (removed.length > 0) {
    console.log(pc.green(`✓ Pruned ${removed.length} worktree(s).`));
  }

  // Non-interactive exit: if prune removed the worktree this command was run
  // from, the shell is now in a gone directory. Printed here (not inside
  // `wipeWorktrees`, which the TUI `P` also calls) so it lands last, on return
  // to the shell — the TUI covers its own case in `runList`.
  warnIfCwdRemoved(cwd);
}
