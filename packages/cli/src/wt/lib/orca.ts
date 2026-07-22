// src/lib/orca.ts
//
// Orca automation for `wt agent`/`wt create` when `ide` is "orca". Unlike the
// Zed path (which drives the editor's task runner + a keystroke), Orca exposes
// a CLI: we create the worktree ourselves with plain git, register the repo
// with `orca repo add`, then attach a terminal to the worktree with
// `orca terminal create` — running our own agent command line inside it (the
// same string the Zed path builds), or just an interactive shell when opening
// without an agent.
import { spawn } from 'node:child_process';
import * as clack from '@clack/prompts';

// ---------------------------------------------------------------------------
// Pure functions (no I/O) — unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * Build the agent command line `<agentCommand> '<prompt>'`, injecting
 * `--permission-mode <mode>` and `--model <model>` and single-quoting the prompt.
 * This is the single source of truth for that string: the Zed path wraps it in
 * a `.zed/tasks.json` task (see `buildAgentTask`), the Orca path passes it to
 * `orca terminal create --command`.
 *
 * When a mode is provided, `--permission-mode <mode>` is injected, removing any
 * existing `--permission-mode` flag from `agentCommand` first to avoid
 * duplicates.
 *
 * When a model is provided (non-empty string), `--model <model>` is injected,
 * removing any existing `--model` flag first to avoid duplicates.
 *
 * When `appendPrompt` is false, the prompt is NOT appended/quoted — the caller
 * has already placed it inside `agentCommand` (e.g. via a `{{prompt}}`
 * template), so appending it again would emit it twice.
 */
export function buildAgentCommandLine(
  agentCommand: string,
  prompt: string,
  mode?: string,
  appendPrompt = true,
  model?: string,
): string {
  let finalCommand = agentCommand;

  // Only modify the command if a mode is explicitly provided.
  if (mode) {
    // Remove any existing --permission-mode flag to avoid duplicates.
    const baseCommand = finalCommand
      .replace(/--permission-mode\s+\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    finalCommand = `${baseCommand} --permission-mode ${mode}`.trim();
  }

  // Only modify the command if a model is explicitly provided (non-empty).
  if (model) {
    // Remove any existing --model flag to avoid duplicates.
    const baseCommand = finalCommand
      .replace(/--model\s+\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    finalCommand = `${baseCommand} --model ${model}`.trim();
  }

  return appendPrompt
    ? `${finalCommand} '${prompt.replace(/'/g, "'\\''")}'`
    : finalCommand;
}

/**
 * `orca status --json` argv — the runtime probe. Single source of truth: both
 * `buildOrcaCommands` (launch) and `stopOrcaWorktree` (teardown) use it, so a
 * future flag change can't make the two paths drift.
 */
const STATUS_ARGS = ['status', '--json'];

/** The `orca` invocations a launch needs, as argv arrays (no shell). */
export interface OrcaCommands {
  /** `orca status --json` — probe the runtime before doing anything. */
  status: string[];
  /** `orca open --json` — launch Orca and wait for the runtime to come up. */
  open: string[];
  /** `orca repo add --path <repoRoot> --json` — idempotent registration. */
  repoAdd: string[];
  /** `orca terminal create …` — attach a terminal to the worktree. */
  terminalCreate: string[];
}

/**
 * Build the argv arrays for the Orca launch flow. `commandLine`, when given,
 * becomes the terminal's startup command (the agent); omit it to open a plain
 * interactive shell in the worktree (the non-agent `wt create` path). `title`
 * labels the terminal tab. The worktree is addressed by absolute path via the
 * `path:` selector, so it works on a worktree we created with plain git (not
 * only ones Orca created itself).
 *
 * Note: focus is NOT done via `terminal create --focus` — that flag reliably
 * times out ("waiting for terminal handle") on the installed Orca. Instead the
 * caller reveals the tab afterwards with `terminal switch` (see
 * `buildSwitchCommand`).
 */
export function buildOrcaCommands(opts: {
  repoRoot: string;
  worktreePath: string;
  commandLine?: string;
  title?: string;
}): OrcaCommands {
  const { repoRoot, worktreePath, commandLine, title } = opts;
  const terminalCreate = [
    'terminal',
    'create',
    '--worktree',
    `path:${worktreePath}`,
  ];
  if (title) terminalCreate.push('--title', title);
  if (commandLine) terminalCreate.push('--command', commandLine);
  terminalCreate.push('--json');
  return {
    status: [...STATUS_ARGS],
    open: ['open', '--json'],
    repoAdd: ['repo', 'add', '--path', repoRoot, '--json'],
    terminalCreate,
  };
}

/** `orca terminal switch --terminal <handle> --json` — bring the tab forward. */
export function buildSwitchCommand(handle: string): string[] {
  return ['terminal', 'switch', '--terminal', handle, '--json'];
}

/**
 * `orca terminal stop --worktree path:<abs> --json` — stop the agent and close
 * the terminal attached to that worktree. Addressed by path (not by the
 * ephemeral terminal handle, which we never persist), so it works at teardown
 * time. Orca answers `ok: false` / `selector_not_found` (exit 0) for a worktree
 * it never saw — a harmless no-op.
 */
export function buildStopCommand(worktreePath: string): string[] {
  return ['terminal', 'stop', '--worktree', `path:${worktreePath}`, '--json'];
}

/**
 * Pull the runtime-issued terminal handle out of `orca terminal create --json`
 * output (`result.terminal.handle`). Returns null if the output isn't valid
 * JSON or has no handle — the caller then just skips the focus step.
 */
export function parseTerminalHandle(createStdout: string): string | null {
  try {
    const parsed = JSON.parse(createStdout) as {
      result?: { terminal?: { handle?: unknown } };
    };
    const handle = parsed.result?.terminal?.handle;
    return typeof handle === 'string' && handle ? handle : null;
  } catch {
    return null;
  }
}

/**
 * Whether `orca status --json` output reports the runtime as reachable. Fails
 * closed (false) on any parse error or an unexpected shape — a not-reachable
 * result and unparseable output are treated the same (runtime unavailable).
 */
export function isRuntimeReachable(statusStdout: string): boolean {
  try {
    const parsed = JSON.parse(statusStdout) as {
      result?: { runtime?: { reachable?: boolean } };
    };
    return parsed.result?.runtime?.reachable === true;
  } catch {
    return false;
  }
}

/**
 * Whether an `orca … --json` result counts as success. A command succeeds only
 * when it exits 0 **and** its JSON payload has `ok === true`. When the payload
 * explicitly says `ok: false` it's a failure even on exit 0; when the output
 * isn't valid JSON or has no boolean `ok`, we fall back to the exit code (so an
 * unexpected-but-zero-exit response is still treated as success rather than
 * hard-failing on shape).
 */
export function isOrcaSuccess(result: OrcaResult): boolean {
  if (result.code !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout) as { ok?: unknown };
    if (typeof parsed.ok === 'boolean') return parsed.ok;
  } catch {
    // fall through to the exit-code result
  }
  return true;
}

/**
 * Whether an `orca … --json` failure is a `selector_not_found` — the runtime
 * couldn't resolve the `--worktree path:<abs>` selector. For `terminal create`
 * this almost always means the repo has *external-worktree visibility* turned
 * off in Orca (the default for newly-added repos since Orca 1.4): `wt` creates
 * its worktrees with plain git, and Orca ignores every external (non-Orca-made)
 * worktree for such a repo, so the path selector misses. Fails closed (false)
 * on non-JSON output or any other error shape.
 */
export function isSelectorNotFound(result: OrcaResult): boolean {
  try {
    const parsed = JSON.parse(result.stdout) as {
      error?: { code?: unknown };
    };
    return parsed.error?.code === 'selector_not_found';
  } catch {
    return false;
  }
}

/**
 * Actionable hint shown when `terminal create` fails with `selector_not_found`
 * — explains the likely cause (external-worktree visibility off) and the fix,
 * so the cryptic "create failed" line becomes something the user can act on.
 */
export const SELECTOR_NOT_FOUND_HINT =
  "✗ orca terminal create failed: Orca can't see this worktree.\n" +
  '  wt creates worktrees with plain git, but this repo has external-worktree\n' +
  '  visibility turned off in Orca (the default for newly-added repos), so Orca\n' +
  '  ignores them and the worktree selector misses.\n' +
  '  Fix: in Orca, open this repo and enable showing its external worktrees.';

// ---------------------------------------------------------------------------
// Side-effecting wrappers (thin; runner + sleep injectable for tests).
// ---------------------------------------------------------------------------

/** Raw result of running an `orca` subcommand. */
export interface OrcaResult {
  /** Exit code; null when the process could not be spawned (e.g. ENOENT). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `orca <args…>` and resolves its exit code + captured output. */
export type OrcaRunner = (args: string[]) => Promise<OrcaResult>;

/** Suspends for `ms` — injectable so tests don't actually wait. */
export type Sleeper = (ms: number) => Promise<void>;

/**
 * Ask the user whether to retry after a fixable `terminal create` failure
 * (external-worktree visibility off). Returns true to retry. Injectable so
 * tests don't touch a real prompt; the default (`defaultConfirmRetry`) is
 * TTY-gated, so a non-interactive caller (the daemon) never prompts and just
 * gives up.
 */
export type RetryConfirm = () => Promise<boolean>;

/** Delay between `orca status` polls while waiting for the runtime to come up. */
const RUNTIME_POLL_DELAY_MS = 500;
/** Bounded number of `orca status` polls after launching Orca (~3s total). */
const RUNTIME_POLL_ATTEMPTS = 6;

/**
 * Wall-clock bound on each `orca` call made by `stopOrcaWorktree`. Teardown is
 * silent, so a wedged runtime would otherwise hang `deleteWorktree` forever
 * (once per worktree during `wt prune`). Deliberately NOT applied to the launch
 * path, where `orca open` legitimately takes a while.
 */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Spawn `orca` with the given args, capturing stdout/stderr. When `timeoutMs` is
 * given the call is hard-bounded: on expiry the child's whole process group is
 * killed and we resolve immediately with a null exit code — which every caller
 * already treats as "give up quietly".
 *
 * Three details make the bound real, and none is optional:
 * - `spawn`'s own `timeout` option is NOT enough. `orca` is a bash wrapper that
 *   runs the real binary as a child, so SIGTERM-ing the wrapper leaves that
 *   grandchild alive holding our stdout pipe open — `close` (which we resolve
 *   on) then fires only when the grandchild finally exits. Hence `detached`, so
 *   the child leads its own process group and `kill(-pid)` reaps the whole tree.
 * - We resolve from the timer rather than waiting for the ensuing `close`, so
 *   even a kill that fails cannot leave the caller hanging past the bound.
 * - On expiry we also drop the inherited pipes and `unref` the child, which
 *   bounds the *process*, not just the promise. A descendant that escaped the
 *   process group (`setsid`/`setpgid`) survives `kill(-pid)` and keeps our
 *   stdout/stderr handles — and hence Node's event loop — alive well past the
 *   deadline, leaving `wt` hung after it has already printed its output.
 */
function defaultRunner(
  args: string[],
  timeoutMs?: number,
): Promise<OrcaResult> {
  return new Promise((resolve) => {
    // A non-positive/absent timeout means unbounded: no timer, and therefore no
    // reason to detach (an undetached child dies with us; a detached one with no
    // timer would never be killed).
    const bound =
      timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : undefined;
    const child = spawn('orca', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: bound !== undefined,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: OrcaResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    if (bound !== undefined) {
      timer = setTimeout(() => {
        if (child.pid) {
          // Negative pid ⇒ the process group (wrapper + real orca binary).
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Already gone; nothing to reap.
          }
        }
        // Release the pipes an escaped descendant may still hold, so the event
        // loop can drain even when the kill missed something.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish({ code: null, stdout, stderr });
      }, bound);
    }

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    // ENOENT (orca not installed) surfaces here — resolve with code null so the
    // caller reports it rather than the process crashing.
    child.on('error', (err) =>
      finish({ code: null, stdout, stderr: err.message }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

const defaultSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default retry prompt for the `selector_not_found` path. TTY-gated: with no
 * interactive stdin (the daemon, a piped run) it returns false immediately so
 * the flow reports the hint and gives up rather than blocking on a prompt that
 * can't be answered. Otherwise it asks the user to confirm they've enabled the
 * repo's external-worktree visibility in Orca, and retries on yes.
 */
const defaultConfirmRetry: RetryConfirm = async () => {
  if (!process.stdin.isTTY) return false;
  const proceed = await clack.confirm({
    message:
      'Enabled external-worktree visibility for this repo in Orca? Retry terminal create?',
  });
  return !clack.isCancel(proceed) && proceed === true;
};

/** True when a `status` result shows the runtime reachable (exit 0 + reachable). */
function statusReachable(status: OrcaResult): boolean {
  return status.code === 0 && isRuntimeReachable(status.stdout);
}

/**
 * Ensure the Orca runtime is reachable, launching it if not. Probes `orca
 * status`; if the runtime is down it runs `orca open` (which itself waits for
 * the runtime) and then polls `orca status` a bounded number of times. Returns
 * true once reachable, false (after reporting) if orca can't be spawned or the
 * runtime never comes up within the timeout.
 */
async function ensureRuntime(
  cmds: OrcaCommands,
  runner: OrcaRunner,
  report: (msg: string) => void,
  sleep: Sleeper,
): Promise<boolean> {
  const status = await runner(cmds.status);
  // code null ⇒ orca could not be spawned at all (not installed / ENOENT).
  if (status.code === null) {
    reportSpawnFailure(status, report);
    return false;
  }
  if (statusReachable(status)) return true;

  // Runtime is down — launch Orca and wait for it to become reachable.
  report('⚠ Orca runtime is not running — launching Orca…');
  const opened = await runner(cmds.open);
  if (opened.code === null) {
    reportSpawnFailure(opened, report);
    return false;
  }

  for (let attempt = 0; attempt < RUNTIME_POLL_ATTEMPTS; attempt++) {
    const probe = await runner(cmds.status);
    if (statusReachable(probe)) return true;
    // Don't sleep after the final probe — the give-up path would otherwise wait
    // a whole extra delay before reporting.
    if (attempt < RUNTIME_POLL_ATTEMPTS - 1) await sleep(RUNTIME_POLL_DELAY_MS);
  }

  report(
    '⚠ Orca runtime did not become ready. Open Orca (or run `orca open`), then retry.',
  );
  return false;
}

function reportSpawnFailure(
  result: OrcaResult,
  report: (msg: string) => void,
): void {
  report(
    `✗ Could not run orca (is it installed and on your PATH?)${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
  );
}

/**
 * Run the ensure-runtime → repo add → terminal create sequence, reporting only
 * the failure paths (the caller prints the success line so "agent started" vs.
 * "opened" reads correctly). Returns true only when `terminal create` succeeds
 * (exit 0 **and** `ok: true`, per `isOrcaSuccess`).
 *
 * When `focus` is set (interactive runs), the created tab is revealed with a
 * best-effort `terminal switch` — a failed/absent switch never fails the launch
 * (the terminal is already created and running).
 *
 * A `selector_not_found` on `terminal create` (Orca can't see the plain-git
 * worktree — usually external-worktree visibility being off) is fixable in
 * Orca's UI, so `confirmRetry` guides the user and re-runs the create until it
 * works or they decline. `confirmRetry` returns false for a non-interactive
 * caller (the daemon), so batch dispatch just reports the hint and gives up.
 */
async function runOrcaFlow(
  cmds: OrcaCommands,
  runner: OrcaRunner,
  report: (msg: string) => void,
  sleep: Sleeper,
  focus: boolean,
  confirmRetry: RetryConfirm,
): Promise<boolean> {
  if (!(await ensureRuntime(cmds, runner, report, sleep))) return false;

  const added = await runner(cmds.repoAdd);
  if (!isOrcaSuccess(added)) {
    report(
      `✗ orca repo add failed${added.stderr ? `: ${added.stderr.trim()}` : ''}.`,
    );
    return false;
  }

  let term = await runner(cmds.terminalCreate);
  // Guide-and-retry the fixable case: the worktree is invisible to Orca. The
  // hint (which already carries the "✗ … failed" line) is reprinted each round;
  // a declined/non-TTY confirm ends here without the generic failure line, since
  // the hint is the more useful message.
  while (!isOrcaSuccess(term) && isSelectorNotFound(term)) {
    report(SELECTOR_NOT_FOUND_HINT);
    if (!(await confirmRetry())) return false;
    term = await runner(cmds.terminalCreate);
  }
  if (!isOrcaSuccess(term)) {
    report(
      `✗ orca terminal create failed${term.stderr ? `: ${term.stderr.trim()}` : ''}.`,
    );
    return false;
  }

  // Reveal the new tab (interactive runs only). Best-effort: the `--focus` flag
  // on `terminal create` is broken on the installed Orca, so switch afterwards
  // using the runtime handle; if it isn't present or the switch fails, the
  // terminal still exists — focus is cosmetic, so we don't fail the launch.
  if (focus) {
    const handle = parseTerminalHandle(term.stdout);
    if (handle) await runner(buildSwitchCommand(handle));
  }
  return true;
}

/** Shared shape for the two launch entry points. */
interface OrcaLaunchBase {
  repoRoot: string;
  worktreePath: string;
  title?: string;
  /** Add `--focus` so Orca switches to the new terminal (interactive runs). */
  focus?: boolean;
  runner?: OrcaRunner;
  report?: (msg: string) => void;
  /** Injectable delay for the runtime-launch poll (tests pass a no-op). */
  sleep?: Sleeper;
  /** Injectable retry prompt for the `selector_not_found` path (tests stub it). */
  confirmRetry?: RetryConfirm;
}

/**
 * Register the repo with Orca and open the worktree in a plain interactive
 * terminal (no agent) — the `wt create --ide orca` path. Returns true when the
 * terminal was created.
 */
export function openWorktreeInOrca(opts: OrcaLaunchBase): Promise<boolean> {
  const {
    repoRoot,
    worktreePath,
    title,
    focus,
    runner = defaultRunner,
    sleep = defaultSleep,
    confirmRetry = defaultConfirmRetry,
  } = opts;
  const report = opts.report ?? ((m) => console.log(m));
  return runOrcaFlow(
    buildOrcaCommands({ repoRoot, worktreePath, title }),
    runner,
    report,
    sleep,
    focus ?? false,
    confirmRetry,
  );
}

/**
 * Register the repo with Orca and start the agent inside a terminal attached to
 * the worktree — the `wt agent --ide orca` path. `commandLine` is the fully
 * built agent invocation (see `buildAgentCommandLine`). Returns true only when
 * `terminal create` succeeds (the agent actually launched).
 */
export function startAgentInOrca(
  opts: OrcaLaunchBase & { commandLine: string },
): Promise<boolean> {
  const {
    repoRoot,
    worktreePath,
    commandLine,
    title,
    focus,
    runner = defaultRunner,
    sleep = defaultSleep,
    confirmRetry = defaultConfirmRetry,
  } = opts;
  const report = opts.report ?? ((m) => console.log(m));
  return runOrcaFlow(
    buildOrcaCommands({ repoRoot, worktreePath, commandLine, title }),
    runner,
    report,
    sleep,
    focus ?? false,
    confirmRetry,
  );
}

/**
 * Best-effort teardown: stop the agent and close the Orca terminal attached to
 * `worktreePath`, before the worktree directory goes away. Called for **every**
 * worktree deletion (`wt prune` and the TUI `D` key) — `ide` is not persisted
 * per worktree, so there is nothing to gate on.
 *
 * It is deliberately silent and never throws:
 * - It only **probes** the runtime (`orca status`) and returns immediately when
 *   it isn't reachable. A teardown must never boot Orca, and a runtime that's
 *   down has no live terminals to stop anyway.
 * - `orca` missing from PATH (ENOENT), a non-zero exit, and a `selector_not_found`
 *   result (the normal case for a Zed worktree Orca never saw) are all
 *   swallowed — none of them is an error worth showing the user.
 * - Each call is bounded by `STOP_TIMEOUT_MS`: a wedged runtime gets its child
 *   killed and the killed exit (null code) reads as "runtime unavailable", so
 *   the deletion proceeds instead of hanging.
 */
export async function stopOrcaWorktree(opts: {
  worktreePath: string;
  runner?: OrcaRunner;
}): Promise<void> {
  const {
    worktreePath,
    runner = (args: string[]) => defaultRunner(args, STOP_TIMEOUT_MS),
  } = opts;
  try {
    const status = await runner([...STATUS_ARGS]);
    if (!statusReachable(status)) return;
    await runner(buildStopCommand(worktreePath));
  } catch {
    // Orca must never block or fail a worktree deletion.
  }
}
