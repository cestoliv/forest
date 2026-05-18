// src/commands/create.test.ts
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import { registerRepo } from '../lib/registry.js';
import { createWorktree } from './create.js';

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  // Resolve symlinks so paths match git's canonical output (macOS /var -> /private/var)
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-create-')));
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

describe('createWorktree', () => {
  it('creates the worktree directory', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'echo',
        ide_open_args: [],
      },
      store,
    );

    await createWorktree('feature', { cwd: repoDir, store });

    expect(existsSync(path.join(tmpDir, 'my-repo-feature'))).toBe(true);
  });

  it('runs setup commands in the new worktree', async () => {
    const markerFile = path.join(tmpDir, 'setup-ran.txt');
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [`touch ${markerFile}`],
        ide: 'echo',
        ide_open_args: [],
      },
      store,
    );

    await createWorktree('feature', { cwd: repoDir, store });

    expect(existsSync(markerFile)).toBe(true);
  });

  it('throws if worktree path already exists', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'echo',
        ide_open_args: [],
      },
      store,
    );

    await createWorktree('feature', { cwd: repoDir, store });

    await expect(
      createWorktree('feature', { cwd: repoDir, store }),
    ).rejects.toThrow('already exists');
  });
});

describe('createWorktree (setup failure)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits with code 1 when setup command fails', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: ['exit 1'],
        ide: 'echo',
        ide_open_args: [],
      },
      store,
    );

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createWorktree('feature', { cwd: repoDir, store });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Setup failed'),
    );
  });
});

describe('createWorktree (outside repo)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits with error when TTY is not available and repos exist', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    registerRepo(repoDir, store);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await expect(
        createWorktree('feature', { cwd: tmpdir(), store }),
      ).rejects.toThrow('process.exit(1)');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('TTY'));
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('prints error and returns when no repos are registered', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createWorktree('feature', { cwd: tmpdir(), store });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No repos registered'),
    );
  });

  it('creates worktree in the repo returned by repoPicker', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'echo',
        ide_open_args: [],
      },
      store,
    );
    registerRepo(repoDir, store);

    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await createWorktree('feature', {
        cwd: tmpdir(),
        store,
        repoPicker: async () => repoDir,
      });

      expect(existsSync(path.join(tmpDir, 'my-repo-feature'))).toBe(true);
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('uses branch returned by branchInput when no branch arg is provided', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'echo',
        ide_open_args: [],
      },
      store,
    );
    registerRepo(repoDir, store);

    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await createWorktree(undefined, {
        cwd: tmpdir(),
        store,
        repoPicker: async () => repoDir,
        branchInput: async () => 'from-input',
      });

      expect(existsSync(path.join(tmpDir, 'my-repo-from-input'))).toBe(true);
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });
});
