// src/commands/agent.test.ts
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confirm } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import { openIde } from '../lib/ide.js';
import {
  cleanupAgentTask,
  ensureKeymap,
  isHeadlessSession,
  openAccessibilitySettings,
  triggerChord,
  writeAgentTask,
} from '../lib/zed.js';
import { createAgentWorktree } from './agent.js';

// The Zed automation and IDE launch are exercised in zed.test.ts; here we only
// verify createAgentWorktree's branching, so both are mocked away (no real
// osascript, global keymap writes, or editor spawns).
vi.mock('../lib/ide.js', () => ({
  openIde: vi.fn(async () => true),
}));

vi.mock('../lib/zed.js', () => ({
  AGENT_TASK_LABEL: 'wt: agent',
  buildAgentTask: vi.fn(() => ({ label: 'wt: agent' })),
  writeAgentTask: vi.fn(() => ({ createdDir: true, createdFile: true })),
  ensureKeymap: vi.fn(() => true),
  triggerChord: vi.fn(async () => ({ ok: true })),
  cleanupAgentTask: vi.fn(),
  openAccessibilitySettings: vi.fn(),
  isHeadlessSession: vi.fn(() => false),
}));

// Branch is always supplied in these tests, so clack prompts are never hit;
// stubbing keeps the module side-effect free.
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(async () => false),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  text: vi.fn(),
}));

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wt-agent-')));
  repoDir = path.join(tmpDir, 'my-repo');
  execSync(`mkdir -p ${repoDir}`);
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "t@t.com"', { cwd: repoDir });
  execSync('git config user.name "T"', { cwd: repoDir });
  writeFileSync(path.join(repoDir, 'README.md'), '');
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  vi.mocked(openIde).mockResolvedValue(true);
  vi.mocked(triggerChord).mockResolvedValue({ ok: true });
  vi.mocked(writeAgentTask).mockReturnValue({
    createdDir: true,
    createdFile: true,
  });
  vi.mocked(ensureKeymap).mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  rmSync(tmpDir, { recursive: true, force: true });
});

const configure = (overrides = {}) => {
  const store = createStore(path.join(tmpDir, 'config'));
  setGlobalConfig(
    {
      worktree_path: '../',
      base_branch: 'HEAD',
      setup_commands: [],
      ide: 'zed',
      ide_open_args: [],
      ...overrides,
    },
    store,
  );
  return store;
};

describe('createAgentWorktree', () => {
  it('writes the task, triggers the chord, then cleans up on success', async () => {
    vi.useFakeTimers();
    const store = configure();

    const promise = createAgentWorktree('feature', 'do stuff', {
      cwd: repoDir,
      store,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(writeAgentTask).toHaveBeenCalled();
    expect(ensureKeymap).toHaveBeenCalled();
    expect(openIde).toHaveBeenCalledWith('zed', [], expect.any(String));
    expect(triggerChord).toHaveBeenCalled();
    expect(cleanupAgentTask).toHaveBeenCalled();
  });

  it('falls back to opening the IDE when it is not Zed', async () => {
    const store = configure({ ide: 'echo' });

    await createAgentWorktree('feature', 'do stuff', { cwd: repoDir, store });

    expect(openIde).toHaveBeenCalledWith('echo', [], expect.any(String));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Opened echo'),
    );
    expect(writeAgentTask).not.toHaveBeenCalled();
    expect(triggerChord).not.toHaveBeenCalled();
  });

  it('errors but still opens Zed when agent_command is empty', async () => {
    const store = configure({ agent_command: '' });

    await createAgentWorktree('feature', 'do stuff', { cwd: repoDir, store });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No agent_command'),
    );
    expect(openIde).toHaveBeenCalledWith('zed', [], expect.any(String));
    expect(writeAgentTask).not.toHaveBeenCalled();
  });

  it('skips the chord and keeps the task when the keybinding cannot be installed', async () => {
    const store = configure();
    vi.mocked(ensureKeymap).mockReturnValue(false);

    await createAgentWorktree('feature', 'do stuff', { cwd: repoDir, store });

    expect(openIde).toHaveBeenCalledWith('zed', [], expect.any(String));
    expect(triggerChord).not.toHaveBeenCalled();
    expect(cleanupAgentTask).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Agent started'),
    );
  });

  it('keeps the task (no cleanup) when the chord cannot be triggered', async () => {
    const store = configure();
    vi.mocked(triggerChord).mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'boom',
    });

    await createAgentWorktree('feature', 'do stuff', { cwd: repoDir, store });

    expect(triggerChord).toHaveBeenCalled();
    expect(cleanupAgentTask).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('press'));
  });

  it('guides through Accessibility, then stops cleanly when the user declines', async () => {
    const store = configure();
    vi.mocked(triggerChord).mockResolvedValue({
      ok: false,
      reason: 'accessibility',
    });
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await createAgentWorktree('feature', 'do stuff', { cwd: repoDir, store });
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expect(openAccessibilitySettings).toHaveBeenCalled();
    expect(cleanupAgentTask).not.toHaveBeenCalled();
  });

  it('names Terminal as the grantee in the Accessibility prompt over SSH', async () => {
    const store = configure();
    vi.mocked(triggerChord).mockResolvedValue({
      ok: false,
      reason: 'accessibility',
    });
    vi.mocked(isHeadlessSession).mockReturnValue(true);
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await createAgentWorktree('feature', 'do stuff', { cwd: repoDir, store });
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Terminal'),
      }),
    );
  });

  it('returns without side effects when the user cancels worktree creation', async () => {
    const store = configure();

    // No repos registered + cwd outside a repo -> prepareWorktree returns null
    await createAgentWorktree('feature', 'do stuff', {
      cwd: tmpdir(),
      store,
    });

    expect(writeAgentTask).not.toHaveBeenCalled();
    expect(openIde).not.toHaveBeenCalled();
  });
});

describe('createAgentWorktree (existing worktree)', () => {
  // Pre-create a real worktree so prepareWorktree reports status 'exists'
  // (a plain directory would now be rejected as "not a git worktree").
  const preexisting = () => {
    const store = configure();
    execSync('git worktree add ../my-repo-feature -b feature', {
      cwd: repoDir,
    });
    return store;
  };

  it('quits without side effects when the user chooses quit', async () => {
    const store = preexisting();

    await createAgentWorktree('feature', 'do stuff', {
      cwd: repoDir,
      store,
      existingWorktreePrompt: async () => 'quit' as const,
    });

    expect(openIde).not.toHaveBeenCalled();
    expect(writeAgentTask).not.toHaveBeenCalled();
  });

  it('opens the IDE without starting the agent when the user chooses open', async () => {
    const store = preexisting();

    await createAgentWorktree('feature', 'do stuff', {
      cwd: repoDir,
      store,
      existingWorktreePrompt: async () => 'open' as const,
    });

    expect(openIde).toHaveBeenCalledWith('zed', [], expect.any(String));
    expect(writeAgentTask).not.toHaveBeenCalled();
    expect(triggerChord).not.toHaveBeenCalled();
  });

  it('starts the agent in the existing worktree when the user chooses agent', async () => {
    vi.useFakeTimers();
    const store = preexisting();

    const promise = createAgentWorktree('feature', 'do stuff', {
      cwd: repoDir,
      store,
      existingWorktreePrompt: async () => 'agent' as const,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(writeAgentTask).toHaveBeenCalled();
    expect(triggerChord).toHaveBeenCalled();
    expect(cleanupAgentTask).toHaveBeenCalled();
  });
});
