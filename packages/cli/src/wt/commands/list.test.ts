// src/commands/list.test.ts
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import { prepareListItems } from './list.js';

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
  it('returns repo mode when cwd is inside a git repo', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const result = await prepareListItems({ cwd: repoDir, store });
    expect(result.mode).toBe('repo');
    expect(result.repoRoot).toBe(repoDir);
    expect(result.items.length).toBeGreaterThan(0);
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

  it('returns global mode when cwd is outside any git repo', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    const result = await prepareListItems({ cwd: tmpDir, store });
    expect(result.mode).toBe('global');
    expect(result.repoRoot).toBeNull();
  });

  it('global mode includes worktrees from all registered repos', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir] }, store);
    const result = await prepareListItems({ cwd: tmpDir, store });
    expect(result.mode).toBe('global');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].repoRoot).toBe(repoDir);
  });

  it('global mode marks no worktree as current when cwd is outside all repos', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig({ repos: [repoDir] }, store);
    const result = await prepareListItems({ cwd: tmpDir, store });
    expect(result.items.every((w) => !w.isCurrent)).toBe(true);
  });
});
