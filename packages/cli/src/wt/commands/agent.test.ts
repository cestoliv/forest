// src/commands/agent.test.ts
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confirm } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, setGlobalConfig } from '../lib/config.js';
import { openIde } from '../lib/ide.js';
import { setInteractive } from '../lib/interactive.js';
import { openWorktreeInOrca, startAgentInOrca } from '../lib/orca.js';
import {
  buildAgentTask,
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

vi.mock('../lib/zed.js', async (importOriginal) => {
  // Use the real (pure) buildAgentTask so tests can assert the produced task
  // command string — the command-templating wiring lives in agent.ts, so the
  // real builder is needed to observe the final command. Everything with I/O is
  // still stubbed out.
  const actual = await importOriginal<typeof import('../lib/zed.js')>();
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

// Keep the pure builders (buildAgentCommandLine/buildOrcaCommands) real — the
// real buildAgentTask above depends on buildAgentCommandLine — and stub only the
// side-effecting Orca launch so no `orca` process is spawned.
vi.mock('../lib/orca.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/orca.js')>();
  return {
    ...actual,
    startAgentInOrca: vi.fn(async () => true),
    openWorktreeInOrca: vi.fn(async () => true),
  };
});

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
      repoRoot: repoDir,
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

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
    });

    expect(openIde).toHaveBeenCalledWith('echo', [], expect.any(String));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Opened echo'),
    );
    expect(writeAgentTask).not.toHaveBeenCalled();
    expect(triggerChord).not.toHaveBeenCalled();
  });

  it('reports (not console.error) but still opens Zed when agent_command is empty', async () => {
    const store = configure({ agent_command: '' });
    const lines: string[] = [];

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      report: (m) => lines.push(m),
    });

    expect(lines.join('\n')).toContain('No agent_command');
    expect(openIde).toHaveBeenCalledWith('zed', [], expect.any(String));
    expect(writeAgentTask).not.toHaveBeenCalled();
  });

  it('skips the chord and keeps the task when the keybinding cannot be installed', async () => {
    const store = configure();
    vi.mocked(ensureKeymap).mockReturnValue(false);

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
    });

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

    const lines: string[] = [];
    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      report: (m) => lines.push(m),
    });
    expect(triggerChord).toHaveBeenCalled();
    expect(cleanupAgentTask).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('press');
  });

  it('throws on an invalid mode instead of exiting', async () => {
    const store = configure();
    await expect(
      createAgentWorktree('feature', 'do stuff', {
        cwd: repoDir,
        store,
        mode: 'nope',
      }),
    ).rejects.toThrow(/Invalid mode/);
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
      await createAgentWorktree('feature', 'do stuff', {
        repoRoot: repoDir,
        store,
      });
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expect(openAccessibilitySettings).toHaveBeenCalled();
    expect(cleanupAgentTask).not.toHaveBeenCalled();
  });

  it('skips the Accessibility retry loop when nobody can answer it', async () => {
    const store = configure();
    vi.mocked(triggerChord).mockResolvedValue({
      ok: false,
      reason: 'accessibility',
    });
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    setInteractive(false);
    try {
      await createAgentWorktree('feature', 'do stuff', {
        repoRoot: repoDir,
        store,
      });
    } finally {
      setInteractive(true);
      process.stdin.isTTY = originalIsTTY;
    }

    expect(openAccessibilitySettings).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
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
      await createAgentWorktree('feature', 'do stuff', {
        repoRoot: repoDir,
        store,
      });
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

  it('runs the repo picker even when cwd is inside a git repo', async () => {
    vi.useFakeTimers();
    const store = configure();
    const repoPicker = vi.fn(async () => repoDir);
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      const promise = createAgentWorktree('feature', 'do stuff', {
        cwd: repoDir,
        store,
        repoPicker,
      });
      await vi.runAllTimersAsync();
      await promise;
      expect(repoPicker).toHaveBeenCalled();
      expect(writeAgentTask).toHaveBeenCalled();
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('skips the repo picker when repoRoot is passed explicitly', async () => {
    vi.useFakeTimers();
    const store = configure();
    const repoPicker = vi.fn(async () => repoDir);
    const promise = createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      repoPicker,
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(repoPicker).not.toHaveBeenCalled();
    expect(writeAgentTask).toHaveBeenCalled();
  });
});

describe('createAgentWorktree (mode resolution)', () => {
  const runAgent = async (
    store: ReturnType<typeof configure>,
    mode?: string,
  ) => {
    vi.useFakeTimers();
    const promise = createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      ...(mode !== undefined ? { mode } : {}),
    });
    await vi.runAllTimersAsync();
    await promise;
  };

  it("defaults to 'default' when neither --mode nor agent_mode is set", async () => {
    await runAgent(configure());
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'default',
      true,
      '',
    );
  });

  it('falls back to the configured agent_mode when --mode is omitted', async () => {
    await runAgent(configure({ agent_mode: 'plan' }));
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'plan',
      true,
      '',
    );
  });

  it('lets an explicit --mode override the configured agent_mode', async () => {
    await runAgent(configure({ agent_mode: 'plan' }), 'auto');
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'auto',
      true,
      '',
    );
  });

  it("warns and falls back to 'default' on an invalid configured agent_mode", async () => {
    await runAgent(configure({ agent_mode: 'Plan' }));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid agent_mode "Plan"'),
    );
    // The worktree/agent still start — no orphan, no crash.
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'default',
      true,
      '',
    );
  });

  it("treats an empty agent_mode as unset and falls back to 'default'", async () => {
    await runAgent(configure({ agent_mode: '' }));
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'default',
      true,
      '',
    );
  });

  it('throws without creating a worktree on an invalid --mode', async () => {
    const store = configure();
    await expect(
      createAgentWorktree('feature', 'do stuff', {
        repoRoot: repoDir,
        store,
        mode: 'bogus',
      }),
    ).rejects.toThrow(/Invalid mode/);
    expect(writeAgentTask).not.toHaveBeenCalled();
  });
});

describe('createAgentWorktree (model resolution)', () => {
  const runAgent = async (
    store: ReturnType<typeof configure>,
    model?: string,
  ) => {
    vi.useFakeTimers();
    const promise = createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      ...(model !== undefined ? { model } : {}),
    });
    await vi.runAllTimersAsync();
    await promise;
  };

  it('injects no --model when neither --model nor agent_model is set', async () => {
    await runAgent(configure());
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'default',
      true,
      '',
    );
    const command = vi.mocked(buildAgentTask).mock.results[0].value.command;
    expect(command).not.toContain('--model');
  });

  it('falls back to the configured agent_model when --model is omitted', async () => {
    await runAgent(configure({ agent_model: 'opus' }));
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'default',
      true,
      'opus',
    );
    const command = vi.mocked(buildAgentTask).mock.results[0].value.command;
    expect(command).toContain('--model opus');
  });

  it('lets an explicit --model override the configured agent_model', async () => {
    await runAgent(configure({ agent_model: 'opus' }), 'fable');
    expect(buildAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'do stuff',
      expect.anything(),
      'default',
      true,
      'fable',
    );
    const command = vi.mocked(buildAgentTask).mock.results[0].value.command;
    expect(command).toContain('--model fable');
    expect(command).not.toContain('--model opus');
  });

  it('reaches the built command line when --model is passed with no configured agent_model', async () => {
    await runAgent(configure(), 'fable');
    const command = vi.mocked(buildAgentTask).mock.results[0].value.command;
    expect(command).toContain('--model fable');
  });

  it('injects no --model when both --model and agent_model resolve empty', async () => {
    await runAgent(configure({ agent_model: '' }));
    const command = vi.mocked(buildAgentTask).mock.results[0].value.command;
    expect(command).not.toContain('--model');
  });
});

describe('createAgentWorktree (command templating)', () => {
  const run = async (store: ReturnType<typeof configure>) => {
    vi.useFakeTimers();
    const promise = createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
    });
    await vi.runAllTimersAsync();
    await promise;
  };

  // The real buildAgentTask runs (see the zed mock), so its return value is the
  // final Zed task — assert against its command string.
  const producedCommand = (): string =>
    vi.mocked(buildAgentTask).mock.results[0].value.command;

  it('substitutes {{branch}} in agent_command (shell-quoted)', async () => {
    await run(
      configure({ agent_command: 'claude --remote-control {{branch}}' }),
    );
    expect(producedCommand()).toContain("--remote-control 'feature'");
  });

  it('places {{prompt}} inline and does not double-append the prompt', async () => {
    await run(configure({ agent_command: 'claude -p {{prompt}}' }));
    const command = producedCommand();
    expect(command).toContain('do stuff');
    // The prompt must appear exactly once — not substituted AND appended.
    expect(command.match(/do stuff/g)).toHaveLength(1);
  });

  it('auto-appends the prompt when agent_command has no {{prompt}}', async () => {
    await run(configure({ agent_command: 'claude' }));
    expect(producedCommand()).toBe(
      "claude --permission-mode default 'do stuff'",
    );
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
      repoRoot: repoDir,
      store,
      existingWorktreePrompt: async () => 'quit' as const,
    });

    expect(openIde).not.toHaveBeenCalled();
    expect(writeAgentTask).not.toHaveBeenCalled();
  });

  it('opens the IDE without starting the agent when the user chooses open', async () => {
    const store = preexisting();

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
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
      repoRoot: repoDir,
      store,
      existingWorktreePrompt: async () => 'agent' as const,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(writeAgentTask).toHaveBeenCalled();
    expect(triggerChord).toHaveBeenCalled();
    expect(cleanupAgentTask).toHaveBeenCalled();
  });

  it('starts the agent with no prompt when nobody can answer one', async () => {
    vi.useFakeTimers();
    const store = preexisting();
    // A real TTY plus setInteractive(false) is the daemon's own situation: it
    // inherits the shell's TTY, so the TTY check alone would still prompt.
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    setInteractive(false);
    try {
      // No existingWorktreePrompt injected, so the real promptExistingWorktree
      // runs and takes its non-interactive branch.
      const promise = createAgentWorktree('feature', 'do stuff', {
        repoRoot: repoDir,
        store,
      });
      await vi.runAllTimersAsync();
      await promise;
    } finally {
      setInteractive(true);
      process.stdin.isTTY = originalIsTTY;
    }

    expect(writeAgentTask).toHaveBeenCalled();
    expect(triggerChord).toHaveBeenCalled();
  });
});

describe('createAgentWorktree (ide selection)', () => {
  it("starts the agent in Orca (not Zed) when config ide is 'orca'", async () => {
    const store = configure({ ide: 'orca' });

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
    });

    expect(startAgentInOrca).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: repoDir,
        worktreePath: expect.any(String),
        commandLine: "claude --permission-mode default 'do stuff'",
      }),
    );
    expect(writeAgentTask).not.toHaveBeenCalled();
    expect(triggerChord).not.toHaveBeenCalled();
  });

  it('threads --model into the Orca command line', async () => {
    const store = configure({ ide: 'orca' });

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      model: 'fable',
    });

    expect(startAgentInOrca).toHaveBeenCalledWith(
      expect.objectContaining({
        commandLine:
          "claude --permission-mode default --model fable 'do stuff'",
      }),
    );
  });

  it('--ide orca overrides a configured zed', async () => {
    const store = configure({ ide: 'zed' });

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      ide: 'orca',
    });

    expect(startAgentInOrca).toHaveBeenCalled();
    expect(writeAgentTask).not.toHaveBeenCalled();
  });

  it('--ide zed overrides a configured orca', async () => {
    vi.useFakeTimers();
    const store = configure({ ide: 'orca' });

    const promise = createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      ide: 'zed',
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(writeAgentTask).toHaveBeenCalled();
    expect(triggerChord).toHaveBeenCalled();
    expect(startAgentInOrca).not.toHaveBeenCalled();
  });

  it('falls back to opening the IDE for an unknown ide (neither zed nor orca)', async () => {
    const store = configure({ ide: 'zed' });

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      ide: 'vscode',
    });

    expect(openIde).toHaveBeenCalledWith('vscode', [], expect.any(String));
    expect(startAgentInOrca).not.toHaveBeenCalled();
    expect(writeAgentTask).not.toHaveBeenCalled();
  });

  it('opens the worktree in Orca (no agent) on a plain create with --ide orca', async () => {
    const { createWorktree } = await import('./create.js');
    const store = configure({ ide: 'zed' });

    await createWorktree('feature', {
      repoRoot: repoDir,
      store,
      ide: 'orca',
    });

    expect(openWorktreeInOrca).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: repoDir }),
    );
    expect(openIde).not.toHaveBeenCalled();
  });

  it('forwards focus:true to the Orca agent launch when set (interactive)', async () => {
    const store = configure({ ide: 'orca' });

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
      focus: true,
    });

    expect(startAgentInOrca).toHaveBeenCalledWith(
      expect.objectContaining({ focus: true }),
    );
  });

  it('defaults focus:false for the Orca agent launch (daemon dispatch)', async () => {
    const store = configure({ ide: 'orca' });

    await createAgentWorktree('feature', 'do stuff', {
      repoRoot: repoDir,
      store,
    });

    expect(startAgentInOrca).toHaveBeenCalledWith(
      expect.objectContaining({ focus: false }),
    );
  });

  it('forwards focus:true to the Orca open path on a plain create', async () => {
    const { createWorktree } = await import('./create.js');
    const store = configure({ ide: 'orca' });

    await createWorktree('feature', {
      repoRoot: repoDir,
      store,
      focus: true,
    });

    expect(openWorktreeInOrca).toHaveBeenCalledWith(
      expect.objectContaining({ focus: true }),
    );
  });
});
