// src/wt/agent-api.e2e.test.ts
//
// True end-to-end test of the daemon's seam: runAgent -> createAgentWorktree
// -> prepareWorktree, with REAL git (no mocking of the worktree/git layer,
// no mocking of openIde/zed.js). Uses `ide: 'true'` so the non-Zed fallback
// path runs a harmless real spawn (`/usr/bin/true <worktreePath>`) instead of
// any Zed/osascript automation.
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from './agent-api.js';
import { createStore, setGlobalConfig } from './lib/config.js';

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-agent-api-e2e-')));
  repoDir = path.join(tmpDir, 'my-repo');
  execSync(`mkdir -p ${repoDir}`);
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "t@t.com"', { cwd: repoDir });
  execSync('git config user.name "T"', { cwd: repoDir });
  execSync('touch README.md', { cwd: repoDir });
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runAgent (E2E, real git)', () => {
  it('creates a real worktree via the in-process daemon seam', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'true',
        ide_open_args: [],
        agent_command: 'echo agent',
      },
      store,
    );

    const res = await runAgent({
      repoPath: repoDir,
      branch: 'e2e-feat',
      prompt: 'do it',
      store,
    });

    expect(res.ok).toBe(true);

    // real worktree created by the real prepareWorktree via the in-process
    // path: sibling <parent>/<repo>-<branch>.
    const wtPath = path.join(tmpDir, 'my-repo-e2e-feat');
    expect(existsSync(wtPath)).toBe(true);

    // branch exists in the repo:
    expect(
      execSync('git branch --list e2e-feat', { cwd: repoDir }).toString(),
    ).toContain('e2e-feat');

    // and the new path is really registered as a git worktree of the repo:
    expect(
      execSync('git worktree list', { cwd: repoDir }).toString(),
    ).toContain(wtPath);
  });
});
