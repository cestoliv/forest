// src/commands/list.test.ts
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import { removeWorktree, type Worktree } from '../lib/git.js';
import { stopOrcaWorktree } from '../lib/orca.js';
import { runCommands } from '../lib/setup.js';
import {
  buildPrunePredicate,
  deleteWorktree,
  type PruneDeps,
  prepareListItems,
  selectWipeCandidates,
  wipeWorktrees,
} from './list.js';

// deleteWorktree prompts to confirm removal; auto-confirm so the teardown path
// runs. The pure list tests don't touch clack, so a module mock is safe.
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
  log: { warn: vi.fn() },
}));

// No `orca` process is ever spawned from tests; the real behaviour lives in
// orca.test.ts. Here we only observe that deleteWorktree calls it (and when).
vi.mock('../lib/orca.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/orca.js')>()),
  stopOrcaWorktree: vi.fn(async () => {}),
}));

// Keep the real implementations (the git/teardown behaviour is under test) but
// make the calls observable so their relative ordering can be asserted.
vi.mock('../lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/git.js')>();
  return { ...actual, removeWorktree: vi.fn(actual.removeWorktree) };
});
vi.mock('../lib/setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/setup.js')>();
  return { ...actual, runCommands: vi.fn(actual.runCommands) };
});

/** vitest records a global, monotonically increasing invocation index per call. */
function firstCallOrder(fn: unknown): number {
  return (fn as { mock: { invocationCallOrder: number[] } }).mock
    .invocationCallOrder[0];
}

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

describe('deleteWorktree (teardown templating)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('expands {{…}} template variables in teardown commands', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      // {{branch}} must be expanded before the teardown command runs.
      { teardown_commands: [`touch ${tmpDir}/{{branch}}.teardown`] },
      store,
    );
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const item: Worktree = {
      path: wtPath,
      branch: 'feature',
      isCurrent: false,
      isMain: false,
      repoRoot: repoDir,
    };
    const removed = await deleteWorktree(item, store);

    expect(removed).toBe(true);
    expect(existsSync(path.join(tmpDir, 'feature.teardown'))).toBe(true);
  });
});

describe('deleteWorktree (Orca teardown)', () => {
  beforeEach(() => {
    vi.mocked(stopOrcaWorktree).mockClear();
    vi.mocked(removeWorktree).mockClear();
    vi.mocked(runCommands).mockClear();
    vi.mocked(stopOrcaWorktree).mockImplementation(async () => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** A worktree on `feature`, whose branch is patch-present in `main` (merged). */
  function makeMergedWorktree(): Worktree {
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync('git branch -M main', { cwd: repoDir });
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    writeFileSync(path.join(wtPath, 'f.txt'), 'x');
    execSync('git add .', { cwd: wtPath });
    execSync('git commit -m "feat"', { cwd: wtPath });
    // Advance main first so the cherry-pick can't fast-forward, then land the
    // same patch under a different sha (the squash-merge shape `git cherry` sees).
    writeFileSync(path.join(repoDir, 'other.txt'), 'y');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "other"', { cwd: repoDir });
    execSync('git cherry-pick feature', { cwd: repoDir });
    return {
      path: wtPath,
      branch: 'feature',
      isCurrent: false,
      isMain: false,
      repoRoot: repoDir,
    };
  }

  it('stops the worktree in Orca before teardown commands and before git removal', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ teardown_commands: ['true'] }, store);
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });

    const item: Worktree = {
      path: wtPath,
      branch: 'feature',
      isCurrent: false,
      isMain: false,
      repoRoot: repoDir,
    };
    expect(await deleteWorktree(item, store)).toBe(true);

    expect(stopOrcaWorktree).toHaveBeenCalledWith({ worktreePath: wtPath });
    expect(firstCallOrder(stopOrcaWorktree)).toBeLessThan(
      firstCallOrder(runCommands),
    );
    expect(firstCallOrder(runCommands)).toBeLessThan(
      firstCallOrder(removeWorktree),
    );
  });

  /** A plain (unmerged) worktree on `feature`, for the confirm-decline tests. */
  function makeWorktree(): Worktree {
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    return {
      path: wtPath,
      branch: 'feature',
      isCurrent: false,
      isMain: false,
      repoRoot: repoDir,
    };
  }

  it('never stops the worktree in Orca when the delete confirm is declined', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ teardown_commands: ['true'] }, store);
    vi.mocked(clack.confirm).mockResolvedValueOnce(false);

    expect(await deleteWorktree(makeWorktree(), store)).toBe(false);

    expect(stopOrcaWorktree).not.toHaveBeenCalled();
    expect(runCommands).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('never stops the worktree in Orca when the delete confirm is cancelled', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ teardown_commands: ['true'] }, store);
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);

    expect(await deleteWorktree(makeWorktree(), store)).toBe(false);

    expect(stopOrcaWorktree).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('removes the worktree even when the Orca stop throws', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    vi.mocked(stopOrcaWorktree).mockRejectedValueOnce(
      new Error('orca blew up'),
    );
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });

    const item: Worktree = {
      path: wtPath,
      branch: 'feature',
      isCurrent: false,
      isMain: false,
      repoRoot: repoDir,
    };
    expect(await deleteWorktree(item, store)).toBe(true);
    expect(removeWorktree).toHaveBeenCalled();
    expect(existsSync(wtPath)).toBe(false);
  });

  it('also runs on the prune path (wipeWorktrees)', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const item = makeMergedWorktree();
    setGlobalConfig({ base_branch: 'main', repos: [repoDir] }, store);

    const removed = await wipeWorktrees([item], store);

    expect(removed.map((w) => w.branch)).toEqual(['feature']);
    expect(stopOrcaWorktree).toHaveBeenCalledWith({
      worktreePath: item.path,
    });
  });
});

describe('buildPrunePredicate', () => {
  const wt = (over: Partial<Worktree> = {}): Worktree => ({
    path: '/r/wt',
    branch: 'feature',
    isCurrent: false,
    isMain: false,
    repoRoot: '/r',
    ...over,
  });

  /** Stub every signal to a fixed answer, recording which ones were consulted. */
  const stubDeps = (
    answers: Partial<Record<keyof PruneDeps, boolean>>,
  ): { deps: PruneDeps; called: Set<keyof PruneDeps> } => {
    const called = new Set<keyof PruneDeps>();
    const stub = (name: keyof PruneDeps) => () => {
      called.add(name);
      return answers[name] ?? false;
    };
    return {
      deps: {
        isBranchMerged: stub('isBranchMerged'),
        hasNoUniqueCommits: stub('hasNoUniqueCommits'),
        isWorktreeClean: stub('isWorktreeClean'),
        hasRemoteTrackingRef: stub('hasRemoteTrackingRef'),
        isBranchMergedOnForge: stub('isBranchMergedOnForge'),
        isBranchClosed: stub('isBranchClosed'),
      },
      called,
    };
  };

  const storeWithBase = () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ base_branch: 'origin/main' }, store);
    return store;
  };

  it('never prunes a worktree on the base branch itself, without asking any signal', () => {
    const { deps, called } = stubDeps({ isBranchMerged: true });
    expect(
      buildPrunePredicate(storeWithBase(), deps)(wt({ branch: 'origin/main' })),
    ).toBe(false);
    expect(called.size).toBe(0);
  });

  it('never prunes a worktree on the local base branch', () => {
    const { deps } = stubDeps({ isBranchMerged: true });
    expect(
      buildPrunePredicate(storeWithBase(), deps)(wt({ branch: 'main' })),
    ).toBe(false);
  });

  it('prunes a branch git proves merged, without any forge call', () => {
    const { deps, called } = stubDeps({ isBranchMerged: true });
    expect(buildPrunePredicate(storeWithBase(), deps)(wt())).toBe(true);
    expect(called.has('isBranchMergedOnForge')).toBe(false);
    expect(called.has('isBranchClosed')).toBe(false);
  });

  it('prunes a clean, pushed branch with no unique commits, without any forge call', () => {
    const { deps, called } = stubDeps({
      hasNoUniqueCommits: true,
      isWorktreeClean: true,
      hasRemoteTrackingRef: true,
    });
    expect(buildPrunePredicate(storeWithBase(), deps)(wt())).toBe(true);
    expect(called.has('isBranchMergedOnForge')).toBe(false);
    expect(called.has('isBranchClosed')).toBe(false);
  });

  it('does not prune a dirty worktree with no unique commits', () => {
    // Only uncommitted work: identical to a merged fast-forward at the branch
    // level, so the dirty state is what keeps it. Falls through to the forge.
    const { deps, called } = stubDeps({
      hasNoUniqueCommits: true,
      isWorktreeClean: false,
      hasRemoteTrackingRef: true,
    });
    expect(buildPrunePredicate(storeWithBase(), deps)(wt())).toBe(false);
    expect(called.has('isBranchMergedOnForge')).toBe(true);
  });

  it('does not prune a never-pushed branch with no unique commits', () => {
    // A just-created `wt create foo` worktree must survive `wt prune`.
    const { deps, called } = stubDeps({
      hasNoUniqueCommits: true,
      isWorktreeClean: true,
      hasRemoteTrackingRef: false,
    });
    expect(buildPrunePredicate(storeWithBase(), deps)(wt())).toBe(false);
    expect(called.has('isBranchMergedOnForge')).toBe(true);
  });

  it('prunes a branch only the forge knows is merged (rebased squash)', () => {
    const { deps } = stubDeps({ isBranchMergedOnForge: true });
    expect(buildPrunePredicate(storeWithBase(), deps)(wt())).toBe(true);
  });

  it('prunes a branch whose PR/MR was closed without merging', () => {
    const { deps } = stubDeps({ isBranchClosed: true });
    expect(buildPrunePredicate(storeWithBase(), deps)(wt())).toBe(true);
  });

  it('does not prune when every signal says no', () => {
    const { deps } = stubDeps({});
    expect(buildPrunePredicate(storeWithBase(), deps)(wt())).toBe(false);
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
