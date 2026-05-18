// src/lib/tui.ts
import path from 'node:path';
import Fuse from 'fuse.js';
import pc from 'picocolors';
import type { Worktree } from './git.js';

// ── Data functions (pure, testable) ────────────────────────────────────────

let cachedFuse: { items: Worktree[]; fuse: Fuse<Worktree> } | null = null;

export function filterItems(items: Worktree[], query: string): Worktree[] {
  if (!query) return items;
  if (!cachedFuse || cachedFuse.items !== items) {
    cachedFuse = {
      items,
      fuse: new Fuse(items, { keys: ['branch'], threshold: 0.4 }),
    };
  }
  return cachedFuse.fuse.search(query).map((r) => r.item);
}

export function groupByRepo(items: Worktree[]): Map<string, Worktree[]> {
  const map = new Map<string, Worktree[]>();
  for (const item of items) {
    const existing = map.get(item.repoRoot) ?? [];
    map.set(item.repoRoot, [...existing, item]);
  }
  return map;
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? '';
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function renderList(
  items: Worktree[],
  selectedIndex: number,
  query: string,
  mode: 'repo' | 'global',
): string {
  const lines: string[] = [];

  if (mode === 'global') {
    lines.push(
      pc.dim('ℹ Not in a git repository — showing all registered worktrees'),
    );
    lines.push('');
  }

  lines.push(pc.cyan(`> ${query}_`));
  lines.push('');

  const groups = groupByRepo(items);
  let i = 0;
  for (const [repoPath, groupItems] of groups) {
    lines.push(pc.bold(path.basename(repoPath).toUpperCase()));
    for (const item of groupItems) {
      const cursor = i === selectedIndex ? pc.cyan('▶') : ' ';
      const branchLabel = item.isCurrent
        ? pc.dim(`${item.branch} (current)`)
        : pc.white(item.branch);
      const pathLabel = pc.dim(shortenPath(item.path));
      lines.push(`  ${cursor} ${branchLabel}  ${pathLabel}`);
      if (item.lastCommit) {
        lines.push(`      ${pc.dim(item.lastCommit)}`);
      }
      i++;
    }
  }

  lines.push('');
  const createHint = mode === 'repo' ? ' · C create' : '';
  lines.push(
    pc.dim(`↕ navigate · Enter open · D delete${createHint} · Q quit`),
  );

  return lines.join('\n');
}

function setupRawMode(): void {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
}

function cleanupRawMode(): void {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1B[2J\x1B[H');
}

export function renderRepoPicker(
  repos: string[],
  selectedIndex: number,
  query: string,
): string {
  const lines: string[] = [];
  lines.push(pc.dim('ℹ Not in a git repository — select a repo to create in'));
  lines.push('');
  lines.push(pc.cyan(`> ${query}_`));
  lines.push('');
  for (let i = 0; i < repos.length; i++) {
    const cursor = i === selectedIndex ? pc.cyan('▶') : ' ';
    lines.push(
      `  ${cursor} ${pc.bold(path.basename(repos[i]).toUpperCase())}  ${pc.dim(shortenPath(repos[i]))}`,
    );
  }
  lines.push('');
  lines.push(pc.dim('↕ navigate · Enter select · Q quit'));
  return lines.join('\n');
}

export async function runRepoPicker(repos: string[]): Promise<string | null> {
  const filterRepos = (all: string[], q: string): string[] =>
    q
      ? all.filter((p) =>
          path.basename(p).toLowerCase().includes(q.toLowerCase()),
        )
      : all;

  let query = '';
  let selectedIndex = 0;
  let filtered = repos;

  const render = () => {
    process.stdout.write('\x1B[2J\x1B[H');
    process.stdout.write(renderRepoPicker(filtered, selectedIndex, query));
  };

  setupRawMode();
  render();

  return new Promise((resolve, reject) => {
    let listenerActive = false;

    const attachListener = () => {
      if (!listenerActive) {
        process.stdin.on('data', onData);
        listenerActive = true;
      }
    };

    const detachListener = () => {
      process.stdin.removeListener('data', onData);
      listenerActive = false;
    };

    const onData = (key: string) => {
      try {
        if (key === '\x03' || key === 'q' || key === 'Q' || key === '\x1b') {
          detachListener();
          cleanupRawMode();
          resolve(null);
        } else if (key === '\x1b[A') {
          selectedIndex = Math.max(0, selectedIndex - 1);
          render();
        } else if (key === '\x1b[B') {
          selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
          render();
        } else if (key === '\r') {
          const repo = filtered[selectedIndex];
          if (repo) {
            detachListener();
            cleanupRawMode();
            resolve(repo);
          }
        } else if (key === '\x7f') {
          query = query.slice(0, -1);
          filtered = filterRepos(repos, query);
          selectedIndex = 0;
          render();
        } else if (key.length === 1 && key >= ' ') {
          query += key;
          filtered = filterRepos(repos, query);
          selectedIndex = 0;
          render();
        }
      } catch (err) {
        detachListener();
        cleanupRawMode();
        reject(err);
      }
    };

    attachListener();
  });
}

export function renderBranchInput(
  repoName: string,
  branch: string,
  error?: string,
): string {
  const lines: string[] = [];
  lines.push(pc.bold(`Repo: ${repoName}`));
  lines.push('');
  lines.push(`Branch: ${pc.cyan(`${branch}_`)}`);
  if (error) {
    lines.push('');
    lines.push(pc.red(error));
  }
  lines.push('');
  lines.push(pc.dim('Enter confirm · Esc cancel'));
  return lines.join('\n');
}

export async function runBranchInput(repoRoot: string): Promise<string | null> {
  let branch = '';
  let error: string | undefined;
  const repoName = path.basename(repoRoot);

  const render = () => {
    process.stdout.write('\x1B[2J\x1B[H');
    process.stdout.write(renderBranchInput(repoName, branch, error));
  };

  setupRawMode();
  render();

  return new Promise((resolve, reject) => {
    const onData = (key: string) => {
      try {
        if (key === '\x03' || key === '\x1b') {
          process.stdin.removeListener('data', onData);
          cleanupRawMode();
          resolve(null);
        } else if (key === '\r') {
          if (!branch) {
            error = 'Branch name is required';
            render();
          } else {
            process.stdin.removeListener('data', onData);
            cleanupRawMode();
            resolve(branch);
          }
        } else if (key === '\x7f') {
          branch = branch.slice(0, -1);
          error = undefined;
          render();
        } else if (key.length === 1 && key >= ' ') {
          branch += key;
          error = undefined;
          render();
        }
      } catch (err) {
        process.stdin.removeListener('data', onData);
        cleanupRawMode();
        reject(err);
      }
    };
    process.stdin.on('data', onData);
  });
}

// ── Interactive TUI runner ──────────────────────────────────────────────────

export interface TuiHandlers {
  onOpen: (item: Worktree) => void;
  onDelete: (item: Worktree) => Promise<boolean>;
  onCreate: () => Promise<void>;
}

export async function runInteractiveList(
  allItems: Worktree[],
  mode: 'repo' | 'global',
  handlers: TuiHandlers,
): Promise<void> {
  let query = '';
  let selectedIndex = 0;
  let filtered = allItems;

  const render = () => {
    process.stdout.write('\x1B[2J\x1B[H');
    process.stdout.write(renderList(filtered, selectedIndex, query, mode));
  };

  setupRawMode();
  render();

  return new Promise((resolve, reject) => {
    let listenerActive = false;

    const attachListener = () => {
      if (!listenerActive) {
        process.stdin.on('data', onData);
        listenerActive = true;
      }
    };

    const detachListener = () => {
      process.stdin.removeListener('data', onData);
      listenerActive = false;
    };

    const onData = async (key: string) => {
      try {
        if (key === '\x03' || key === 'q' || key === 'Q' || key === '\x1b') {
          detachListener();
          cleanupRawMode();
          resolve();
        } else if (key === '\x1b[A') {
          selectedIndex = Math.max(0, selectedIndex - 1);
          render();
        } else if (key === '\x1b[B') {
          selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
          render();
        } else if (key === '\r') {
          const item = filtered[selectedIndex];
          if (item) {
            detachListener();
            cleanupRawMode();
            handlers.onOpen(item);
            resolve();
          }
        } else if (key === 'd' || key === 'D') {
          const item = filtered[selectedIndex];
          if (item) {
            if (item.isCurrent) {
              process.stdout.write(
                pc.red('\nCannot delete the worktree you are currently in.\n'),
              );
              return;
            }
            detachListener();
            cleanupRawMode();
            const confirmed = await handlers.onDelete(item);
            if (confirmed) {
              allItems = allItems.filter((w) => w !== item);
              filtered = filtered.filter((w) => w !== item);
            }
            selectedIndex = Math.min(
              selectedIndex,
              Math.max(0, filtered.length - 1),
            );
            setupRawMode();
            attachListener();
            render();
          }
        } else if (key === 'c' || key === 'C') {
          if (mode === 'repo') {
            detachListener();
            cleanupRawMode();
            await handlers.onCreate();
            resolve();
          } else {
            process.stdout.write(
              pc.dim('\ncd into a repo first to create a worktree.\n'),
            );
          }
        } else if (key === '\x7f') {
          query = query.slice(0, -1);
          filtered = filterItems(allItems, query);
          selectedIndex = 0;
          render();
        } else if (key.length === 1 && key >= ' ') {
          query += key;
          filtered = filterItems(allItems, query);
          selectedIndex = 0;
          render();
        }
      } catch (err) {
        detachListener();
        cleanupRawMode();
        reject(err);
      }
    };

    attachListener();
  });
}
