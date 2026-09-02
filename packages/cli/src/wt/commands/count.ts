// src/commands/count.ts

import { realpathSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { type ConfigStore, createStore } from '../lib/config.js';
import { getRegisteredRepos } from '../lib/registry.js';
import { prepareListItems } from './list.js';

export async function runCount(
  options: { cwd?: string; store?: ConfigStore } = {},
): Promise<void> {
  const { cwd = process.cwd(), store = createStore() } = options;

  // Same global scan + auto-registration as `wt list`/`wt prune`; read the
  // registered repos only after this, so a repo auto-registered by being
  // inside it is included in the breakdown below.
  const { items } = await prepareListItems({ cwd, store });

  if (items.length === 0) {
    console.log(
      pc.dim(
        'No repos registered. Run `wt create` inside a repo to get started.',
      ),
    );
    return;
  }

  const repos = getRegisteredRepos(store);

  // The main checkout is the repo itself, not a workspace (same rule
  // `spawner/lib/capacity.ts` uses for its worktree cap).
  const linked = items.filter((w) => !w.isMain);

  // Every registered repo gets a row, even one with zero linked worktrees.
  // Seed with the resolved path: `listWorktrees` sets `repoRoot` via
  // `realpathSync`, so a registered path crossing a symlink would otherwise
  // seed a `0` row that a worktree's realpath'd count never lands on. Fall
  // back to the raw path if the repo directory is gone.
  const counts = new Map<string, number>(
    repos.map((repo) => {
      try {
        return [realpathSync(repo), 0];
      } catch {
        return [repo, 0];
      }
    }),
  );
  for (const w of linked) {
    counts.set(w.repoRoot, (counts.get(w.repoRoot) ?? 0) + 1);
  }

  const rows = [...counts.entries()]
    .map(([repo, count]) => ({ label: path.basename(repo), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const maxLabelLen = Math.max(...rows.map((r) => r.label.length));
  const maxCountLen = Math.max(...rows.map((r) => String(r.count).length));

  console.log(
    `Total: ${linked.length} worktree${linked.length === 1 ? '' : 's'}`,
  );
  console.log('');
  for (const { label, count } of rows) {
    console.log(
      `  ${label.padEnd(maxLabelLen)}   ${String(count).padStart(maxCountLen)}`,
    );
  }
}
