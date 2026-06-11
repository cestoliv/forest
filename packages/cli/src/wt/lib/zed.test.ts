// src/lib/zed.test.ts
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
  buildKeymapBinding,
  buildOsascript,
  cleanupAgentTask,
  ensureKeymap,
  isAccessibilityError,
  openAccessibilitySettings,
  parseChord,
  removeTask,
  triggerChord,
  upsertKeymapBinding,
  upsertTask,
  writeAgentTask,
  type ZedTask,
} from './zed.js';

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
