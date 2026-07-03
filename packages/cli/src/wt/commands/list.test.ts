// src/commands/list.test.ts
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import type { Worktree } from '../lib/git.js';
import { prepareListItems, selectWipeCandidates } from './list.js';

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-list-')));
  repoDir = path.join(tmpDir, 'my-repo');
  execSync(`mkdir -p ${repoDir}`);
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "t@t.com"', { cwd: repoDir });
  execSync('git config user.name "T"', { cwd: repoDir });
  writeFileSync(path.join(repoDir, 'README.md'), '');
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('prepareListItems', () => {
  it("lists the repo's worktrees when cwd is inside it", async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const result = await prepareListItems({ cwd: repoDir, store });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((w) => w.repoRoot === repoDir)).toBe(true);
  });

  it('auto-registers the repo on first run', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    await prepareListItems({ cwd: repoDir, store });
    expect(store.get('repos')).toContain(repoDir);
  });

  it('does not register a linked worktree as a separate repo', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });

    await prepareListItems({ cwd: repoDir, store });
    await prepareListItems({ cwd: wtPath, store });

    const repos = store.get('repos') as string[];
    expect(repos).toContain(repoDir);
    expect(repos).not.toContain(wtPath);
    expect(repos.filter((r) => r === repoDir)).toHaveLength(1);
  });

  it('lists worktrees from registered repos regardless of cwd', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir] }, store);
    const result = await prepareListItems({ cwd: tmpDir, store });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].repoRoot).toBe(repoDir);
  });

  it('always lists all registered repos even from inside one of them', async () => {
    // Second registered repo, distinct from the cwd repo.
    const otherDir = path.join(tmpDir, 'other-repo');
    execSync(`mkdir -p ${otherDir}`);
    execSync('git init', { cwd: otherDir });
    execSync('git config user.email "t@t.com"', { cwd: otherDir });
    execSync('git config user.name "T"', { cwd: otherDir });
    writeFileSync(path.join(otherDir, 'README.md'), '');
    execSync('git add .', { cwd: otherDir });
    execSync('git commit -m "init"', { cwd: otherDir });

    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir, otherDir] }, store);

    // cwd is inside repoDir, yet the list must still include otherDir's worktrees.
    const result = await prepareListItems({ cwd: repoDir, store });
    const roots = new Set(result.items.map((w) => w.repoRoot));
    expect(roots.has(repoDir)).toBe(true);
    expect(roots.has(otherDir)).toBe(true);
  });

  it('marks no worktree as current when cwd is outside all repos', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir] }, store);
    const result = await prepareListItems({ cwd: tmpDir, store });
    expect(result.items.every((w) => !w.isCurrent)).toBe(true);
  });

  it('marks the current worktree when cwd is inside a registered worktree', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    setGlobalConfig({ repos: [repoDir] }, store);

    const result = await prepareListItems({ cwd: wtPath, store });
    const current = result.items.find((w) => w.isCurrent);
    expect(current?.path).toBe(wtPath);
  });
});

describe('selectWipeCandidates', () => {
  const wt = (over: Partial<Worktree>): Worktree => ({
    path: '/r/wt',
    branch: 'feature',
    isCurrent: false,
    isMain: false,
    repoRoot: '/r',
    ...over,
  });
  const allMerged = () => true;

  it('includes a merged linked worktree', () => {
    const items = [wt({ path: '/r/feature', branch: 'feature' })];
    expect(selectWipeCandidates(items, allMerged)).toEqual(items);
  });

  it('excludes the current worktree', () => {
    const items = [wt({ isCurrent: true })];
    expect(selectWipeCandidates(items, allMerged)).toEqual([]);
  });

  it('excludes the main worktree (isMain)', () => {
    const items = [wt({ path: '/r', repoRoot: '/r', isMain: true })];
    expect(selectWipeCandidates(items, allMerged)).toEqual([]);
  });

  it('excludes detached-HEAD worktrees', () => {
    const items = [wt({ branch: '(detached)' })];
    expect(selectWipeCandidates(items, allMerged)).toEqual([]);
  });

  it('excludes worktrees the predicate reports as not merged', () => {
    const items = [wt({ branch: 'feature' })];
    expect(selectWipeCandidates(items, () => false)).toEqual([]);
  });

  it('keeps only merged worktrees from a mixed list', () => {
    const merged = wt({ path: '/r/merged', branch: 'merged' });
    const unmerged = wt({ path: '/r/unmerged', branch: 'unmerged' });
    const main = wt({
      path: '/r',
      repoRoot: '/r',
      branch: 'main',
      isMain: true,
    });
    const result = selectWipeCandidates(
      [merged, unmerged, main],
      (w) => w.branch === 'merged' || w.branch === 'main',
    );
    expect(result).toEqual([merged]);
  });
});
