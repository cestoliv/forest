import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCapacity, listWorktreeBranches } from './capacity.js';
import { type AgentSpawnerConfig, DEFAULT_CONFIG } from './config.js';

const base: AgentSpawnerConfig = {
  token: 't',
  pollIntervalSeconds: 600,
  branchPrefix: 'agent/',
  promptTemplate: "Let's tackle this task {{url}}",
  labels: { ready: '1', working: '2', error: '3' },
  maxWorktrees: 0,
  maxWorktreesPerRepo: {},
  // The usage gate is off, so these cases make no network call.
  usage: { ...DEFAULT_CONFIG.usage, enabled: false },
  rules: [
    { project: 'OVL', path: '/repos/mobile' },
    { project: 'OVL', path: '/repos/backend' },
  ],
};

describe('listWorktreeBranches', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    // Resolve symlinks so paths match git's canonical output (macOS /var -> /private/var)
    tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'as-cap-')));
    repoDir = path.join(tmpDir, 'repo');
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

  it('leaves out the main checkout', () => {
    expect(listWorktreeBranches(repoDir)).toEqual([]);
  });

  it('names the branch of every linked worktree', () => {
    execSync(`git worktree add -b one ${path.join(tmpDir, 'one')}`, {
      cwd: repoDir,
    });
    execSync(`git worktree add -b two ${path.join(tmpDir, 'two')}`, {
      cwd: repoDir,
    });
    expect(listWorktreeBranches(repoDir).sort()).toEqual(['one', 'two']);
  });

  it('reads a path that is not a repo as holding nothing', () => {
    expect(listWorktreeBranches(path.join(tmpDir, 'nope'))).toEqual([]);
  });

  it('leaves out a worktree whose directory is gone', () => {
    const gone = path.join(tmpDir, 'gone');
    execSync(`git worktree add -b gone ${gone}`, { cwd: repoDir });
    // `rm -rf` leaves the entry in `git worktree list`, flagged prunable, until
    // someone runs `git worktree prune`. It must not hold the cap.
    rmSync(gone, { recursive: true, force: true });
    expect(listWorktreeBranches(repoDir)).toEqual([]);
  });

  it('gives a detached worktree an empty branch, so it matches none', () => {
    const head = execSync('git rev-parse HEAD', {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    execSync(`git worktree add --detach ${path.join(tmpDir, 'det')} ${head}`, {
      cwd: repoDir,
    });
    expect(listWorktreeBranches(repoDir)).toEqual(['']);
  });
});

describe('checkCapacity', () => {
  // Build a reader from a count: the branch names don't matter to a cap, only
  // how many there are, so `n` stands in for n worktrees on other branches.
  const held =
    (counts: Record<string, number>) =>
    (repoPath: string): string[] =>
      Array.from({ length: counts[repoPath] ?? 0 }, (_, i) => `held-${i}`);

  it('leaves both caps unlimited at 0', () => {
    const worktrees = held({ '/repos/mobile': 99, '/repos/backend': 99 });
    expect(
      checkCapacity(base, '/repos/mobile', 'agent/new', worktrees),
    ).toBeNull();
  });

  it('blocks when the repo reached its own cap', () => {
    const config = { ...base, maxWorktreesPerRepo: { '/repos/mobile': 2 } };
    const worktrees = held({ '/repos/mobile': 2 });
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees),
    ).toMatch(/repo at cap \(2\/2\)/);
  });

  it('allows the repo one below its own cap', () => {
    const config = { ...base, maxWorktreesPerRepo: { '/repos/mobile': 2 } };
    const worktrees = held({ '/repos/mobile': 1 });
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees),
    ).toBeNull();
  });

  it("ignores another repo's cap", () => {
    const config = { ...base, maxWorktreesPerRepo: { '/repos/mobile': 1 } };
    const worktrees = held({ '/repos/mobile': 5, '/repos/backend': 0 });
    expect(
      checkCapacity(config, '/repos/backend', 'agent/new', worktrees),
    ).toBeNull();
  });

  it('sums every repo the rules point at for the global cap', () => {
    const config = { ...base, maxWorktrees: 4 };
    const worktrees = held({ '/repos/mobile': 3, '/repos/backend': 1 });
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees),
    ).toMatch(/global cap reached \(4\/4\)/);
  });

  it('counts a repo two rules share only once', () => {
    const config = {
      ...base,
      maxWorktrees: 4,
      rules: [
        { project: 'OVL', labels: ['a'], path: '/repos/mobile' },
        { project: 'OVL', labels: ['b'], path: '/repos/mobile' },
      ],
    };
    const worktrees = held({ '/repos/mobile': 3 });
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees),
    ).toBeNull();
  });

  it('lets a branch that already has a worktree through any cap', () => {
    const config = {
      ...base,
      maxWorktrees: 1,
      maxWorktreesPerRepo: { '/repos/mobile': 1 },
    };
    const worktrees = (): string[] => ['agent/retry-m1', 'other'];
    // `wt agent` reuses that worktree instead of adding one, so a retry after
    // an "Agent Error" must not stall behind a full repo.
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/retry-m1', worktrees),
    ).toBeNull();
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/fresh-m2', worktrees),
    ).toMatch(/repo at cap/);
  });

  it('raises both caps by the bonus', () => {
    const config = {
      ...base,
      maxWorktrees: 2,
      maxWorktreesPerRepo: { '/repos/mobile': 1 },
    };
    const worktrees = held({ '/repos/mobile': 1, '/repos/backend': 1 });
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees),
    ).toMatch(/repo at cap/);
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees, 2),
    ).toBeNull();
  });

  it('reports the raised cap it still holds on', () => {
    const config = { ...base, maxWorktrees: 2 };
    const worktrees = held({ '/repos/mobile': 4 });
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees, 2),
    ).toMatch(/global cap reached \(4\/4\)/);
  });

  it('leaves an unlimited cap unlimited under a bonus', () => {
    const worktrees = held({ '/repos/mobile': 99 });
    expect(
      checkCapacity(base, '/repos/mobile', 'agent/new', worktrees, 2),
    ).toBeNull();
  });

  it('reports the repo cap first when both are reached', () => {
    const config = {
      ...base,
      maxWorktrees: 1,
      maxWorktreesPerRepo: { '/repos/mobile': 1 },
    };
    const worktrees = held({ '/repos/mobile': 1 });
    expect(
      checkCapacity(config, '/repos/mobile', 'agent/new', worktrees),
    ).toMatch(/repo/);
  });
});
