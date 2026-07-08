// src/lib/registry.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from './config.js';
import { getRegisteredRepos, registerRepo } from './registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'wt-registry-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('registerRepo', () => {
  it('adds a new repo to the registry', () => {
    const store = createStore(tmpDir);
    registerRepo('/projects/my-repo', store);
    expect(getRegisteredRepos(store)).toContain('/projects/my-repo');
  });

  it('does not add the same repo twice', () => {
    const store = createStore(tmpDir);
    registerRepo('/projects/my-repo', store);
    registerRepo('/projects/my-repo', store);
    const repos = getRegisteredRepos(store);
    expect(repos.filter((r) => r === '/projects/my-repo')).toHaveLength(1);
  });

  it('adds multiple distinct repos', () => {
    const store = createStore(tmpDir);
    registerRepo('/projects/repo-a', store);
    registerRepo('/projects/repo-b', store);
    const repos = getRegisteredRepos(store);
    expect(repos).toContain('/projects/repo-a');
    expect(repos).toContain('/projects/repo-b');
  });
});

describe('getRegisteredRepos', () => {
  it('returns empty array when no repos registered', () => {
    const store = createStore(tmpDir);
    expect(getRegisteredRepos(store)).toEqual([]);
  });
});
