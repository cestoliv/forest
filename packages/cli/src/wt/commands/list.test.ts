// src/commands/list.test.ts
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import type { PullRequests } from '../lib/forge.js';
import { pullFfOnly, removeWorktree, type Worktree } from '../lib/git.js';
import { stopOrcaWorktree } from '../lib/orca.js';
import { runCommands } from '../lib/setup.js';
import {
  buildPrunePredicate,
  deleteWorktree,
  formatAge,
  formatPruneCard,
  type PruneDeps,
  type PruneMatch,
  prepareListItems,
  pullMainWorktrees,
  selectWipeCandidates,
  warnIfCwdRemoved,
  wipeWorktrees,
} from './list.js';
import { runPrune, watchPrune } from './prune.js';

// deleteWorktree prompts to confirm removal; auto-confirm so the teardown path
// runs. The pure list tests don't touch clack, so a module mock is safe.
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
  log: { warn: vi.fn() },
  note: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
  })),
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
  return {
    ...actual,
    removeWorktree: vi.fn(actual.removeWorktree),
    // Spy on the post-prune pull so tests can assert it without a real remote.
    pullFfOnly: vi.fn(() => {}),
  };
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

  it('still lists surviving worktrees when cwd no longer exists', async () => {
    // Regression: after pruning the worktree you were standing in, the TUI
    // auto-refresh re-runs with that captured, now-deleted cwd. `realpathSync`
    // on it must not throw and empty the whole list.
    const store = createStore(path.join(tmpDir, 'config'));
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    setGlobalConfig({ repos: [repoDir] }, store);
    removeWorktree(repoDir, wtPath);

    const result = await prepareListItems({ cwd: wtPath, store });
    expect(result.items.some((w) => w.repoRoot === repoDir)).toBe(true);
    expect(result.items.every((w) => !w.isCurrent)).toBe(true);
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

    expect(removed).toBe('removed');
    expect(existsSync(path.join(tmpDir, 'feature.teardown'))).toBe(true);
  });
});

describe('warnIfCwdRemoved', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns with a suggested existing target when cwd no longer exists', () => {
    const gone = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${gone}`, { cwd: repoDir });
    removeWorktree(repoDir, gone); // the worktree the shell was in is now gone
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnIfCwdRemoved(gone);

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain(gone);
    // Falls back to the nearest surviving ancestor (tmpDir still exists).
    expect(msg).toContain(tmpDir);
  });

  it('uses an explicit suggestion when given', () => {
    const gone = path.join(tmpDir, 'nope');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnIfCwdRemoved(gone, repoDir);

    expect(String(warn.mock.calls[0][0])).toContain(repoDir);
  });

  it('prints nothing when cwd still exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnIfCwdRemoved(repoDir);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('runPrune (dead-cwd warning wiring)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns on return to the shell when prune removes the cwd worktree', async () => {
    const base = execSync('git branch --show-current', {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    // A worktree whose branch is patch-present in base (squash-merge shape), so
    // the prune predicate offers it. It is also the cwd we hand to runPrune.
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    writeFileSync(path.join(wtPath, 'f.txt'), 'x');
    execSync('git add . && git commit -m "feat"', { cwd: wtPath });
    // Advance base first so the cherry-pick lands a distinct commit with the
    // same patch id (the squash-merge shape `git cherry` detects), not a no-op.
    writeFileSync(path.join(repoDir, 'other.txt'), 'y');
    execSync('git add . && git commit -m "other"', { cwd: repoDir });
    execSync('git cherry-pick feature', { cwd: repoDir });

    const store = createStore(path.join(tmpDir, 'config'));
    // Slashless base_branch → wipeWorktrees skips the (remote) fetch entirely.
    setGlobalConfig({ repos: [repoDir], base_branch: base }, store);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runPrune({ cwd: wtPath, store });

    expect(existsSync(wtPath)).toBe(false);
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes(wtPath)),
    ).toBe(true);
  });
});

describe('runPrune <branch>', () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    execSync('git branch -M main', { cwd: repoDir });
    store = createStore(path.join(tmpDir, 'config'));
    // Slashless base_branch → no fetch; no remote → no forge call.
    setGlobalConfig({ repos: [repoDir], base_branch: 'main' }, store);
    vi.mocked(clack.confirm).mockClear();
    vi.mocked(clack.log.warn).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** A worktree on `branch` holding one commit that is not in main. */
  function addUnmergedWorktree(branch: string, repo = repoDir): string {
    const wtPath = `${repo}-${branch}`;
    execSync(`git worktree add -b ${branch} ${wtPath}`, { cwd: repo });
    writeFileSync(path.join(wtPath, `${branch}.txt`), 'x');
    execSync('git add . && git commit -m "wip"', { cwd: wtPath });
    return wtPath;
  }

  it('removes a merged branch with the usual confirmation', async () => {
    const wtPath = addUnmergedWorktree('feature');
    writeFileSync(path.join(repoDir, 'other.txt'), 'y');
    execSync('git add . && git commit -m "other"', { cwd: repoDir });
    execSync('git cherry-pick feature', { cwd: repoDir });

    await runPrune({ branch: 'feature', cwd: repoDir, store });

    expect(existsSync(wtPath)).toBe(false);
    expect(clack.log.warn).not.toHaveBeenCalled();
    expect(vi.mocked(clack.confirm).mock.calls[0][0].initialValue).toBe(
      undefined,
    );
  });

  it('explains an unflagged branch and keeps it when the user declines', async () => {
    const wtPath = addUnmergedWorktree('stale');
    vi.mocked(clack.confirm).mockResolvedValueOnce(false);

    await runPrune({ branch: 'stale', cwd: repoDir, store });

    expect(existsSync(wtPath)).toBe(true);
    const reason = String(vi.mocked(clack.log.warn).mock.calls[0][0]);
    expect(reason).toContain('1 unique commit(s) not in main');
    expect(reason).toContain('never pushed to origin');
    expect(vi.mocked(clack.confirm).mock.calls[0][0].initialValue).toBe(false);
  });

  it('removes an unflagged branch when the user accepts', async () => {
    const wtPath = addUnmergedWorktree('stale');

    await runPrune({ branch: 'stale', cwd: repoDir, store });

    expect(existsSync(wtPath)).toBe(false);
    // The branch itself stays.
    expect(
      execSync('git branch --list stale', { cwd: repoDir, encoding: 'utf8' }),
    ).toContain('stale');
  });

  it('force-removes a dirty worktree without any prompt under --yes', async () => {
    const wtPath = addUnmergedWorktree('dirty');
    writeFileSync(path.join(wtPath, 'dirty.txt'), 'changed');
    writeFileSync(path.join(wtPath, 'untracked.txt'), 'new');

    await runPrune({ branch: 'dirty', cwd: repoDir, store, yes: true });

    expect(existsSync(wtPath)).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(String(vi.mocked(clack.log.warn).mock.calls[0][0])).toContain(
      'uncommitted changes',
    );
  });

  it('fails when no worktree holds the branch', async () => {
    await expect(
      runPrune({ branch: 'nope', cwd: repoDir, store }),
    ).rejects.toThrow('No worktree is checked out on nope.');
  });

  it('refuses the main worktree', async () => {
    await expect(
      runPrune({ branch: 'main', cwd: repoDir, store, yes: true }),
    ).rejects.toThrow('main worktree');
    expect(existsSync(path.join(repoDir, 'README.md'))).toBe(true);
  });

  it('asks for --repo when several repos match, and honours it', async () => {
    const otherRepo = path.join(tmpDir, 'other-repo');
    execSync(`git init -b main ${otherRepo}`);
    execSync(
      'git -c user.email=t@t.com -c user.name=T commit --allow-empty -m init',
      {
        cwd: otherRepo,
      },
    );
    setGlobalConfig({ repos: [repoDir, otherRepo] }, store);
    const mine = addUnmergedWorktree('shared');
    const theirs = `${otherRepo}-shared`;
    execSync(`git worktree add -b shared ${theirs}`, { cwd: otherRepo });

    await expect(
      runPrune({ branch: 'shared', cwd: repoDir, store }),
    ).rejects.toThrow('--repo');

    await runPrune({
      branch: 'shared',
      repo: otherRepo,
      cwd: repoDir,
      store,
      yes: true,
    });
    expect(existsSync(theirs)).toBe(false);
    expect(existsSync(mine)).toBe(true);
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
    expect(await deleteWorktree(item, store)).toBe('removed');

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

    expect(await deleteWorktree(makeWorktree(), store)).toBe('declined');

    expect(stopOrcaWorktree).not.toHaveBeenCalled();
    expect(runCommands).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('never stops the worktree in Orca when the delete confirm is cancelled', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ teardown_commands: ['true'] }, store);
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);

    expect(await deleteWorktree(makeWorktree(), store)).toBe('cancelled');

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
    expect(await deleteWorktree(item, store)).toBe('removed');
    expect(removeWorktree).toHaveBeenCalled();
    expect(existsSync(wtPath)).toBe(false);
  });

  it('also runs on the prune path (wipeWorktrees)', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const item = makeMergedWorktree();
    setGlobalConfig({ base_branch: 'main', repos: [repoDir] }, store);

    const { removed } = await wipeWorktrees([item], store);

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

  const prs = (over: Partial<PullRequests> = {}): PullRequests => ({
    merged: false,
    closed: false,
    latest: {
      number: 12,
      title: 'feat: x',
      url: 'https://github.com/o/r/pull/12',
      state: 'merged',
    },
    ...over,
  });

  /** Stub every git/forge call, recording which ones were consulted. */
  const stubDeps = (answers: {
    merged?: boolean;
    noUnique?: boolean;
    dirty?: number;
    pushed?: boolean;
    pullRequests?: PullRequests | null;
  }) => {
    const called = new Set<keyof PruneDeps>();
    let forgeArgs: string[] = [];
    const deps: PruneDeps = {
      isBranchMerged: async () => {
        called.add('isBranchMerged');
        return answers.merged ?? false;
      },
      hasNoUniqueCommits: async () => {
        called.add('hasNoUniqueCommits');
        return answers.noUnique ?? false;
      },
      countDirtyFiles: async () => answers.dirty ?? 1,
      hasRemoteTrackingRef: async () => answers.pushed ?? false,
      fetchPullRequests: async (_repo, _branch, baseLocal, remote) => {
        called.add('fetchPullRequests');
        forgeArgs = [baseLocal, remote ?? ''];
        return answers.pullRequests ?? null;
      },
      countCommitsAhead: async () => 3,
      lastCommitAge: async () => '2 days ago',
    };
    return { deps, called, forgeArgs: () => forgeArgs };
  };

  const storeWithBase = (base = 'origin/main') => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ base_branch: base }, store);
    return store;
  };

  it('never prunes a worktree on the base branch itself, without asking any signal', async () => {
    const { deps, called } = stubDeps({ merged: true });
    expect(
      await buildPrunePredicate(
        storeWithBase(),
        deps,
      )(wt({ branch: 'origin/main' })),
    ).toBeNull();
    expect(called.size).toBe(0);
  });

  it('never prunes a worktree on the local base branch', async () => {
    const { deps } = stubDeps({ merged: true });
    expect(
      await buildPrunePredicate(storeWithBase(), deps)(wt({ branch: 'main' })),
    ).toBeNull();
  });

  it('reports `patch` with the card data, and skips the forge for an unpushed branch', async () => {
    const { deps, called } = stubDeps({ merged: true, dirty: 0 });
    expect(await buildPrunePredicate(storeWithBase(), deps)(wt())).toEqual({
      reason: 'patch',
      base: 'main',
      pullRequests: null,
      ahead: 3,
      lastCommit: '2 days ago',
      dirtyFiles: 0,
    });
    expect(called.has('fetchPullRequests')).toBe(false);
  });

  it('reports `fast-forward` for a clean, pushed branch with no unique commits, and asks the forge for the card', async () => {
    const { deps } = stubDeps({
      noUnique: true,
      dirty: 0,
      pushed: true,
      pullRequests: prs(),
    });
    const match = await buildPrunePredicate(storeWithBase(), deps)(wt());
    expect(match?.reason).toBe('fast-forward');
    expect(match?.pullRequests?.latest?.number).toBe(12);
  });

  it('does not prune a dirty worktree with no unique commits', async () => {
    // Only uncommitted work: identical to a merged fast-forward at the branch
    // level, so the dirty state is what keeps it. Falls through to the forge.
    const { deps, called } = stubDeps({
      noUnique: true,
      dirty: 2,
      pushed: true,
    });
    expect(await buildPrunePredicate(storeWithBase(), deps)(wt())).toBeNull();
    expect(called.has('fetchPullRequests')).toBe(true);
  });

  it('does not prune, nor ask the forge about, a never-pushed branch', async () => {
    // A just-created `wt create foo` worktree must survive `wt prune`, and a
    // branch with no remote-tracking ref cannot have a PR/MR.
    const { deps, called } = stubDeps({ noUnique: true, dirty: 0 });
    expect(await buildPrunePredicate(storeWithBase(), deps)(wt())).toBeNull();
    expect(called.has('fetchPullRequests')).toBe(false);
  });

  it('reports `pr-merged` for a branch only the forge knows is merged, asking with the local base and the remote', async () => {
    const { deps, forgeArgs } = stubDeps({
      pushed: true,
      pullRequests: prs({ merged: true }),
    });
    const match = await buildPrunePredicate(
      storeWithBase('upstream/release/1.x'),
      deps,
    )(wt());
    expect(match?.reason).toBe('pr-merged');
    expect(match?.base).toBe('release/1.x');
    expect(forgeArgs()).toEqual(['release/1.x', 'upstream']);
  });

  it('reports `pr-closed` for a branch whose PR/MR was closed without merging', async () => {
    const { deps } = stubDeps({
      pushed: true,
      pullRequests: prs({ closed: true }),
    });
    expect(
      (await buildPrunePredicate(storeWithBase(), deps)(wt()))?.reason,
    ).toBe('pr-closed');
  });

  it('does not prune when every signal says no, or the forge gave no data', async () => {
    const { deps } = stubDeps({ pushed: true, pullRequests: null });
    expect(await buildPrunePredicate(storeWithBase(), deps)(wt())).toBeNull();
    const { deps: noSignal } = stubDeps({ pushed: true, pullRequests: prs() });
    expect(
      await buildPrunePredicate(storeWithBase(), noSignal)(wt()),
    ).toBeNull();
  });
});

describe('formatPruneCard', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const item: Worktree = {
    path: path.join(homedir(), 'dev', 'repo-feat'),
    branch: 'feat',
    isCurrent: false,
    isMain: false,
    repoRoot: '/r',
  };
  const match: PruneMatch = {
    reason: 'pr-merged',
    base: 'main',
    pullRequests: {
      merged: true,
      closed: false,
      latest: {
        number: 123,
        title: 'feat(auth): add SSO login',
        url: 'https://github.com/org/repo/pull/123',
        state: 'merged',
        endedAt: '2026-10-06T12:00:00Z',
      },
    },
    ahead: 4,
    lastCommit: '5 days ago',
    dirtyFiles: 0,
  };
  // Strip colours so the assertions read the text.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('shows reason, PR, link, status, commits, path and state', () => {
    const card = plain(formatPruneCard(item, match, now));
    expect(card).toContain('Reason   PR merged into main');
    expect(card).toContain('PR       #123 feat(auth): add SSO login');
    expect(card).toContain('https://github.com/org/repo/pull/123');
    expect(card).toContain('Status   merged 3 days ago');
    expect(card).toContain('Commits  4 ahead of main · last commit 5 days ago');
    expect(card).toContain('Path     ~/dev/repo-feat');
    expect(card).toContain('State    clean');
  });

  it('keeps the PR line when the forge gave no data, and counts dirty files', () => {
    const card = plain(
      formatPruneCard(
        item,
        { ...match, reason: 'patch', pullRequests: null, dirtyFiles: 3 },
        now,
      ),
    );
    expect(card).toContain('Reason   merged (patch in main)');
    expect(card).toContain('PR       none found');
    expect(card).not.toContain('Status');
    expect(card).toContain('State    3 uncommitted file(s)');
  });

  it('formats ages with the largest unit', () => {
    expect(formatAge('2026-10-08T12:00:00Z', now)).toBe('yesterday');
    expect(formatAge('2026-10-09T11:30:00Z', now)).toBe('30 minutes ago');
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

  it('includes linked worktrees, the current one too (prune is path-independent)', () => {
    const items = [wt({}), wt({ path: '/r/cur', isCurrent: true })];
    expect(selectWipeCandidates(items)).toEqual(items);
  });

  it('excludes the main worktree (isMain)', () => {
    expect(
      selectWipeCandidates([wt({ path: '/r', repoRoot: '/r', isMain: true })]),
    ).toEqual([]);
  });

  it('excludes detached-HEAD worktrees', () => {
    expect(selectWipeCandidates([wt({ branch: '(detached)' })])).toEqual([]);
  });
});

describe('wipeWorktrees (streaming)', () => {
  const wt = (branch: string): Worktree => ({
    path: `/r/${branch}`,
    branch,
    isCurrent: false,
    isMain: false,
    repoRoot: '/r',
  });

  /** Every worktree is merged by patch id; `gate` holds one branch's check. */
  const depsWithGate = (
    gated: string,
    gate: Promise<void>,
    onResolved: () => void,
  ): Partial<PruneDeps> => ({
    isBranchMerged: async (_repo, branch) => {
      if (branch === gated) {
        await gate;
        onResolved();
      }
      return true;
    },
    countDirtyFiles: async () => 0,
    hasRemoteTrackingRef: async () => false,
    countCommitsAhead: async () => 1,
    lastCommitAge: async () => 'now',
  });

  beforeEach(() => {
    vi.mocked(clack.confirm).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('prompts for a fast check before a slow one resolves', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let slowResolved = false;
    let promptedBeforeSlow = false;
    vi.mocked(clack.confirm)
      .mockImplementationOnce(async () => {
        promptedBeforeSlow = !slowResolved;
        release();
        return false;
      })
      .mockResolvedValueOnce(false);

    const result = await wipeWorktrees([wt('slow'), wt('fast')], store, {
      deps: depsWithGate('slow', gate, () => {
        slowResolved = true;
      }),
    });

    expect(promptedBeforeSlow).toBe(true);
    // Declining moves on to the next candidate.
    expect(clack.confirm).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ removed: [], cancelled: false });
  });

  it('stops at a cancelled prompt: no later prompt, no pull', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);

    const result = await wipeWorktrees([wt('a'), wt('b'), wt('c')], store, {
      deps: depsWithGate('none', Promise.resolve(), () => {}),
    });

    expect(clack.confirm).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ removed: [], cancelled: true });
  });

  it('stops when Ctrl-C hits the spinner', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const gate = new Promise<void>(() => {}); // never resolves
    vi.mocked(clack.spinner).mockImplementationOnce((opts) => ({
      start: () => opts?.onCancel?.(),
      stop: vi.fn(),
      message: vi.fn(),
      clear: vi.fn(),
      cancel: vi.fn(),
      error: vi.fn(),
      isCancelled: true,
    }));

    const result = await wipeWorktrees([wt('slow')], store, {
      deps: depsWithGate('slow', gate, () => {}),
    });

    expect(result).toEqual({ removed: [], cancelled: true });
    expect(clack.confirm).not.toHaveBeenCalled();
  });
});

describe('pullMainWorktrees', () => {
  const wt = (over: Partial<Worktree>): Worktree => ({
    path: '/r/wt',
    branch: 'feature',
    isCurrent: false,
    isMain: false,
    repoRoot: '/r',
    ...over,
  });
  const mainWt = (repoRoot: string, over: Partial<Worktree> = {}): Worktree =>
    wt({ path: repoRoot, repoRoot, branch: 'main', isMain: true, ...over });

  // base_branch `origin/main` → splitBaseRef → { remote: 'origin', branch: 'main' }.
  const storeWithBase = () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ base_branch: 'origin/main' }, store);
    return store;
  };
  const okDeps = (pull: (p: string) => void) => ({
    pull,
    isWorktreeClean: () => true,
    remoteExists: () => true,
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('pulls the main worktree of a pruned repo', async () => {
    const pull = vi.fn();
    await pullMainWorktrees(
      [mainWt('/r'), wt({})],
      new Set(['/r']),
      storeWithBase(),
      okDeps(pull),
    );
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith('/r');
  });

  it('skips a repo whose main is not on the base branch, still pulls the others', async () => {
    const pull = vi.fn();
    await pullMainWorktrees(
      [mainWt('/a', { branch: 'wip' }), mainWt('/b')],
      new Set(['/a', '/b']),
      storeWithBase(),
      okDeps(pull),
    );
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith('/b');
  });

  it('skips a repo whose main worktree is missing', async () => {
    const pull = vi.fn();
    await pullMainWorktrees([wt({})], new Set(['/r']), storeWithBase(), {
      ...okDeps(pull),
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it('skips a dirty main worktree', async () => {
    const pull = vi.fn();
    await pullMainWorktrees([mainWt('/r')], new Set(['/r']), storeWithBase(), {
      pull,
      isWorktreeClean: () => false,
      remoteExists: () => true,
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it('skips a repo with no matching remote', async () => {
    const pull = vi.fn();
    await pullMainWorktrees([mainWt('/r')], new Set(['/r']), storeWithBase(), {
      pull,
      isWorktreeClean: () => true,
      remoteExists: () => false,
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it('does not let a thrown pull abort the other repos', async () => {
    const pull = vi.fn((p: string) => {
      if (p === '/a') throw new Error('diverged');
    });
    await expect(
      pullMainWorktrees(
        [mainWt('/a'), mainWt('/b')],
        new Set(['/a', '/b']),
        storeWithBase(),
        okDeps(pull),
      ),
    ).resolves.toBeUndefined();
    expect(pull).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledWith('/b');
  });

  it('pulls a repo once even with multiple pruned worktrees', async () => {
    const pull = vi.fn();
    await pullMainWorktrees(
      [mainWt('/r'), wt({ path: '/r/f1' }), wt({ path: '/r/f2' })],
      new Set(['/r']),
      storeWithBase(),
      okDeps(pull),
    );
    expect(pull).toHaveBeenCalledTimes(1);
  });
});

describe('wipeWorktrees (post-prune pull)', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * A merged worktree on `branch`, patch-present in `main`. Mirrors the gotcha
   * in `makeMergedWorktree`: advance `main` with an unrelated commit before the
   * cherry-pick so the same patch lands under a different sha.
   */
  function makeMerged(branch: string): Worktree {
    const wtPath = path.join(tmpDir, `my-repo-${branch}`);
    execSync(`git worktree add -b ${branch} ${wtPath}`, { cwd: repoDir });
    writeFileSync(path.join(wtPath, `${branch}.txt`), 'x');
    execSync('git add .', { cwd: wtPath });
    execSync(`git commit -m "feat ${branch}"`, { cwd: wtPath });
    writeFileSync(path.join(repoDir, `other-${branch}.txt`), 'y');
    execSync('git add .', { cwd: repoDir });
    execSync(`git commit -m "other ${branch}"`, { cwd: repoDir });
    execSync(`git cherry-pick ${branch}`, { cwd: repoDir });
    return {
      path: wtPath,
      branch,
      isCurrent: false,
      isMain: false,
      repoRoot: repoDir,
    };
  }

  const mainItem = (): Worktree => ({
    path: repoDir,
    branch: 'main',
    isCurrent: false,
    isMain: true,
    repoRoot: repoDir,
  });

  beforeEach(() => {
    execSync('git branch -M main', { cwd: repoDir });
    // remoteExists is real on the pull path; a self-pointing origin satisfies it
    // (pullFfOnly itself is mocked, so no real fetch happens).
    execSync(`git remote add origin ${repoDir}`, { cwd: repoDir });
    vi.mocked(pullFfOnly).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('pulls the main worktree once after a successful wipe (default)', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const feature = makeMerged('feature');
    setGlobalConfig({ base_branch: 'main', repos: [repoDir] }, store);

    const { removed } = await wipeWorktrees([mainItem(), feature], store);

    expect(removed.map((w) => w.branch)).toEqual(['feature']);
    expect(pullFfOnly).toHaveBeenCalledTimes(1);
    expect(pullFfOnly).toHaveBeenCalledWith(repoDir);
  });

  it('does not pull when { pull: false }', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const feature = makeMerged('feature');
    setGlobalConfig({ base_branch: 'main', repos: [repoDir] }, store);

    const { removed } = await wipeWorktrees([mainItem(), feature], store, {
      pull: false,
    });

    expect(removed.map((w) => w.branch)).toEqual(['feature']);
    expect(pullFfOnly).not.toHaveBeenCalled();
  });

  it('runs no pull after a cancel, even when a worktree was removed', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const f1 = makeMerged('feat-one');
    const f2 = makeMerged('feat-two');
    const f3 = makeMerged('feat-three');
    setGlobalConfig({ base_branch: 'main', repos: [repoDir] }, store);
    vi.mocked(clack.confirm).mockClear();
    vi.mocked(clack.isCancel)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const result = await wipeWorktrees([mainItem(), f1, f2, f3], store);

    expect(result.cancelled).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect(clack.confirm).toHaveBeenCalledTimes(2);
    expect(pullFfOnly).not.toHaveBeenCalled();
  });

  it('pulls the repo once even when several worktrees were pruned', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const f1 = makeMerged('feat-one');
    const f2 = makeMerged('feat-two');
    setGlobalConfig({ base_branch: 'main', repos: [repoDir] }, store);

    const { removed } = await wipeWorktrees([mainItem(), f1, f2], store);

    expect(removed.map((w) => w.branch).sort()).toEqual([
      'feat-one',
      'feat-two',
    ]);
    expect(pullFfOnly).toHaveBeenCalledTimes(1);
    expect(pullFfOnly).toHaveBeenCalledWith(repoDir);
  });
});

describe('watchPrune', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('waits the interval between passes and stops on a cancelled pass', async () => {
    const results = [false, false, true];
    const pass = vi.fn(async () => results.shift() ?? true);
    const sleep = vi.fn(async () => true);

    expect(await watchPrune(pass, 2, sleep)).toBe(true);

    expect(pass).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(120_000);
  });

  it('stops without a cancel when Ctrl-C ends the wait', async () => {
    const pass = vi.fn(async () => false);
    expect(await watchPrune(pass, 1, async () => false)).toBe(false);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('prints the next check time', async () => {
    const log = vi.spyOn(console, 'log');
    await watchPrune(
      async () => false,
      5,
      async () => false,
      () => new Date(2026, 9, 9, 14, 30),
    );
    expect(String(log.mock.calls[0][0])).toContain(
      'next check at 14:35 (every 5 min)',
    );
  });
});

describe('runPrune --watch', () => {
  beforeEach(() => {
    execSync('git branch -M main', { cwd: repoDir });
    vi.mocked(clack.confirm).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('asks again on the next pass for a worktree declined before', async () => {
    const wtPath = path.join(tmpDir, 'my-repo-feature');
    execSync(`git worktree add -b feature ${wtPath}`, { cwd: repoDir });
    writeFileSync(path.join(wtPath, 'f.txt'), 'x');
    execSync('git add . && git commit -m "feat"', { cwd: wtPath });
    writeFileSync(path.join(repoDir, 'other.txt'), 'y');
    execSync('git add . && git commit -m "other"', { cwd: repoDir });
    execSync('git cherry-pick feature', { cwd: repoDir });
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir], base_branch: 'main' }, store);
    vi.mocked(clack.confirm)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const waits = [true, false];
    const sleep = vi.fn(async () => waits.shift() ?? false);

    const cancelled = await runPrune({
      cwd: repoDir,
      store,
      watch: true,
      interval: 1,
      sleep,
    });

    expect(cancelled).toBe(false);
    expect(clack.confirm).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('rejects an interval that is not a positive number', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir] }, store);
    await expect(
      runPrune({ cwd: repoDir, store, watch: true, interval: 0 }),
    ).rejects.toThrow('positive number');
    await expect(
      runPrune({ cwd: repoDir, store, interval: 5 }),
    ).rejects.toThrow('--interval needs --watch');
  });
});
