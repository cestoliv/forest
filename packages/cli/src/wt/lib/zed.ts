// src/lib/zed.ts
//
// Zed automation for `wt agent`: write a per-worktree `.zed/tasks.json` that
// runs the AI agent, ensure a global keymap chord spawns that task, then press
// the chord via `osascript` (macOS only).
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';

/** Label shared by the written task and the keymap binding (must match). */
export const AGENT_TASK_LABEL = 'wt: agent';

/** A Zed task entry as serialised into `.zed/tasks.json`. */
export interface ZedTask {
  label: string;
  command: string;
  cwd: string;
  use_new_terminal: boolean;
  allow_concurrent_runs: boolean;
  reveal: string;
  reveal_target: string;
  shell: string;
}

/** A Zed keymap entry as serialised into `keymap.json`. */
export interface KeymapEntry {
  context?: string;
  bindings: Record<string, unknown>;
}

/** What `writeAgentTask` created, so `cleanupAgentTask` can restore the tree. */
export interface CreatedArtifacts {
  createdDir: boolean;
  createdFile: boolean;
}

// ---------------------------------------------------------------------------
// Pure functions (no I/O) — unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * Build the Zed task that runs `<agentCommand> '<prompt>'`. The whole
 * invocation lives in `command` with the prompt single-quoted (args empty),
 * because with `shell: "system"` Zed runs `zsh -i -c "<command + args>"`
 * without shell-quoting, so a multi-word prompt placed in `args` would be
 * word-split (the agent would receive only the first word).
 *
 * When a mode is provided, injects `--permission-mode <mode>` into the command,
 * removing any existing `--permission-mode` flag from agentCommand to avoid
 * duplicates.
 *
 * When `appendPrompt` is false, the prompt is NOT appended/quoted — the caller
 * has already placed it inside `agentCommand` (e.g. via a `{{prompt}}`
 * template), so appending it again would emit it twice.
 */
export function buildAgentTask(
  agentCommand: string,
  prompt: string,
  label: string,
  mode?: string,
  appendPrompt = true,
): ZedTask {
  let finalCommand = agentCommand;

  // Only modify the command if a mode is explicitly provided
  if (mode) {
    // Remove any existing --permission-mode flag to avoid duplicates
    const baseCommand = agentCommand
      .replace(/--permission-mode\s+\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    finalCommand = `${baseCommand} --permission-mode ${mode}`.trim();
  }

  const command = appendPrompt
    ? `${finalCommand} '${prompt.replace(/'/g, "'\\''")}'`
    : finalCommand;
  return {
    label,
    command,
    cwd: '$ZED_WORKTREE_ROOT',
    use_new_terminal: true,
    allow_concurrent_runs: false,
    reveal: 'always',
    reveal_target: 'dock',
    shell: 'system',
  };
}

/** Replace an existing task with the same label, or append it. */
export function upsertTask(tasks: ZedTask[], task: ZedTask): ZedTask[] {
  const idx = tasks.findIndex((t) => t.label === task.label);
  if (idx === -1) return [...tasks, task];
  const next = [...tasks];
  next[idx] = task;
  return next;
}

/** Remove the task with the given label. */
export function removeTask(tasks: ZedTask[], label: string): ZedTask[] {
  return tasks.filter((t) => t.label !== label);
}

/** Build a keymap entry binding `chord` to `task::Spawn` of `label`. */
export function buildKeymapBinding(chord: string, label: string): KeymapEntry {
  return {
    context: 'Workspace',
    bindings: { [chord]: ['task::Spawn', { task_name: label }] },
  };
}

/**
 * Idempotently add our chord→task binding to a keymap array. If a Workspace
 * entry already binds the chord to our task, the array is returned unchanged
 * (same reference). Otherwise our binding is appended last so it wins in Zed
 * (later entries take precedence).
 */
export function upsertKeymapBinding(
  keymap: KeymapEntry[],
  chord: string,
  label: string,
): KeymapEntry[] {
  const target = buildKeymapBinding(chord, label);
  const targetValue = JSON.stringify(target.bindings[chord]);
  const already = keymap.some(
    (e) =>
      e.context === 'Workspace' &&
      e.bindings != null &&
      JSON.stringify(e.bindings[chord]) === targetValue,
  );
  if (already) return keymap;
  return [...keymap, target];
}

/**
 * True when `chord` is already bound to a *different* action somewhere in the
 * keymap (i.e. not our `task::Spawn` of `label`). Used to warn before we append
 * our binding, which wins via last-precedence and would otherwise silently
 * shadow the user's existing binding.
 */
export function hasConflictingChord(
  keymap: KeymapEntry[],
  chord: string,
  label: string,
): boolean {
  const ours = JSON.stringify(buildKeymapBinding(chord, label).bindings[chord]);
  return keymap.some(
    (e) =>
      e.bindings != null &&
      e.bindings[chord] !== undefined &&
      JSON.stringify(e.bindings[chord]) !== ours,
  );
}

const MODIFIER_MAP: Record<string, string> = {
  ctrl: 'control down',
  control: 'control down',
  shift: 'shift down',
  cmd: 'command down',
  command: 'command down',
  super: 'command down',
  alt: 'option down',
  opt: 'option down',
  option: 'option down',
};

/**
 * AppleScript `key code` numbers for named (non-character) keys. `keystroke`
 * only types literal characters, so multi-char keys like `space` or `f5` must be
 * sent as `key code N` instead (also layout-robust for modified chords).
 */
const KEY_CODE_MAP: Record<string, number> = {
  space: 49,
  tab: 48,
  return: 36,
  enter: 36,
  escape: 53,
  esc: 53,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

/**
 * Parse a chord like `ctrl-shift-cmd-c` into the final key and its AppleScript
 * modifier list (`['control down', 'shift down', 'command down']`).
 */
export function parseChord(chord: string): {
  key: string;
  modifiers: string[];
} {
  const parts = chord
    .split('-')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid chord: "${chord}"`);
  }
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => {
    const mapped = MODIFIER_MAP[m];
    if (!mapped) {
      throw new Error(`Unknown modifier "${m}" in chord "${chord}"`);
    }
    return mapped;
  });
  return { key, modifiers };
}

/**
 * Build the AppleScript that lets Zed load, activates it, then presses the
 * chord. Delays give the new window time to load `.zed/tasks.json` before the
 * task is spawned. Single-character keys are sent with `keystroke`; named keys
 * (e.g. `space`, `tab`, `f5`) are sent with `key code N`, since `keystroke`
 * would type the literal characters of the name instead. Throws on an unknown
 * multi-character key so the failure is loud rather than silent.
 */
export function buildOsascript(
  chord: string,
  opts: { loadDelay?: number; activateDelay?: number } = {},
): string {
  const { loadDelay = 3, activateDelay = 0.8 } = opts;
  const { key, modifiers } = parseChord(chord);
  const using = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
  let press: string;
  if (key.length === 1) {
    // Escape for an AppleScript string literal so a `"` or `\` key (e.g.
    // `cmd-"`) can't produce a malformed `keystroke` line.
    const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    press = `keystroke "${escaped}"`;
  } else {
    const code = KEY_CODE_MAP[key];
    if (code === undefined) {
      throw new Error(
        `Unsupported key "${key}" in chord "${chord}". Use a single character ` +
          `or one of: ${Object.keys(KEY_CODE_MAP).join(', ')}.`,
      );
    }
    press = `key code ${code}`;
  }
  return [
    `delay ${loadDelay}`,
    'tell application "Zed" to activate',
    `delay ${activateDelay}`,
    `tell application "System Events" to ${press}${using}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Side-effecting wrappers (thin; dependencies injectable for tests).
// ---------------------------------------------------------------------------

/** Parse JSONC task-array text; null if it isn't valid or isn't an array. */
function parseTasks(raw: string): ZedTask[] | null {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !Array.isArray(parsed)) return null;
  return parsed as ZedTask[];
}

function readTasks(tasksPath: string): ZedTask[] {
  try {
    return parseTasks(readFileSync(tasksPath, 'utf8')) ?? [];
  } catch {
    return [];
  }
}

/**
 * Write the agent task into `<worktree>/.zed/tasks.json`, upserting into any
 * pre-existing file. Zed's tasks.json is JSONC, so a pre-existing file is edited
 * in place with `jsonc-parser`, preserving the user's comments and formatting;
 * only a file we create from scratch is written as plain JSON. Returns what was
 * created so cleanup can restore the tree.
 */
export function writeAgentTask(
  worktreePath: string,
  task: ZedTask,
): CreatedArtifacts {
  const zedDir = join(worktreePath, '.zed');
  const tasksPath = join(zedDir, 'tasks.json');
  const createdDir = !existsSync(zedDir);
  if (createdDir) mkdirSync(zedDir, { recursive: true });
  const createdFile = !existsSync(tasksPath);

  // Fresh file — write a clean array containing just our task.
  if (createdFile) {
    writeFileSync(tasksPath, `${JSON.stringify([task], null, 2)}\n`);
    return { createdDir, createdFile };
  }

  // Pre-existing file — edit in place to keep the user's comments/formatting.
  const raw = readFileSync(tasksPath, 'utf8');
  const tasks = parseTasks(raw);
  if (tasks === null) {
    process.stderr.write(
      `\nWarning: could not parse ${tasksPath}; not modifying it. ` +
        'The agent task was not added.\n',
    );
    return { createdDir, createdFile };
  }
  const idx = tasks.findIndex((t) => t.label === task.label);
  const edits = modify(raw, idx === -1 ? [tasks.length] : [idx], task, {
    isArrayInsertion: idx === -1,
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const updated = applyEdits(raw, edits);
  writeFileSync(tasksPath, updated.endsWith('\n') ? updated : `${updated}\n`);
  return { createdDir, createdFile };
}

/**
 * Remove our task from `.zed/tasks.json` to leave the repo clean. Deletes the
 * file and/or the `.zed` directory only when `writeAgentTask` created them and
 * they end up empty. A pre-existing file is edited with `jsonc-parser`, so the
 * user's other tasks keep their comments and formatting — only our entry is
 * removed.
 */
export function cleanupAgentTask(
  worktreePath: string,
  label: string,
  created: CreatedArtifacts,
): void {
  const zedDir = join(worktreePath, '.zed');
  const tasksPath = join(zedDir, 'tasks.json');
  if (existsSync(tasksPath)) {
    try {
      if (created.createdFile) {
        // We created this file fresh (plain JSON, no user content) — drop our
        // entry, deleting the file if nothing remains.
        const next = removeTask(readTasks(tasksPath), label);
        if (next.length === 0) {
          rmSync(tasksPath, { force: true });
        } else {
          writeFileSync(tasksPath, `${JSON.stringify(next, null, 2)}\n`);
        }
      } else {
        // Pre-existing file — drop only our entry, preserving the rest verbatim.
        const raw = readFileSync(tasksPath, 'utf8');
        const tasks = parseTasks(raw);
        const idx = tasks?.findIndex((t) => t.label === label) ?? -1;
        if (idx !== -1) {
          const edits = modify(raw, [idx], undefined, {});
          const updated = applyEdits(raw, edits);
          writeFileSync(
            tasksPath,
            updated.endsWith('\n') ? updated : `${updated}\n`,
          );
        }
      }
    } catch {
      // best-effort cleanup of the task file
    }
  }
  if (created.createdDir && existsSync(zedDir)) {
    try {
      if (readdirSync(zedDir).length === 0) {
        rmSync(zedDir, { recursive: true, force: true });
      }
    } catch {
      // best-effort cleanup of the directory
    }
  }
}

function defaultKeymapPath(): string {
  return join(homedir(), '.config', 'zed', 'keymap.json');
}

/**
 * Idempotently ensure the global Zed keymap binds `chord` to `task::Spawn` of
 * `label`. Zed's keymap is JSONC (comments + trailing commas), so it is parsed
 * and edited with `jsonc-parser`, appending only our entry and leaving the
 * user's other bindings, comments, and formatting untouched. Creates the file
 * if missing. If the file can't be parsed into an array, warns with the binding
 * to add manually and returns false without touching it. The chord is
 * intentionally kept between runs.
 */
export function ensureKeymap(
  chord: string,
  label: string,
  keymapPath: string = defaultKeymapPath(),
): boolean {
  const binding = buildKeymapBinding(chord, label);

  if (!existsSync(keymapPath)) {
    mkdirSync(dirname(keymapPath), { recursive: true });
    writeFileSync(keymapPath, `${JSON.stringify([binding], null, 2)}\n`);
    return true;
  }

  const raw = readFileSync(keymapPath, 'utf8');
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0 || !Array.isArray(parsed)) {
    process.stderr.write(
      `\nWarning: could not parse ${keymapPath}; not modifying it. ` +
        `Add this binding manually:\n${JSON.stringify(binding, null, 2)}\n`,
    );
    return false;
  }

  const keymap = parsed as KeymapEntry[];
  // Already bound to our task — idempotent no-op (same reference back).
  if (upsertKeymapBinding(keymap, chord, label) === keymap) {
    return true;
  }

  // Our binding is appended last and wins in Zed; if the chord already maps to
  // something else, warn so the user knows their binding is being shadowed.
  if (hasConflictingChord(keymap, chord, label)) {
    process.stderr.write(
      `\nNote: "${chord}" is already bound in ${keymapPath}; wt's agent ` +
        'binding will take precedence.\n',
    );
  }

  // Insert our entry at the end of the array, preserving comments/formatting.
  const edits = modify(raw, [keymap.length], binding, {
    isArrayInsertion: true,
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const updated = applyEdits(raw, edits);

  writeFileSync(keymapPath, updated.endsWith('\n') ? updated : `${updated}\n`);
  return true;
}

/** Raw result of running an AppleScript via osascript. */
export interface OsascriptResult {
  code: number | null;
  stderr: string;
}

/** Runs an AppleScript and resolves its exit code + stderr. */
export type OsascriptRunner = (script: string) => Promise<OsascriptResult>;

/** Outcome of attempting to press the trigger chord. */
export type TriggerResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unsupported' | 'accessibility' | 'error';
      message?: string;
    };

/** macOS settings URL for the Accessibility privacy pane. */
export const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

/**
 * True when wt is running in a non-graphical session (e.g. over SSH). A process
 * in an SSH session lives in the `Background` launchd/audit namespace, not the
 * logged-in user's `Aqua` session, so a directly-spawned osascript can't reach
 * the window server and `System Events` times out (`-1712`). When headless the
 * keystroke is instead handed to Launch Services so it runs inside the GUI
 * session — see {@link runViaGuiHelper}.
 */
export function isHeadlessSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

/**
 * Shell run by the Launch Services helper *inside* the Aqua session. It runs the
 * AppleScript at `scriptPath` with osascript, writes `<exitcode>\n<stderr>`
 * atomically to `resultPath` (so the SSH side can poll for it), then makes a
 * best-effort attempt to close the Terminal window it was launched in.
 */
export function buildGuiHelperScript(
  scriptPath: string,
  resultPath: string,
): string {
  // Wrap a value as a shell single-quoted literal, escaping any embedded
  // single quotes (close, escaped quote, reopen). Paths come from mkdtempSync
  // today, but this keeps the helper correct for any path.
  const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  return [
    '#!/bin/sh',
    `out=$(osascript ${q(scriptPath)} 2>&1)`,
    'code=$?',
    `printf '%s\\n%s' "$code" "$out" > ${q(`${resultPath}.tmp`)} && mv ${q(`${resultPath}.tmp`)} ${q(resultPath)}`,
    `osascript -e 'tell application "Terminal" to close front window' >/dev/null 2>&1 &`,
    '',
  ].join('\n');
}

/** Parse the helper's `<exitcode>\n<stderr>` result file into an OsascriptResult. */
export function parseGuiResult(content: string): OsascriptResult {
  const newline = content.indexOf('\n');
  const codeStr = (newline === -1 ? content : content.slice(0, newline)).trim();
  const stderr = newline === -1 ? '' : content.slice(newline + 1);
  const code = Number.parseInt(codeStr, 10);
  if (Number.isNaN(code)) {
    return {
      code: null,
      stderr:
        stderr ||
        `unexpected result format (first line: ${JSON.stringify(codeStr)})`,
    };
  }
  return { code, stderr };
}

/** Hard cap so a wedged osascript can't hang wt forever (default timeout ~60s+). */
const OSASCRIPT_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Spawn `open -a Terminal <helper>` and resolve once `open` has handed off. */
function spawnOpen(helperPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('open', ['-a', 'Terminal', helperPath], {
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
}

/** Poll for `path` to appear, returning its contents or null on timeout. */
async function pollFile(
  path: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
    await sleep(200);
  }
  return null;
}

/**
 * Run an AppleScript from a non-GUI (SSH) session via Launch Services:
 * `open -a Terminal <helper>` starts the helper inside the logged-in user's Aqua
 * session, where the window server is reachable — avoiding the `-1712` timeout a
 * directly-spawned osascript hits (and the `launchctl asuser` audit-session
 * error, which needs root). The helper writes its result to a temp file we poll.
 * Accessibility for the keystroke is attributed to Terminal (a stable identity),
 * so the grant persists across runs.
 */
async function runViaGuiHelper(script: string): Promise<OsascriptResult> {
  const dir = mkdtempSync(join(tmpdir(), 'wt-agent-'));
  const scriptPath = join(dir, 'chord.applescript');
  const helperPath = join(dir, 'run.command');
  const resultPath = join(dir, 'result');
  try {
    writeFileSync(scriptPath, script);
    writeFileSync(helperPath, buildGuiHelperScript(scriptPath, resultPath));
    chmodSync(helperPath, 0o755);
    await spawnOpen(helperPath);
    const content = await pollFile(resultPath, OSASCRIPT_TIMEOUT_MS);
    if (content === null) {
      return {
        code: null,
        stderr:
          "Timed out waiting for the keystroke — is a user logged into the Mac's graphical session?",
      };
    }
    return parseGuiResult(content);
  } catch (err) {
    return {
      code: null,
      stderr: err instanceof Error ? err.message : String(err),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run osascript directly (graphical session) with a timeout backstop. */
function runOsascriptDirect(script: string): Promise<OsascriptResult> {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (result: OsascriptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        code: null,
        stderr:
          "osascript timed out — is a user logged into the Mac's graphical session?",
      });
    }, OSASCRIPT_TIMEOUT_MS);
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => finish({ code: null, stderr: err.message }));
    child.on('close', (code) => finish({ code, stderr }));
  });
}

/**
 * Default osascript runner: over SSH it goes through the Launch Services helper
 * so the keystroke runs in the GUI session; otherwise it spawns osascript
 * directly.
 */
function defaultRunner(script: string): Promise<OsascriptResult> {
  return isHeadlessSession()
    ? runViaGuiHelper(script)
    : runOsascriptDirect(script);
}

/**
 * True when osascript stderr carries a missing-Accessibility signature:
 * `(1002)` "not allowed to send keystrokes" or `(-1719)` "not allowed
 * assistive access".
 */
export function isAccessibilityError(stderr: string): boolean {
  return (
    /\b1002\b/.test(stderr) ||
    /-1719\b/.test(stderr) ||
    /not allowed to send keystrokes/i.test(stderr) ||
    /not allowed assistive access/i.test(stderr)
  );
}

/**
 * Press the trigger chord via osascript (macOS only). Returns a structured
 * result so callers can distinguish a missing-Accessibility failure (which the
 * user can grant and retry) from other errors. On non-darwin platforms it
 * returns `{ ok: false, reason: 'unsupported' }` without spawning anything.
 */
export async function triggerChord(
  chord: string,
  opts: {
    runner?: OsascriptRunner;
    loadDelay?: number;
    activateDelay?: number;
  } = {},
): Promise<TriggerResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported' };
  }
  const { runner = defaultRunner, loadDelay, activateDelay } = opts;
  const { code, stderr } = await runner(
    buildOsascript(chord, { loadDelay, activateDelay }),
  );
  if (code === 0) return { ok: true };
  if (isAccessibilityError(stderr)) {
    return { ok: false, reason: 'accessibility', message: stderr.trim() };
  }
  return {
    ok: false,
    reason: 'error',
    message: stderr.trim() || `osascript exited with code ${code}`,
  };
}

function defaultOpen(url: string): void {
  const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** Open the macOS Accessibility settings pane (no-op on non-darwin). */
export function openAccessibilitySettings(
  open: (url: string) => void = defaultOpen,
): void {
  if (process.platform !== 'darwin') return;
  open(ACCESSIBILITY_SETTINGS_URL);
}
