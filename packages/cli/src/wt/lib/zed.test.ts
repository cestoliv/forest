// src/lib/zed.test.ts
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESSIBILITY_SETTINGS_URL,
  AGENT_TASK_LABEL,
  buildAgentTask,
  buildGuiHelperScript,
  buildKeymapBinding,
  buildOsascript,
  cleanupAgentTask,
  ensureKeymap,
  isAccessibilityError,
  isHeadlessSession,
  openAccessibilitySettings,
  parseChord,
  parseGuiResult,
  removeTask,
  triggerChord,
  upsertKeymapBinding,
  upsertTask,
  writeAgentTask,
  type ZedTask,
} from './zed.js';

// Only the osascript/open spawns matter here; every other test in this file
// injects its own runner/open, so a bare spawn mock is safe module-wide.
// (vitest hoists vi.mock above the imports regardless of placement here.)
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'wt-zed-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sampleTask = (label = AGENT_TASK_LABEL): ZedTask =>
  buildAgentTask('claude --permission-mode plan', 'hello', label);

describe('buildAgentTask', () => {
  it('puts the whole invocation in command with the prompt single-quoted', () => {
    const task = buildAgentTask(
      'claude --permission-mode plan',
      'hi there',
      'L',
    );
    expect(task.command).toBe("claude --permission-mode plan 'hi there'");
  });

  it('escapes single quotes in the prompt', () => {
    const task = buildAgentTask('claude', "it's a test", 'L');
    expect(task.command).toBe("claude 'it'\\''s a test'");
  });

  it('produces the expected Zed task fields', () => {
    const task = buildAgentTask('claude', 'p', 'wt: agent');
    expect(task).toEqual({
      label: 'wt: agent',
      command: "claude 'p'",
      cwd: '$ZED_WORKTREE_ROOT',
      use_new_terminal: true,
      allow_concurrent_runs: false,
      reveal: 'always',
      reveal_target: 'dock',
      shell: 'system',
    });
  });

  it('injects --permission-mode when mode is provided', () => {
    const task = buildAgentTask('claude', 'test prompt', 'L', 'auto');
    expect(task.command).toBe("claude --permission-mode auto 'test prompt'");
  });

  it('removes existing --permission-mode and replaces with new mode', () => {
    const task = buildAgentTask(
      'claude --permission-mode plan',
      'test',
      'L',
      'default',
    );
    expect(task.command).toBe("claude --permission-mode default 'test'");
  });

  it('handles multiple spaces and preserves other flags', () => {
    const task = buildAgentTask(
      'claude --some-flag --permission-mode plan --other-flag',
      'test',
      'L',
      'auto',
    );
    expect(task.command).toBe(
      "claude --some-flag --other-flag --permission-mode auto 'test'",
    );
  });

  it('works without mode parameter (backward compatibility)', () => {
    const task = buildAgentTask('claude --permission-mode plan', 'test', 'L');
    expect(task.command).toBe("claude --permission-mode plan 'test'");
  });

  it('does not append the prompt when appendPrompt is false', () => {
    const task = buildAgentTask(
      'claude -p already-here',
      'test',
      'L',
      undefined,
      false,
    );
    expect(task.command).toBe('claude -p already-here');
  });

  it('still injects the mode but omits the prompt when appendPrompt is false', () => {
    const task = buildAgentTask(
      'claude -p already-here',
      'test',
      'L',
      'auto',
      false,
    );
    expect(task.command).toBe('claude -p already-here --permission-mode auto');
  });

  it('forwards model into the command line', () => {
    const task = buildAgentTask(
      'claude',
      'hi',
      'wt-agent',
      'auto',
      true,
      'fable',
    );
    expect(task.command).toBe(
      "claude --permission-mode auto --model fable 'hi'",
    );
  });
});

describe('upsertTask / removeTask', () => {
  it('appends a new task', () => {
    const a = sampleTask('a');
    const b = sampleTask('b');
    expect(upsertTask([a], b)).toEqual([a, b]);
  });

  it('replaces a task with the same label', () => {
    const a = sampleTask('a');
    const a2 = buildAgentTask('claude', 'changed', 'a');
    expect(upsertTask([a], a2)).toEqual([a2]);
  });

  it('removes the task with the given label', () => {
    const a = sampleTask('a');
    const b = sampleTask('b');
    expect(removeTask([a, b], 'a')).toEqual([b]);
  });
});

describe('buildKeymapBinding', () => {
  it('binds the chord to task::Spawn of the label', () => {
    expect(buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent')).toEqual({
      context: 'Workspace',
      bindings: {
        'ctrl-shift-cmd-c': ['task::Spawn', { task_name: 'wt: agent' }],
      },
    });
  });
});

describe('upsertKeymapBinding', () => {
  it('adds the binding to an empty keymap', () => {
    const next = upsertKeymapBinding([], 'ctrl-shift-cmd-c', 'wt: agent');
    expect(next).toEqual([buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent')]);
  });

  it('is idempotent (returns same reference when already present)', () => {
    const keymap = [buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent')];
    const next = upsertKeymapBinding(keymap, 'ctrl-shift-cmd-c', 'wt: agent');
    expect(next).toBe(keymap);
  });

  it('appends ours last when the chord maps elsewhere', () => {
    const other: ReturnType<typeof buildKeymapBinding> = {
      context: 'Workspace',
      bindings: { 'ctrl-shift-cmd-c': ['other::Action'] },
    };
    const next = upsertKeymapBinding([other], 'ctrl-shift-cmd-c', 'wt: agent');
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(
      buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent'),
    );
  });
});

describe('parseChord', () => {
  it('parses modifiers and the final key', () => {
    expect(parseChord('ctrl-shift-cmd-c')).toEqual({
      key: 'c',
      modifiers: ['control down', 'shift down', 'command down'],
    });
  });

  it('handles a bare key with no modifiers', () => {
    expect(parseChord('c')).toEqual({ key: 'c', modifiers: [] });
  });

  it('maps alt/opt to option down', () => {
    expect(parseChord('alt-x').modifiers).toEqual(['option down']);
    expect(parseChord('opt-x').modifiers).toEqual(['option down']);
  });

  it('throws on an unknown modifier', () => {
    expect(() => parseChord('foo-c')).toThrow(/Unknown modifier/);
  });
});

describe('buildOsascript', () => {
  it('contains the load delay, activate, and the keystroke with modifiers', () => {
    const script = buildOsascript('ctrl-shift-cmd-c');
    expect(script).toContain('delay 3');
    expect(script).toContain('tell application "Zed" to activate');
    expect(script).toContain(
      'keystroke "c" using {control down, shift down, command down}',
    );
  });

  it('honours custom delays', () => {
    const script = buildOsascript('ctrl-c', {
      loadDelay: 1,
      activateDelay: 0.2,
    });
    expect(script).toContain('delay 1');
    expect(script).toContain('delay 0.2');
    expect(script).toContain('keystroke "c" using {control down}');
  });

  it('uses key code (not keystroke) for named keys', () => {
    const script = buildOsascript('ctrl-shift-cmd-space');
    expect(script).toContain(
      'key code 49 using {control down, shift down, command down}',
    );
    expect(script).not.toContain('keystroke');
  });

  it('maps function keys to their key code', () => {
    expect(buildOsascript('cmd-f5')).toContain(
      'key code 96 using {command down}',
    );
  });

  it('throws on an unknown multi-character key', () => {
    expect(() => buildOsascript('ctrl-nope')).toThrow(/Unsupported key "nope"/);
  });

  it('escapes a quote/backslash single-char key for the AppleScript literal', () => {
    expect(buildOsascript('cmd-"')).toContain(
      'keystroke "\\"" using {command down}',
    );
    expect(buildOsascript('cmd-\\')).toContain(
      'keystroke "\\\\" using {command down}',
    );
  });
});

describe('writeAgentTask', () => {
  it('creates .zed/tasks.json and reports what it created', () => {
    const task = sampleTask();
    const created = writeAgentTask(tmpDir, task);
    expect(created).toEqual({ createdDir: true, createdFile: true });
    const tasksPath = path.join(tmpDir, '.zed', 'tasks.json');
    expect(JSON.parse(readFileSync(tasksPath, 'utf8'))).toEqual([task]);
  });

  it('upserts into a pre-existing tasks.json, preserving other tasks', () => {
    const zedDir = path.join(tmpDir, '.zed');
    mkdirSync(zedDir, { recursive: true });
    const other = sampleTask('other');
    writeFileSync(path.join(zedDir, 'tasks.json'), JSON.stringify([other]));

    const task = sampleTask();
    const created = writeAgentTask(tmpDir, task);
    expect(created).toEqual({ createdDir: false, createdFile: false });
    const tasks = JSON.parse(
      readFileSync(path.join(zedDir, 'tasks.json'), 'utf8'),
    );
    expect(tasks).toEqual([other, task]);
  });

  it('preserves comments/formatting in a pre-existing JSONC tasks.json', () => {
    const zedDir = path.join(tmpDir, '.zed');
    mkdirSync(zedDir, { recursive: true });
    const tasksPath = path.join(zedDir, 'tasks.json');
    const jsonc = `// my tasks
[
  {
    "label": "build",
    "command": "npm run build"
  },
]
`;
    writeFileSync(tasksPath, jsonc);

    const created = writeAgentTask(tmpDir, sampleTask());
    expect(created).toEqual({ createdDir: false, createdFile: false });

    const out = readFileSync(tasksPath, 'utf8');
    expect(out).toContain('// my tasks');
    const parsed = parseJsonc(out, [], { allowTrailingComma: true });
    expect(parsed).toHaveLength(2);

    // Cleanup drops only our entry; the comment and the other task remain.
    cleanupAgentTask(tmpDir, AGENT_TASK_LABEL, created);
    const after = readFileSync(tasksPath, 'utf8');
    expect(after).toContain('// my tasks');
    const afterParsed = parseJsonc(after, [], { allowTrailingComma: true });
    expect(afterParsed).toHaveLength(1);
    expect(afterParsed[0].label).toBe('build');
  });

  it('warns and leaves a malformed pre-existing tasks.json untouched', () => {
    const zedDir = path.join(tmpDir, '.zed');
    mkdirSync(zedDir, { recursive: true });
    const tasksPath = path.join(zedDir, 'tasks.json');
    writeFileSync(tasksPath, '{ not valid json');
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const created = writeAgentTask(tmpDir, sampleTask());
    expect(created).toEqual({ createdDir: false, createdFile: false });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not parse'),
    );
    expect(readFileSync(tasksPath, 'utf8')).toBe('{ not valid json');
  });
});

describe('cleanupAgentTask', () => {
  it('removes the file and .zed dir when it created them', () => {
    const created = writeAgentTask(tmpDir, sampleTask());
    cleanupAgentTask(tmpDir, AGENT_TASK_LABEL, created);
    expect(existsSync(path.join(tmpDir, '.zed'))).toBe(false);
  });

  it('keeps pre-existing tasks and leaves the file in place', () => {
    const zedDir = path.join(tmpDir, '.zed');
    mkdirSync(zedDir, { recursive: true });
    const other = sampleTask('other');
    writeFileSync(path.join(zedDir, 'tasks.json'), JSON.stringify([other]));

    const created = writeAgentTask(tmpDir, sampleTask());
    cleanupAgentTask(tmpDir, AGENT_TASK_LABEL, created);

    const tasksPath = path.join(zedDir, 'tasks.json');
    expect(existsSync(tasksPath)).toBe(true);
    expect(JSON.parse(readFileSync(tasksPath, 'utf8'))).toEqual([other]);
  });

  it('removes the file it created but keeps a pre-existing .zed dir', () => {
    const zedDir = path.join(tmpDir, '.zed');
    mkdirSync(zedDir, { recursive: true });

    const created = writeAgentTask(tmpDir, sampleTask());
    expect(created).toEqual({ createdDir: false, createdFile: true });
    cleanupAgentTask(tmpDir, AGENT_TASK_LABEL, created);

    expect(existsSync(zedDir)).toBe(true);
    expect(existsSync(path.join(zedDir, 'tasks.json'))).toBe(false);
  });
});

describe('ensureKeymap', () => {
  const keymapPath = () => path.join(tmpDir, 'keymap.json');

  it('creates the keymap file when absent (no backup)', () => {
    const ok = ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    expect(ok).toBe(true);
    expect(JSON.parse(readFileSync(keymapPath(), 'utf8'))).toEqual([
      buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent'),
    ]);
    expect(existsSync(`${keymapPath()}.bak`)).toBe(false);
  });

  it('is idempotent and does not rewrite or back up when already present', () => {
    ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    const ok = ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    expect(ok).toBe(true);
    expect(existsSync(`${keymapPath()}.bak`)).toBe(false);
    expect(JSON.parse(readFileSync(keymapPath(), 'utf8'))).toHaveLength(1);
  });

  it('appends to an existing keymap without creating a backup', () => {
    const existing = [{ context: 'Editor', bindings: { 'cmd-k': 'foo' } }];
    writeFileSync(keymapPath(), JSON.stringify(existing));

    const ok = ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    expect(ok).toBe(true);
    expect(existsSync(`${keymapPath()}.bak`)).toBe(false);
    const result = JSON.parse(readFileSync(keymapPath(), 'utf8'));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(existing[0]);
    expect(result[1]).toEqual(
      buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent'),
    );
  });

  it('inserts into a JSONC keymap with comments and trailing commas, preserving them', () => {
    // Mirrors the default Zed keymap: line/block comments + trailing commas,
    // which plain JSON.parse rejects.
    const jsonc = `// Zed keymap
[
  {
    "context": "Workspace",
    "bindings": {
      // "shift shift": "file_finder::Toggle"
    },
  },
  {
    "context": "Editor",
    "bindings": {
      "alt-shift-f": "editor::Format"
    }
  },
]
`;
    writeFileSync(keymapPath(), jsonc);

    const ok = ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    expect(ok).toBe(true);

    const out = readFileSync(keymapPath(), 'utf8');
    // Comments are preserved (not reserialized away).
    expect(out).toContain('// Zed keymap');
    expect(out).toContain('// "shift shift": "file_finder::Toggle"');
    // Our binding was appended; the file still parses as JSONC.
    expect(out).toContain('"task_name": "wt: agent"');
    const parsed = parseJsonc(out, [], { allowTrailingComma: true });
    expect(parsed).toHaveLength(3);
    expect(parsed[2]).toEqual(
      buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent'),
    );
  });

  it('battle-test: repeated runs with different chords accumulate without corruption', () => {
    const jsonc = `// header comment
[
  {
    "context": "Editor",
    "bindings": {
      "alt-shift-f": "editor::Format"
    }
  },
]
`;
    writeFileSync(keymapPath(), jsonc);

    ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    ensureKeymap('ctrl-shift-cmd-x', 'wt: other', keymapPath());
    // Re-running an already-present chord is a no-op (no duplicate entry).
    ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());

    const out = readFileSync(keymapPath(), 'utf8');
    expect(out).toContain('// header comment');
    const parsed = parseJsonc(out, [], { allowTrailingComma: true });
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      context: 'Editor',
      bindings: { 'alt-shift-f': 'editor::Format' },
    });
    expect(parsed[1]).toEqual(
      buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent'),
    );
    expect(parsed[2]).toEqual(
      buildKeymapBinding('ctrl-shift-cmd-x', 'wt: other'),
    );
    expect(existsSync(`${keymapPath()}.bak`)).toBe(false);
  });

  it('battle-test: leaves untouched entries and their inline comments verbatim', () => {
    const jsonc = `[
  {
    "context": "Workspace",
    "bindings": {
      "cmd-1": "pane::ActivateItem1" // first pane
    }
  },
]
`;
    writeFileSync(keymapPath(), jsonc);

    ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());

    const out = readFileSync(keymapPath(), 'utf8');
    expect(out).toContain('"cmd-1": "pane::ActivateItem1" // first pane');
    const parsed = parseJsonc(out, [], { allowTrailingComma: true });
    expect(parsed).toHaveLength(2);
  });

  it('is idempotent on a JSONC keymap that already has the binding', () => {
    const jsonc = `// Zed keymap
[
  {
    "context": "Workspace",
    "bindings": {
      "ctrl-shift-cmd-c": ["task::Spawn", { "task_name": "wt: agent" }],
    },
  },
]
`;
    writeFileSync(keymapPath(), jsonc);
    const ok = ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    expect(ok).toBe(true);
    // No change written, so no backup created.
    expect(existsSync(`${keymapPath()}.bak`)).toBe(false);
    expect(readFileSync(keymapPath(), 'utf8')).toBe(jsonc);
  });

  it('warns when the chord is already bound to a different action, then appends ours', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const existing = [
      {
        context: 'Workspace',
        bindings: { 'ctrl-shift-cmd-c': 'editor::Copy' },
      },
    ];
    writeFileSync(keymapPath(), JSON.stringify(existing));

    const ok = ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    expect(ok).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('will take precedence'),
    );
    const result = JSON.parse(readFileSync(keymapPath(), 'utf8'));
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(
      buildKeymapBinding('ctrl-shift-cmd-c', 'wt: agent'),
    );
  });

  it('warns and leaves the file untouched when it cannot be parsed', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    writeFileSync(keymapPath(), '{ not valid json');
    const ok = ensureKeymap('ctrl-shift-cmd-c', 'wt: agent', keymapPath());
    expect(ok).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Add this binding manually'),
    );
    expect(readFileSync(keymapPath(), 'utf8')).toBe('{ not valid json');
  });
});

describe('isAccessibilityError', () => {
  it('detects the 1002 and assistive-access signatures', () => {
    expect(
      isAccessibilityError(
        'osascript is not allowed to send keystrokes. (1002)',
      ),
    ).toBe(true);
    expect(isAccessibilityError('not allowed assistive access. (-1719)')).toBe(
      true,
    );
    expect(isAccessibilityError('some unrelated failure')).toBe(false);
  });
});

describe('triggerChord', () => {
  const originalPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('returns unsupported on non-macOS without running osascript', async () => {
    setPlatform('linux');
    const runner = vi.fn(async () => ({ code: 0, stderr: '' }));
    const result = await triggerChord('ctrl-shift-cmd-c', { runner });
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('runs osascript on macOS and resolves ok on success', async () => {
    setPlatform('darwin');
    const runner = vi.fn(async () => ({ code: 0, stderr: '' }));
    const result = await triggerChord('ctrl-shift-cmd-c', { runner });
    expect(result).toEqual({ ok: true });
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('keystroke "c"'),
    );
  });

  it('classifies a 1002 failure as an accessibility error', async () => {
    setPlatform('darwin');
    const runner = vi.fn(async () => ({
      code: 1,
      stderr: 'osascript is not allowed to send keystrokes. (1002)',
    }));
    const result = await triggerChord('ctrl-shift-cmd-c', { runner });
    expect(result).toMatchObject({ ok: false, reason: 'accessibility' });
  });

  it('classifies other non-zero exits as generic errors', async () => {
    setPlatform('darwin');
    const runner = vi.fn(async () => ({ code: 1, stderr: 'boom' }));
    const result = await triggerChord('ctrl-shift-cmd-c', { runner });
    expect(result).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'boom',
    });
  });

  it('passes custom delays through to the script', async () => {
    setPlatform('darwin');
    const runner = vi.fn(async () => ({ code: 0, stderr: '' }));
    await triggerChord('ctrl-c', { runner, loadDelay: 0, activateDelay: 0.5 });
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('delay 0'));
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('delay 0.5'));
  });
});

// Exercises defaultRunner's headless-vs-direct routing and runOsascriptDirect's
// timeout backstop via the public triggerChord (no injected runner), with only
// child_process.spawn mocked.
describe('defaultRunner (via triggerChord, no injected runner)', () => {
  const originalPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  // A minimal ChildProcess stand-in: an EventEmitter with a stderr stream and a
  // spy kill(). spawn's real return type is satisfied via a single cast.
  const makeChild = () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  };
  const returnChild = (child: ReturnType<typeof makeChild>) => {
    vi.mocked(spawn).mockImplementation(
      (() => child) as unknown as typeof spawn,
    );
  };

  beforeEach(() => {
    setPlatform('darwin');
    vi.stubEnv('SSH_CONNECTION', '');
    vi.stubEnv('SSH_TTY', '');
    vi.stubEnv('SSH_CLIENT', '');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.mocked(spawn).mockReset();
  });

  it('spawns osascript directly when not headless', async () => {
    const child = makeChild();
    returnChild(child);
    const promise = triggerChord('ctrl-c', {});
    await Promise.resolve();
    child.emit('close', 0);
    expect(await promise).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e']),
      expect.anything(),
    );
  });

  it('hands off to Launch Services (open -a Terminal) when headless', async () => {
    vi.stubEnv('SSH_CONNECTION', '10.0.0.1 1 10.0.0.2 22');
    vi.useFakeTimers();
    const child = makeChild();
    // `open` exits immediately; the GUI helper never writes a result file, so
    // pollFile times out — which is all we need to assert the routing.
    vi.mocked(spawn).mockImplementation(((..._args: unknown[]) => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as unknown as typeof spawn);

    const promise = triggerChord('ctrl-c', {});
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(spawn).toHaveBeenCalledWith(
      'open',
      ['-a', 'Terminal', expect.any(String)],
      expect.anything(),
    );
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect((result as { message?: string }).message).toContain('Timed out');
  });

  it('kills osascript and reports a timeout when it never exits', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    returnChild(child);

    const promise = triggerChord('ctrl-c', {});
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(child.kill).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect((result as { message?: string }).message).toContain('timed out');
  });
});

describe('isHeadlessSession', () => {
  it('is true when an SSH variable is present', () => {
    expect(
      isHeadlessSession({ SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }),
    ).toBe(true);
    expect(isHeadlessSession({ SSH_TTY: '/dev/ttys001' })).toBe(true);
    expect(isHeadlessSession({ SSH_CLIENT: '10.0.0.1 1 22' })).toBe(true);
  });

  it('is false with no SSH variables', () => {
    expect(isHeadlessSession({})).toBe(false);
  });
});

describe('buildGuiHelperScript', () => {
  it('runs the script with osascript and writes the result atomically', () => {
    const helper = buildGuiHelperScript(
      '/tmp/x/chord.applescript',
      '/tmp/x/result',
    );
    expect(helper.startsWith('#!/bin/sh\n')).toBe(true);
    expect(helper).toContain(
      "out=$(osascript '/tmp/x/chord.applescript' 2>&1)",
    );
    expect(helper).toContain(
      `printf '%s\\n%s' "$code" "$out" > '/tmp/x/result.tmp' && mv '/tmp/x/result.tmp' '/tmp/x/result'`,
    );
  });

  it('makes a best-effort attempt to close the Terminal window', () => {
    const helper = buildGuiHelperScript('/tmp/x/s', '/tmp/x/r');
    expect(helper).toContain(
      'tell application "Terminal" to close front window',
    );
  });
});

describe('parseGuiResult', () => {
  it('parses exit code 0 with no stderr as success', () => {
    expect(parseGuiResult('0\n')).toEqual({ code: 0, stderr: '' });
  });

  it('splits the exit code from a multi-line stderr', () => {
    expect(parseGuiResult('1\nboom\nmore')).toEqual({
      code: 1,
      stderr: 'boom\nmore',
    });
  });

  it('returns a null code and a diagnostic when the content is not a number', () => {
    expect(parseGuiResult('nope')).toEqual({
      code: null,
      stderr: 'unexpected result format (first line: "nope")',
    });
  });

  it('returns a null code and a diagnostic for an empty string', () => {
    expect(parseGuiResult('')).toEqual({
      code: null,
      stderr: 'unexpected result format (first line: "")',
    });
  });

  it('preserves stderr when the code line is non-numeric but has a newline', () => {
    expect(parseGuiResult('nope\nthe actual error')).toEqual({
      code: null,
      stderr: 'the actual error',
    });
  });

  it('parses exit code 0 with stderr present', () => {
    expect(parseGuiResult('0\nsome warning')).toEqual({
      code: 0,
      stderr: 'some warning',
    });
  });
});

describe('openAccessibilitySettings', () => {
  const originalPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('opens the Accessibility settings URL on macOS', () => {
    setPlatform('darwin');
    const open = vi.fn();
    openAccessibilitySettings(open);
    expect(open).toHaveBeenCalledWith(ACCESSIBILITY_SETTINGS_URL);
  });

  it('does nothing on non-macOS', () => {
    setPlatform('linux');
    const open = vi.fn();
    openAccessibilitySettings(open);
    expect(open).not.toHaveBeenCalled();
  });
});
