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

export interface ListLayout {
  /** Pinned top region (global-mode notice + search query line). */
  header: string[];
  /** Scrollable region (repo group headers + worktree item lines). */
  body: string[];
  /** Pinned bottom region (navigation hint). */
  footer: string[];
  /**
   * For each flat item index (aligned with `selectedIndex`), the inclusive
   * range of `body` line indices it occupies. Items with a `lastCommit` span
   * two lines.
   */
  itemSpans: { start: number; end: number }[];
}

/**
 * Build the three pinned/scrollable regions of the worktree list plus the
 * per-item line spans. Pure and terminal-agnostic so it can be unit-tested and
 * composed by both `renderList` and the interactive runner.
 */
export function buildListLayout(
  items: Worktree[],
  selectedIndex: number,
  query: string,
  mode: 'repo' | 'global',
): ListLayout {
  const header: string[] = [];
  if (mode === 'global') {
    header.push(
      pc.dim('ℹ Not in a git repository — showing all registered worktrees'),
    );
    header.push('');
  }
  header.push(pc.cyan(`> ${query}_`));

  const body: string[] = [];
  const itemSpans: { start: number; end: number }[] = [];
  const groups = groupByRepo(items);
  let i = 0;
  for (const [repoPath, groupItems] of groups) {
    body.push(pc.bold(path.basename(repoPath).toUpperCase()));
    for (const item of groupItems) {
      const start = body.length;
      const cursor = i === selectedIndex ? pc.cyan('▶') : ' ';
      const branchLabel = item.isCurrent
        ? pc.dim(`${item.branch} (current)`)
        : pc.white(item.branch);
      const pathLabel = pc.dim(shortenPath(item.path));
      body.push(`  ${cursor} ${branchLabel}  ${pathLabel}`);
      if (item.lastCommit) {
        body.push(`      ${pc.dim(item.lastCommit)}`);
      }
      itemSpans[i] = { start, end: body.length - 1 };
      i++;
    }
  }

  const footer = [
    pc.dim('↕ navigate · Enter open · D delete · C create · A agent · Q quit'),
  ];

  return { header, body, footer, itemSpans };
}

/**
 * Edge-anchored scroll: keep the selected item's line span visible within a
 * `viewportHeight`-tall window while moving the offset as little as possible.
 * A selection already inside the window leaves `offset` unchanged.
 */
export function clampScroll(
  offset: number,
  span: { start: number; end: number },
  viewportHeight: number,
  bodyLength: number,
): number {
  const maxOffset = Math.max(0, bodyLength - viewportHeight);
  let next = offset;
  if (span.start < next) next = span.start;
  if (span.end >= next + viewportHeight) next = span.end - viewportHeight + 1;
  return Math.max(0, Math.min(next, maxOffset));
}

/**
 * Compose the final string: pinned header, a top `↑ more` indicator slot, the
 * visible window of body lines, a bottom `↓ more` indicator slot, and the
 * pinned footer. The indicator slots reuse the blank separators that already
 * sat around the list, so the fixed region height never changes. The scrollable
 * region is padded with blank lines up to `viewportHeight` so the footer stays
 * pinned to the bottom of the terminal even when the content is shorter.
 */
export function composeView(
  layout: ListLayout,
  offset: number,
  viewportHeight: number,
): string {
  const { header, body, footer } = layout;
  const visible = body.slice(offset, offset + viewportHeight);
  while (visible.length < viewportHeight) visible.push('');
  const topSlot = offset > 0 ? pc.dim('  ↑ more') : '';
  const bottomSlot =
    offset + viewportHeight < body.length ? pc.dim('  ↓ more') : '';
  return [...header, topSlot, ...visible, bottomSlot, ...footer].join('\n');
}

/** Lines consumed by pinned regions: header + footer + the two indicator slots. */
function fixedHeight(layout: ListLayout): number {
  return layout.header.length + layout.footer.length + 2;
}

export function renderList(
  items: Worktree[],
  selectedIndex: number,
  query: string,
  mode: 'repo' | 'global',
  rows: number = process.stdout.rows ?? 24,
): string {
  const layout = buildListLayout(items, selectedIndex, query, mode);
  const viewport = Math.max(1, rows - fixedHeight(layout));
  const span = layout.itemSpans[selectedIndex] ?? { start: 0, end: 0 };
  const offset = clampScroll(0, span, viewport, layout.body.length);
  return composeView(layout, offset, viewport);
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

export async function runRepoPicker(
  repos: string[],
  initialRepo?: string,
): Promise<string | null> {
  const filterRepos = (all: string[], q: string): string[] =>
    q
      ? all.filter((p) =>
          path.basename(p).toLowerCase().includes(q.toLowerCase()),
        )
      : all;

  let query = '';
  let selectedIndex = initialRepo ? Math.max(0, repos.indexOf(initialRepo)) : 0;
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

export async function runBranchInput(
  repoRoot: string,
  initial = '',
): Promise<string | null> {
  let branch = initial;
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

/**
 * Run an ordered list of wizard steps with back-navigation. Each step resolves
 * `true` to advance to the next step or `false` to go back one step (e.g. the
 * user pressed Esc). Cancelling the first step resolves the whole wizard to
 * `false` so the caller can abort (return to the list). Resolves `true` once
 * every step has advanced. Steps are responsible for preserving their own input
 * so going back and forward doesn't lose work.
 */
export async function runWizard(
  steps: Array<() => Promise<boolean>>,
): Promise<boolean> {
  let i = 0;
  while (i < steps.length) {
    if (await steps[i]()) {
      i++;
    } else if (--i < 0) {
      return false;
    }
  }
  return true;
}

// ── Interactive TUI runner ──────────────────────────────────────────────────

export interface TuiHandlers {
  onOpen: (item: Worktree) => void;
  onDelete: (item: Worktree) => Promise<boolean>;
  onCreate: () => Promise<void>;
  onAgent: () => Promise<void>;
  /** Re-query worktrees after a create/agent so the list reflects the change. */
  refreshItems: () => Promise<Worktree[]>;
}

export async function runInteractiveList(
  allItems: Worktree[],
  mode: 'repo' | 'global',
  handlers: TuiHandlers,
): Promise<void> {
  let query = '';
  let selectedIndex = 0;
  let scrollOffset = 0;
  let filtered = allItems;

  const render = () => {
    const rows = process.stdout.rows ?? 24;
    const layout = buildListLayout(filtered, selectedIndex, query, mode);
    const viewport = Math.max(1, rows - fixedHeight(layout));
    const span = layout.itemSpans[selectedIndex] ?? { start: 0, end: 0 };
    scrollOffset = clampScroll(
      scrollOffset,
      span,
      viewport,
      layout.body.length,
    );
    process.stdout.write('\x1B[2J\x1B[H');
    process.stdout.write(composeView(layout, scrollOffset, viewport));
  };

  setupRawMode();
  render();

  return new Promise((resolve, reject) => {
    let listenerActive = false;

    const attachListener = () => {
      if (!listenerActive) {
        process.stdin.on('data', onData);
        process.stdout.on('resize', render);
        listenerActive = true;
      }
    };

    const detachListener = () => {
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', render);
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
          detachListener();
          cleanupRawMode();
          await handlers.onCreate();
          allItems = await handlers.refreshItems();
          filtered = filterItems(allItems, query);
          selectedIndex = Math.min(
            selectedIndex,
            Math.max(0, filtered.length - 1),
          );
          setupRawMode();
          attachListener();
          render();
        } else if (key === 'a' || key === 'A') {
          detachListener();
          cleanupRawMode();
          await handlers.onAgent();
          allItems = await handlers.refreshItems();
          filtered = filterItems(allItems, query);
          selectedIndex = Math.min(
            selectedIndex,
            Math.max(0, filtered.length - 1),
          );
          setupRawMode();
          attachListener();
          render();
        } else if (key === '\x7f') {
          query = query.slice(0, -1);
          filtered = filterItems(allItems, query);
          selectedIndex = 0;
          scrollOffset = 0;
          render();
        } else if (key.length === 1 && key >= ' ') {
          query += key;
          filtered = filterItems(allItems, query);
          selectedIndex = 0;
          scrollOffset = 0;
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
