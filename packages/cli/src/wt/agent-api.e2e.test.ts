// src/wt/agent-api.e2e.test.ts
//
// True end-to-end test of the daemon's seam: runAgent -> createAgentWorktree
// -> prepareWorktree, with REAL git (no mocking of the worktree/git layer).
// Only the Zed GUI automation (osascript keystrokes, global keymap writes) and
// the IDE launch are stubbed — they can't run in CI — so the success path can
// prove the agent "started" while the real prepareWorktree/git path still runs
// and creates a real worktree. The not-started path (non-Zed IDE) proves the
// fix: a created-but-not-started worktree yields { ok: false }.
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { select } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './agent-api.js';
import { createStore, setGlobalConfig } from './lib/config.js';
import { triggerChord, writeAgentTask } from './lib/zed.js';

// The Zed automation and IDE launch can't run headless in CI; stub them so the
// agent "starts" successfully while the real git/worktree layer is untouched.
vi.mock('./lib/ide.js', () => ({
  openIde: vi.fn(async () => true),
}));

vi.mock('./lib/zed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/zed.js')>();
  return {
    AGENT_TASK_LABEL: 'wt: agent',
    buildAgentTask: vi.fn(actual.buildAgentTask),
    writeAgentTask: vi.fn(() => ({ createdDir: true, createdFile: true })),
    ensureKeymap: vi.fn(() => true),
    triggerChord: vi.fn(async () => ({ ok: true })),
    cleanupAgentTask: vi.fn(),
    openAccessibilitySettings: vi.fn(),
    isHeadlessSession: vi.fn(() => false),
  };
});

// This file exercises the daemon seam, where nothing should ever prompt. Stub
// clack so a regression fails on the assertions below instead of rendering a
// real select and hanging to the vitest timeout. `select` answers 'quit'
// because that is the only answer that makes a regression visible: an
// unanswered select resolves undefined, which `createAgentWorktree` treats as
// "not quit, not open" and so starts the agent anyway.
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(async () => false),
  isCancel: vi.fn(() => false),
  select: vi.fn(async () => 'quit'),
  text: vi.fn(),
}));

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
  vi.clearAllMocks();
  vi.useRealTimers();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runAgent (E2E, real git)', () => {
  it('creates a real worktree and returns ok when the agent starts', async () => {
    vi.useFakeTimers();
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'zed',
        ide_open_args: [],
        agent_command: 'echo agent',
      },
      store,
    );

    const promise = runAgent({
      repoPath: repoDir,
      branch: 'e2e-feat',
      prompt: 'do it',
      store,
    });
    // The success path waits CLEANUP_DELAY_MS before removing the task file.
    await vi.runAllTimersAsync();
    const res = await promise;

    // The (stubbed) chord fired, so the agent "started" -> ok.
    expect(res.ok).toBe(true);

    // create.ts's own progress lines (prepareWorktree/openConfiguredIde) must
    // reach the daemon via the injected `report`, not escape to console.* —
    // otherwise they'd be missing from the Todoist comment.
    expect(res.output).toContain('Created worktree');

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

  it('returns { ok: false } when the worktree was created but the agent never started', async () => {
    const store = createStore(path.join(tmpDir, 'config'));
    // A non-Zed IDE means the agent auto-start is skipped: the worktree is
    // created and opened, but no agent runs. That must NOT read as success.
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
      branch: 'e2e-nostart',
      prompt: 'do it',
      store,
    });

    // The agent never started -> ok:false, with the reason in the output so the
    // daemon can surface it as the Todoist "Agent Error" comment.
    expect(res.ok).toBe(false);
    expect(res.output).toContain('requires Zed');

    // The real worktree was still created (the failure is only in the agent
    // start, not the worktree creation).
    const wtPath = path.join(tmpDir, 'my-repo-e2e-nostart');
    expect(existsSync(wtPath)).toBe(true);
    expect(
      execSync('git worktree list', { cwd: repoDir }).toString(),
    ).toContain(wtPath);
  });

  it('starts the agent again when the worktree already exists', async () => {
    vi.useFakeTimers();
    const store = createStore(path.join(tmpDir, 'config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'zed',
        ide_open_args: [],
        agent_command: 'echo agent',
      },
      store,
    );

    const first = runAgent({
      repoPath: repoDir,
      branch: 'e2e-again',
      prompt: 'do it',
      store,
    });
    await vi.runAllTimersAsync();
    await first;

    vi.clearAllMocks();

    // Second dispatch of the same branch: the worktree is already there, so the
    // existing-worktree prompt would hang the daemon. It must start the agent.
    // A real TTY is the daemon's own situation (`agent-spawner run` inherits the
    // shell's), and it is what makes runAgent's setInteractive(false) the line
    // under test rather than vitest's own missing TTY.
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    let res: Awaited<ReturnType<typeof runAgent>>;
    try {
      const second = runAgent({
        repoPath: repoDir,
        branch: 'e2e-again',
        prompt: 'do it again',
        store,
      });
      await vi.runAllTimersAsync();
      res = await second;
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expect(res.ok).toBe(true);
    expect(res.output).not.toMatch(/already exists/);
    expect(writeAgentTask).toHaveBeenCalled();
    expect(triggerChord).toHaveBeenCalled();
    // Nothing rendered a prompt at all, TTY or no TTY.
    expect(select).not.toHaveBeenCalled();
  });
});
