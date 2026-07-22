import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAgentCommandLine,
  buildOrcaCommands,
  buildStopCommand,
  buildSwitchCommand,
  isOrcaSuccess,
  isRuntimeReachable,
  isSelectorNotFound,
  type OrcaResult,
  type OrcaRunner,
  openWorktreeInOrca,
  parseTerminalHandle,
  SELECTOR_NOT_FOUND_HINT,
  startAgentInOrca,
  stopOrcaWorktree,
} from './orca.js';

// Only `defaultRunner` reaches child_process; every other test injects a runner.
// (vitest hoists vi.mock above the imports regardless of placement here.)
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('buildAgentCommandLine', () => {
  it('appends the single-quoted prompt when no mode is given', () => {
    expect(buildAgentCommandLine('claude', 'do stuff')).toBe(
      "claude 'do stuff'",
    );
  });

  it('escapes single quotes in the prompt', () => {
    expect(buildAgentCommandLine('claude', "it's a test")).toBe(
      "claude 'it'\\''s a test'",
    );
  });

  it('injects --permission-mode when a mode is provided', () => {
    expect(buildAgentCommandLine('claude', 'p', 'auto')).toBe(
      "claude --permission-mode auto 'p'",
    );
  });

  it('replaces an existing --permission-mode instead of duplicating it', () => {
    expect(
      buildAgentCommandLine('claude --permission-mode plan', 'p', 'auto'),
    ).toBe("claude --permission-mode auto 'p'");
  });

  it('does not append the prompt when appendPrompt is false', () => {
    expect(
      buildAgentCommandLine('claude -p already', 'p', undefined, false),
    ).toBe('claude -p already');
  });

  it('still injects the mode when appendPrompt is false', () => {
    expect(buildAgentCommandLine('claude -p already', 'p', 'plan', false)).toBe(
      'claude -p already --permission-mode plan',
    );
  });

  it('injects --model when a model is provided', () => {
    expect(
      buildAgentCommandLine('claude', 'hi', undefined, true, 'fable'),
    ).toBe("claude --model fable 'hi'");
  });

  it('omits --model when model is empty or undefined', () => {
    expect(buildAgentCommandLine('claude', 'hi', undefined, true, '')).toBe(
      "claude 'hi'",
    );
    expect(buildAgentCommandLine('claude', 'hi')).toBe("claude 'hi'");
  });

  it('de-duplicates an existing --model flag', () => {
    expect(
      buildAgentCommandLine(
        'claude --model opus',
        'hi',
        undefined,
        true,
        'fable',
      ),
    ).toBe("claude --model fable 'hi'");
  });

  it('injects --permission-mode and --model together', () => {
    expect(buildAgentCommandLine('claude', 'hi', 'auto', true, 'fable')).toBe(
      "claude --permission-mode auto --model fable 'hi'",
    );
  });
});

describe('buildOrcaCommands', () => {
  it('builds status, open, repo add, and terminal create argv', () => {
    const cmds = buildOrcaCommands({
      repoRoot: '/repo',
      worktreePath: '/repo-feat',
      commandLine: "claude 'go'",
      title: 'wt: agent',
    });
    expect(cmds.status).toEqual(['status', '--json']);
    expect(cmds.open).toEqual(['open', '--json']);
    expect(cmds.repoAdd).toEqual(['repo', 'add', '--path', '/repo', '--json']);
    expect(cmds.terminalCreate).toEqual([
      'terminal',
      'create',
      '--worktree',
      'path:/repo-feat',
      '--title',
      'wt: agent',
      '--command',
      "claude 'go'",
      '--json',
    ]);
  });

  it('omits --command when no commandLine is given (plain open)', () => {
    const cmds = buildOrcaCommands({
      repoRoot: '/repo',
      worktreePath: '/repo-feat',
    });
    expect(cmds.terminalCreate).toEqual([
      'terminal',
      'create',
      '--worktree',
      'path:/repo-feat',
      '--json',
    ]);
  });

  it('never adds --focus (that flag is broken on the installed Orca)', () => {
    const cmds = buildOrcaCommands({
      repoRoot: '/repo',
      worktreePath: '/repo-feat',
      commandLine: 'claude',
    });
    expect(cmds.terminalCreate).not.toContain('--focus');
  });
});

describe('buildSwitchCommand', () => {
  it('builds terminal switch argv for a handle', () => {
    expect(buildSwitchCommand('term_abc')).toEqual([
      'terminal',
      'switch',
      '--terminal',
      'term_abc',
      '--json',
    ]);
  });
});

describe('buildStopCommand', () => {
  it('addresses the worktree by absolute path', () => {
    expect(buildStopCommand('/repo-feat')).toEqual([
      'terminal',
      'stop',
      '--worktree',
      'path:/repo-feat',
      '--json',
    ]);
  });
});

describe('parseTerminalHandle', () => {
  it('extracts result.terminal.handle', () => {
    const stdout = JSON.stringify({
      ok: true,
      result: { terminal: { handle: 'term_xyz' } },
    });
    expect(parseTerminalHandle(stdout)).toBe('term_xyz');
  });

  it('returns null when the handle is missing or output is not JSON', () => {
    expect(parseTerminalHandle('{"ok":true}')).toBeNull();
    expect(parseTerminalHandle('not json')).toBeNull();
    expect(parseTerminalHandle('')).toBeNull();
  });
});

describe('isRuntimeReachable', () => {
  it('is true when runtime.reachable is true', () => {
    expect(
      isRuntimeReachable(
        JSON.stringify({ result: { runtime: { reachable: true } } }),
      ),
    ).toBe(true);
  });

  it('is false when runtime.reachable is false', () => {
    expect(
      isRuntimeReachable(
        JSON.stringify({ result: { runtime: { reachable: false } } }),
      ),
    ).toBe(false);
  });

  it('is false when the shape is unexpected or empty', () => {
    expect(isRuntimeReachable('{}')).toBe(false);
    expect(isRuntimeReachable('')).toBe(false);
  });

  it('fails closed on invalid JSON', () => {
    expect(isRuntimeReachable('not json')).toBe(false);
  });
});

describe('isOrcaSuccess', () => {
  it('is true on exit 0 with ok:true', () => {
    expect(isOrcaSuccess({ code: 0, stdout: '{"ok":true}', stderr: '' })).toBe(
      true,
    );
  });

  it('is false on exit 0 with ok:false', () => {
    expect(isOrcaSuccess({ code: 0, stdout: '{"ok":false}', stderr: '' })).toBe(
      false,
    );
  });

  it('is false on a non-zero exit even with ok:true', () => {
    expect(isOrcaSuccess({ code: 1, stdout: '{"ok":true}', stderr: '' })).toBe(
      false,
    );
  });

  it('falls back to the exit code when ok is missing or unparseable', () => {
    expect(isOrcaSuccess({ code: 0, stdout: '{}', stderr: '' })).toBe(true);
    expect(isOrcaSuccess({ code: 0, stdout: 'not json', stderr: '' })).toBe(
      true,
    );
    expect(isOrcaSuccess({ code: 0, stdout: '', stderr: '' })).toBe(true);
  });
});

describe('isSelectorNotFound', () => {
  it('is true when the JSON error code is selector_not_found', () => {
    expect(
      isSelectorNotFound({
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: 'selector_not_found' },
        }),
        stderr: '',
      }),
    ).toBe(true);
  });

  it('is false for a different error code, ok:false, or non-JSON', () => {
    expect(
      isSelectorNotFound({
        code: 1,
        stdout: JSON.stringify({ ok: false, error: { code: 'other' } }),
        stderr: '',
      }),
    ).toBe(false);
    expect(
      isSelectorNotFound({ code: 0, stdout: '{"ok":false}', stderr: '' }),
    ).toBe(false);
    expect(isSelectorNotFound({ code: 1, stdout: 'boom', stderr: '' })).toBe(
      false,
    );
  });
});

// Canned results keyed by the leading argv token. Each entry may be a single
// result (repeated) or an array (a queue consumed per call, repeating the last
// once drained) — the queue form drives the runtime-launch poll.
type ResultSpec = OrcaResult | OrcaResult[];

const OK: OrcaResult = { code: 0, stdout: '{"ok":true}', stderr: '' };
// A `terminal create` success that also carries a handle (for the focus path).
const TERM_OK: OrcaResult = {
  code: 0,
  stdout: JSON.stringify({
    ok: true,
    result: { terminal: { handle: 'term_x' } },
  }),
  stderr: '',
};
const REACHABLE: OrcaResult = {
  code: 0,
  stdout: JSON.stringify({ result: { runtime: { reachable: true } } }),
  stderr: '',
};
const DOWN: OrcaResult = {
  code: 0,
  stdout: JSON.stringify({ result: { runtime: { reachable: false } } }),
  stderr: '',
};
const ENOENT: OrcaResult = {
  code: null,
  stdout: '',
  stderr: 'spawn orca ENOENT',
};
// `terminal create` refusing the worktree selector (external-worktree
// visibility off) — the fixable, retryable failure.
const SELECTOR_NOT_FOUND: OrcaResult = {
  code: 1,
  stdout: JSON.stringify({
    ok: false,
    error: { code: 'selector_not_found' },
  }),
  stderr: '',
};

function toQueue(spec: ResultSpec): OrcaResult[] {
  return Array.isArray(spec) ? [...spec] : [spec];
}
function nextFrom(q: OrcaResult[]): OrcaResult {
  return q.length > 1 ? (q.shift() as OrcaResult) : q[0];
}

function makeRunner(spec: {
  status?: ResultSpec;
  open?: ResultSpec;
  repoAdd?: ResultSpec;
  terminalCreate?: ResultSpec;
  switch?: ResultSpec;
}): OrcaRunner & { calls: string[][] } {
  const queues = {
    status: toQueue(spec.status ?? REACHABLE),
    open: toQueue(spec.open ?? OK),
    repoAdd: toQueue(spec.repoAdd ?? OK),
    terminalCreate: toQueue(spec.terminalCreate ?? OK),
    switch: toQueue(spec.switch ?? OK),
  };
  const calls: string[][] = [];
  const fn = vi.fn(async (args: string[]) => {
    calls.push(args);
    const key =
      args[0] === 'status'
        ? 'status'
        : args[0] === 'open'
          ? 'open'
          : args[0] === 'repo'
            ? 'repoAdd'
            : args[0] === 'terminal' && args[1] === 'switch'
              ? 'switch'
              : 'terminalCreate';
    return nextFrom(queues[key]);
  });
  return Object.assign(fn, { calls }) as unknown as OrcaRunner & {
    calls: string[][];
  };
}

/** The subcommand kind of each recorded call (`terminal switch` vs `create`). */
function callKinds(calls: string[][]): string[] {
  return calls.map((c) =>
    c[0] === 'terminal' && c[1] === 'switch' ? 'switch' : c[0],
  );
}

const noSleep = async () => {};

describe('startAgentInOrca', () => {
  const base = {
    repoRoot: '/repo',
    worktreePath: '/repo-feat',
    commandLine: "claude 'go'",
    title: 'wt: agent',
    sleep: noSleep,
    report: () => {},
  };

  it('runs status -> repo add -> terminal create and returns true when the runtime is up', async () => {
    const runner = makeRunner({});
    const started = await startAgentInOrca({ ...base, runner });
    expect(started).toBe(true);
    expect(runner.calls.map((c) => c[0])).toEqual([
      'status',
      'repo',
      'terminal',
    ]);
  });

  it('treats exit 0 with ok:false on terminal create as NOT started', async () => {
    const runner = makeRunner({
      terminalCreate: { code: 0, stdout: '{"ok":false}', stderr: '' },
    });
    const started = await startAgentInOrca({ ...base, runner });
    expect(started).toBe(false);
  });

  it('retries terminal create after a selector_not_found once the user confirms', async () => {
    // First create fails (worktree invisible); after the user flips visibility
    // and confirms, the retry succeeds.
    const runner = makeRunner({ terminalCreate: [SELECTOR_NOT_FOUND, OK] });
    const lines: string[] = [];
    const confirmRetry = vi.fn(async () => true);
    const started = await startAgentInOrca({
      ...base,
      runner,
      confirmRetry,
      report: (m) => lines.push(m),
    });
    expect(started).toBe(true);
    // Two create attempts; the hint was shown; the user was asked once.
    expect(
      runner.calls.filter((c) => callKinds([c])[0] === 'terminal').length,
    ).toBe(2);
    expect(confirmRetry).toHaveBeenCalledTimes(1);
    expect(lines).toContain(SELECTOR_NOT_FOUND_HINT);
  });

  it('gives up (not started) on selector_not_found when the user declines the retry', async () => {
    const runner = makeRunner({ terminalCreate: SELECTOR_NOT_FOUND });
    const lines: string[] = [];
    const started = await startAgentInOrca({
      ...base,
      runner,
      confirmRetry: async () => false,
      report: (m) => lines.push(m),
    });
    expect(started).toBe(false);
    // Only one create attempt (no retry); the hint replaces the generic line.
    expect(
      runner.calls.filter((c) => callKinds([c])[0] === 'terminal').length,
    ).toBe(1);
    expect(lines).toContain(SELECTOR_NOT_FOUND_HINT);
    // Exactly one "…create failed" message (the hint) — no duplicate generic
    // failure line stacked on top of it.
    expect(
      lines.filter((l) => l.includes('orca terminal create failed')).length,
    ).toBe(1);
  });

  it('auto-launches Orca when the runtime is down, then proceeds once reachable', async () => {
    // First status = down; after `orca open`, the poll status = reachable.
    const runner = makeRunner({ status: [DOWN, REACHABLE] });
    const started = await startAgentInOrca({ ...base, runner });
    expect(started).toBe(true);
    expect(runner.calls.map((c) => c[0])).toEqual([
      'status',
      'open',
      'status',
      'repo',
      'terminal',
    ]);
  });

  it('errors (not started) when the runtime never comes up after launch', async () => {
    const runner = makeRunner({ status: DOWN }); // always down
    const lines: string[] = [];
    const started = await startAgentInOrca({
      ...base,
      runner,
      report: (m) => lines.push(m),
    });
    expect(started).toBe(false);
    // launched Orca, polled, gave up — never reached repo add / terminal create.
    expect(runner.calls.map((c) => c[0])).toContain('open');
    expect(runner.calls.map((c) => c[0])).not.toContain('repo');
    expect(lines.join('\n')).toMatch(/did not become ready/i);
  });

  it('does not sleep after the final failed poll (gives up immediately)', async () => {
    const runner = makeRunner({ status: DOWN }); // always down
    const sleep = vi.fn(async () => {});
    await startAgentInOrca({ ...base, runner, sleep, report: () => {} });
    // 1 initial probe + 6 polls; the last poll is not followed by a sleep.
    const probes = runner.calls.filter((c) => c[0] === 'status').length;
    expect(probes).toBe(7);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it('returns false when orca cannot be spawned (ENOENT on status)', async () => {
    const runner = makeRunner({ status: ENOENT });
    const started = await startAgentInOrca({ ...base, runner });
    expect(started).toBe(false);
    expect(runner.calls.map((c) => c[0])).toEqual(['status']);
  });

  it('returns false when orca open itself cannot be spawned (ENOENT)', async () => {
    const runner = makeRunner({ status: DOWN, open: ENOENT });
    const started = await startAgentInOrca({ ...base, runner });
    expect(started).toBe(false);
    expect(runner.calls.map((c) => c[0])).toEqual(['status', 'open']);
  });

  it('returns false when repo add fails (terminal never created)', async () => {
    const runner = makeRunner({
      repoAdd: { code: 1, stdout: '', stderr: 'boom' },
    });
    const started = await startAgentInOrca({ ...base, runner });
    expect(started).toBe(false);
    expect(runner.calls.map((c) => c[0])).toEqual(['status', 'repo']);
  });

  it('reveals the tab via `terminal switch` when focus is set (interactive)', async () => {
    const runner = makeRunner({ terminalCreate: TERM_OK });
    const started = await startAgentInOrca({ ...base, runner, focus: true });
    expect(started).toBe(true);
    expect(callKinds(runner.calls)).toEqual([
      'status',
      'repo',
      'terminal',
      'switch',
    ]);
    const switchCall = runner.calls.find(
      (c) => c[0] === 'terminal' && c[1] === 'switch',
    );
    expect(switchCall).toEqual(buildSwitchCommand('term_x'));
  });

  it('does not switch by default (daemon dispatch)', async () => {
    const runner = makeRunner({ terminalCreate: TERM_OK });
    await startAgentInOrca({ ...base, runner });
    expect(callKinds(runner.calls)).not.toContain('switch');
  });

  it('still counts as started when focus is set but the switch fails (cosmetic)', async () => {
    const runner = makeRunner({
      terminalCreate: TERM_OK,
      switch: { code: 1, stdout: '', stderr: 'nope' },
    });
    const started = await startAgentInOrca({ ...base, runner, focus: true });
    expect(started).toBe(true);
  });

  it('skips the switch when focus is set but the create output has no handle', async () => {
    const runner = makeRunner({ terminalCreate: OK }); // OK has no handle
    const started = await startAgentInOrca({ ...base, runner, focus: true });
    expect(started).toBe(true);
    expect(callKinds(runner.calls)).not.toContain('switch');
  });
});

describe('openWorktreeInOrca', () => {
  it('opens a plain terminal (no --command) and returns true on success', async () => {
    const runner = makeRunner({});
    const opened = await openWorktreeInOrca({
      repoRoot: '/repo',
      worktreePath: '/repo-feat',
      runner,
      sleep: noSleep,
      report: () => {},
    });
    expect(opened).toBe(true);
    const terminalCall = runner.calls.find((c) => c[0] === 'terminal');
    expect(terminalCall).not.toContain('--command');
  });

  it('auto-launches Orca when down, then opens once reachable', async () => {
    const runner = makeRunner({ status: [DOWN, REACHABLE] });
    const opened = await openWorktreeInOrca({
      repoRoot: '/repo',
      worktreePath: '/repo-feat',
      runner,
      sleep: noSleep,
      report: () => {},
    });
    expect(opened).toBe(true);
    expect(runner.calls.map((c) => c[0])).toContain('open');
  });

  it('reveals the tab via `terminal switch` when focus is set', async () => {
    const runner = makeRunner({ terminalCreate: TERM_OK });
    await openWorktreeInOrca({
      repoRoot: '/repo',
      worktreePath: '/repo-feat',
      focus: true,
      runner,
      sleep: noSleep,
      report: () => {},
    });
    expect(callKinds(runner.calls)).toContain('switch');
  });
});

describe('stopOrcaWorktree', () => {
  /** Runner that answers `status` from `status` and everything else from `rest`. */
  function stopRunner(status: OrcaResult, rest: OrcaResult = OK) {
    const calls: string[][] = [];
    const fn = vi.fn(async (args: string[]) => {
      calls.push(args);
      return args[0] === 'status' ? status : rest;
    });
    return Object.assign(fn, { calls }) as unknown as OrcaRunner & {
      calls: string[][];
    };
  }

  it('issues exactly `terminal stop --worktree path:<abs> --json` when the runtime is up', async () => {
    const runner = stopRunner(REACHABLE);
    await stopOrcaWorktree({ worktreePath: '/repo-feat', runner });
    expect(runner.calls).toEqual([
      ['status', '--json'],
      buildStopCommand('/repo-feat'),
    ]);
  });

  it('probes with the same status argv the launch path builds', async () => {
    const runner = stopRunner(REACHABLE);
    await stopOrcaWorktree({ worktreePath: '/repo-feat', runner });
    expect(runner.calls[0]).toEqual(
      buildOrcaCommands({ repoRoot: '/repo', worktreePath: '/repo-feat' })
        .status,
    );
  });

  it('returns quietly without stopping or launching Orca when the runtime is down', async () => {
    const runner = stopRunner(DOWN);
    await stopOrcaWorktree({ worktreePath: '/repo-feat', runner });
    // Only the probe: a teardown must never boot Orca.
    expect(runner.calls).toEqual([['status', '--json']]);
    expect(callKinds(runner.calls)).not.toContain('open');
  });

  it('is a quiet no-op for a worktree Orca never saw (selector_not_found, exit 0)', async () => {
    const selectorNotFound: OrcaResult = {
      code: 0,
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'selector_not_found' },
      }),
      stderr: '',
    };
    const runner = stopRunner(REACHABLE, selectorNotFound);
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m) => {
      lines.push(String(m));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m) => {
      lines.push(String(m));
    });
    await expect(
      stopOrcaWorktree({ worktreePath: '/repo-feat', runner }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([]);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('is quiet on a non-zero exit', async () => {
    const runner = stopRunner(REACHABLE, {
      code: 1,
      stdout: '',
      stderr: 'boom',
    });
    await expect(
      stopOrcaWorktree({ worktreePath: '/repo-feat', runner }),
    ).resolves.toBeUndefined();
  });

  it('is quiet and never throws when orca is not installed (ENOENT)', async () => {
    const runner = stopRunner(ENOENT);
    await expect(
      stopOrcaWorktree({ worktreePath: '/repo-feat', runner }),
    ).resolves.toBeUndefined();
    expect(runner.calls).toEqual([['status', '--json']]);
  });

  // `defaultRunner` bounds each `orca` call with its own timer: on expiry it
  // SIGKILLs the child's process group and resolves straight from the timer
  // (never awaiting `close`) with a null code and whatever output had arrived.
  // Both call sites must read that null code as "give up quietly", so a wedged
  // runtime can't hang a deletion — including when the killed call had already
  // printed a complete, healthy-looking payload.
  const KILLED: OrcaResult = { code: null, stdout: '', stderr: '' };

  it('gives up quietly when the status probe times out and is killed', async () => {
    const runner = stopRunner(KILLED);
    await expect(
      stopOrcaWorktree({ worktreePath: '/repo-feat', runner }),
    ).resolves.toBeUndefined();
    // Killed probe ⇒ runtime treated as unavailable, no stop attempted.
    expect(runner.calls).toEqual([['status', '--json']]);
  });

  it('gives up quietly when the stop itself times out and is killed', async () => {
    const runner = stopRunner(REACHABLE, KILLED);
    await expect(
      stopOrcaWorktree({ worktreePath: '/repo-feat', runner }),
    ).resolves.toBeUndefined();
    expect(runner.calls).toEqual([
      ['status', '--json'],
      buildStopCommand('/repo-feat'),
    ]);
  });

  // Pins `statusReachable`'s `code === 0` guard: the payload alone says the
  // runtime is reachable, so only the null (killed) exit code can reject it.
  it('treats a killed probe that already printed reachable JSON as unreachable', async () => {
    const runner = stopRunner({
      code: null,
      stdout: JSON.stringify({ result: { runtime: { reachable: true } } }),
      stderr: '',
    });
    await stopOrcaWorktree({ worktreePath: '/repo-feat', runner });
    expect(runner.calls).toEqual([['status', '--json']]);
  });

  it('never throws when the runner itself rejects', async () => {
    const runner = vi.fn(async () => {
      throw new Error('spawn failed');
    }) as unknown as OrcaRunner;
    await expect(
      stopOrcaWorktree({ worktreePath: '/repo-feat', runner }),
    ).resolves.toBeUndefined();
  });
});

// Exercises `defaultRunner` itself through the two public entry points that
// don't take an injected runner: `stopOrcaWorktree` (bounded, STOP_TIMEOUT_MS)
// and `openWorktreeInOrca` (unbounded launch path). Only child_process.spawn is
// mocked.
describe('defaultRunner (via the no-injected-runner call sites)', () => {
  const PID = 4242;
  /**
   * A ChildProcess stand-in: destroyable stdout/stderr, a pid, and unref().
   * `pid` has no default — passing `undefined` must really mean "no pid".
   */
  const makeChild = (pid: number | undefined) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      pid: number | undefined;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    child.pid = pid;
    child.unref = vi.fn();
    return child;
  };
  /** A child that never emits `close` — the wedged runtime the timer exists for. */
  const returnWedged = (child: ReturnType<typeof makeChild>) => {
    vi.mocked(spawn).mockImplementation(
      (() => child) as unknown as typeof spawn,
    );
  };

  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    killSpy.mockRestore();
    vi.mocked(spawn).mockReset();
  });

  it('kills the whole process group and resolves at the bound when the child wedges', async () => {
    vi.useFakeTimers();
    const child = makeChild(PID);
    returnWedged(child);

    const promise = stopOrcaWorktree({ worktreePath: '/repo-feat' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBeUndefined();
    // Negative pid ⇒ the group, not just the bash wrapper.
    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL');
    // The killed probe reads as code:null ⇒ unreachable ⇒ no `terminal stop`.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'orca',
      ['status', '--json'],
      expect.objectContaining({ detached: true }),
    );
  });

  it('releases the inherited pipes and unrefs the child on expiry', async () => {
    vi.useFakeTimers();
    const child = makeChild(PID);
    returnWedged(child);

    const promise = stopOrcaWorktree({ worktreePath: '/repo-feat' });
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    // Without this, a descendant that escaped the group keeps these handles —
    // and the event loop — alive long past the bound.
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
  });

  it('does not throw or kill when the child has no pid (spawn failed)', async () => {
    vi.useFakeTimers();
    const child = makeChild(undefined);
    returnWedged(child);

    const promise = stopOrcaWorktree({ worktreePath: '/repo-feat' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('clears the timer on the normal close path (no dangling handle)', async () => {
    vi.useFakeTimers();
    const child = makeChild(PID);
    vi.mocked(spawn).mockImplementation((() => {
      // The runtime answers "down", so the probe is the only call.
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(DOWN.stdout));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn);

    await stopOrcaWorktree({ worktreePath: '/repo-feat' });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // The happy path must not touch the pipes or unref.
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('leaves the unbounded launch path undetached and untimed', async () => {
    vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
      const child = makeChild(PID);
      const stdout =
        args[0] === 'status'
          ? JSON.stringify({
              ok: true,
              result: { runtime: { reachable: true } },
            })
          : '{"ok":true}';
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn);

    const opened = await openWorktreeInOrca({
      repoRoot: '/repo',
      worktreePath: '/repo-feat',
      sleep: noSleep,
      report: () => {},
    });

    expect(opened).toBe(true);
    // `orca open` legitimately takes a while, so the launch path is unbounded —
    // and an unbounded child must not be detached (nothing would ever kill it).
    for (const call of vi.mocked(spawn).mock.calls) {
      expect(call[2]).toMatchObject({ detached: false });
    }
    expect(killSpy).not.toHaveBeenCalled();
  });
});
