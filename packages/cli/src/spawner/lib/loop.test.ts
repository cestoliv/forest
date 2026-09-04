import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_LABELS, makeTask } from '../test-utils.js';
import { type AgentSpawnerConfig, DEFAULT_CONFIG } from './config.js';
import {
  acquireLock,
  type LoopDeps,
  releaseLock,
  runLoop,
  runTick,
  type TickDeps,
} from './loop.js';
import type { TodoistApi, TodoistTask } from './todoist.js';
import type { UsageSnapshot } from './usage.js';

const config: AgentSpawnerConfig = {
  token: 't',
  pollIntervalSeconds: 600,
  maxWorktrees: 0,
  maxWorktreesPerRepo: {},
  // The usage gate is off, so these cases make no network call.
  usage: { ...DEFAULT_CONFIG.usage, enabled: false },
  branchPrefix: 'agent/',
  promptTemplate: "Let's tackle this task {{url}}",
  labels: { ready: '2183654821', working: '900001', error: '900002' },
  rules: [{ project: 'OVL', path: '/repos/ovl' }],
};

function api(tasks: TodoistTask[]): TodoistApi & {
  updated: { id: string; labels: string[] }[];
} {
  const updated: { id: string; labels: string[] }[] = [];
  return {
    updated,
    listLabels: async () => FIXTURE_LABELS,
    listTasksByLabel: async (name) =>
      tasks.filter((t) => t.labels.includes(name)),
    updateTaskLabels: async (id, labels) => {
      updated.push({ id, labels });
    },
    addComment: async () => {},
  };
}

describe('runTick', () => {
  it('dispatches exactly one task (oldest first) per tick', async () => {
    const tasks = [
      makeTask({
        id: 'new',
        project_id: 'OVL',
        added_at: '2025-02-01T00:00:00Z',
      }),
      makeTask({
        id: 'old',
        project_id: 'OVL',
        added_at: '2025-01-01T00:00:00Z',
      }),
    ];
    const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
    const deps: TickDeps = {
      api: api(tasks),
      config,
      spawnAgent,
      log: () => {},
    };
    await runTick(deps);
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect((spawnAgent.mock.calls[0] as unknown as string[])[0]).toContain(
      '-old',
    );
  });

  it('skips tasks already Working or Error', async () => {
    const tasks = [
      makeTask({
        id: 'w',
        project_id: 'OVL',
        labels: ['Agent Ready', 'Agent Working'],
      }),
      makeTask({
        id: 'e',
        project_id: 'OVL',
        labels: ['Agent Ready', 'Agent Error'],
      }),
    ];
    const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
    const deps: TickDeps = {
      api: api(tasks),
      config,
      spawnAgent,
      log: () => {},
    };
    await runTick(deps);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it('no candidates: does nothing', async () => {
    const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
    const deps: TickDeps = { api: api([]), config, spawnAgent, log: () => {} };
    await runTick(deps);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  describe('due date gating', () => {
    it('skips a task due later, even when it is the oldest', async () => {
      const tasks = [
        makeTask({
          id: 'later',
          project_id: 'OVL',
          added_at: '2025-01-01T00:00:00Z',
          due: { date: '2099-01-01' },
        }),
        makeTask({
          id: 'now',
          project_id: 'OVL',
          added_at: '2025-02-01T00:00:00Z',
        }),
      ];
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const deps: TickDeps = {
        api: api(tasks),
        config,
        spawnAgent,
        log: () => {},
      };
      await runTick(deps);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect((spawnAgent.mock.calls[0] as unknown as string[])[0]).toContain(
        '-now',
      );
    });

    it('dispatches a task whose due date already passed', async () => {
      const tasks = [
        makeTask({
          id: 'past',
          project_id: 'OVL',
          due: { date: '2020-01-01' },
        }),
      ];
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const deps: TickDeps = {
        api: api(tasks),
        config,
        spawnAgent,
        log: () => {},
      };
      await runTick(deps);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
    });

    it('says nothing is due yet when every candidate is due later', async () => {
      const tasks = [
        makeTask({ id: 'a', project_id: 'OVL', due: { date: '2099-01-01' } }),
        makeTask({ id: 'b', project_id: 'OVL', due: { date: '2099-01-02' } }),
      ];
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const logged: string[] = [];
      const deps: TickDeps = {
        api: api(tasks),
        config,
        spawnAgent,
        log: (msg) => logged.push(msg),
      };
      await runTick(deps);
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(logged).toEqual([
        'No Agent Ready tasks are due yet (2 scheduled for later).',
      ]);
    });

    it('logs the deferred count when another task still dispatches', async () => {
      const tasks = [
        makeTask({
          id: 'later',
          project_id: 'OVL',
          due: { date: '2099-01-01' },
        }),
        makeTask({ id: 'now', project_id: 'OVL' }),
      ];
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const logged: string[] = [];
      const deps: TickDeps = {
        api: api(tasks),
        config,
        spawnAgent,
        log: (msg) => logged.push(msg),
      };
      await runTick(deps);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(logged).toContain('Skipping 1 task(s) scheduled for later.');
    });
  });

  describe('worktree caps', () => {
    const twoRepos: AgentSpawnerConfig = {
      ...config,
      rules: [
        { project: 'OVL', labels: ['2183895737'], path: '/repos/mobile' },
        { project: 'OVL', labels: ['2183895740'], path: '/repos/backend' },
      ],
    };

    it('dispatches a younger task when the oldest targets a full repo', async () => {
      const tasks = [
        makeTask({
          id: 'old',
          project_id: 'OVL',
          added_at: '2025-01-01T00:00:00Z',
          labels: ['Agent Ready', '📱 Overload Mobile'],
        }),
        makeTask({
          id: 'new',
          project_id: 'OVL',
          added_at: '2025-02-01T00:00:00Z',
          labels: ['Agent Ready', '💽 Overload Backend'],
        }),
      ];
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const deps: TickDeps = {
        api: api(tasks),
        config: { ...twoRepos, maxWorktreesPerRepo: { '/repos/mobile': 1 } },
        spawnAgent,
        log: () => {},
        listWorktreeBranches: (repoPath) =>
          repoPath === '/repos/mobile' ? ['agent/held'] : [],
      };
      await runTick(deps);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect((spawnAgent.mock.calls[0] as unknown as string[])[0]).toContain(
        '-new',
      );
    });

    it('holds every task, and its labels, when the global cap is reached', async () => {
      const tasks = [
        makeTask({
          id: 'a',
          project_id: 'OVL',
          labels: ['Agent Ready', '📱 Overload Mobile'],
        }),
        makeTask({
          id: 'b',
          project_id: 'OVL',
          labels: ['Agent Ready', '💽 Overload Backend'],
        }),
      ];
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const logged: string[] = [];
      const tickApi = api(tasks);
      const deps: TickDeps = {
        api: tickApi,
        config: { ...twoRepos, maxWorktrees: 2 },
        spawnAgent,
        log: (msg) => logged.push(msg),
        listWorktreeBranches: () => ['agent/held'],
      };
      await runTick(deps);
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(tickApi.updated).toEqual([]);
      expect(logged.at(-1)).toBe(
        'Every due task (2) targets a repo at its cap.',
      );
    });

    it('counts each repo once per tick, however many candidates it walks', async () => {
      const tasks = ['a', 'b', 'c'].map((id) =>
        makeTask({
          id,
          project_id: 'OVL',
          labels: ['Agent Ready', '📱 Overload Mobile'],
        }),
      );
      const listWorktreeBranches = vi.fn(() => ['agent/held']);
      const deps: TickDeps = {
        api: api(tasks),
        config: { ...twoRepos, maxWorktrees: 2 },
        spawnAgent: vi.fn(async () => ({ ok: true, output: '' })),
        log: () => {},
        listWorktreeBranches,
      };
      await runTick(deps);
      // Two rule paths, three held candidates: one read per path, not per task.
      expect(listWorktreeBranches.mock.calls.flat().sort()).toEqual([
        '/repos/backend',
        '/repos/mobile',
      ]);
    });
  });

  describe('usage gate', () => {
    // `night: null` keeps every case independent of the hour the suite runs at.
    const gated: AgentSpawnerConfig = {
      ...config,
      usage: { ...DEFAULT_CONFIG.usage, enabled: true, night: null },
    };

    /** A snapshot whose weekly window resets `hours` from now. */
    const usage = (
      weeklyPercent: number,
      hours: number,
    ): (() => Promise<UsageSnapshot>) => {
      return async () => ({
        weeklyPercent,
        weeklyResetsAt: Date.now() + hours * 3_600_000,
        sessionPercent: 0,
        sessionResetsAt: null,
      });
    };

    it('holds every task, and its labels, when the reserve leaves no room', async () => {
      const tasks = [makeTask({ id: 'a', project_id: 'OVL' })];
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const logged: string[] = [];
      const tickApi = api(tasks);
      await runTick({
        api: tickApi,
        config: gated,
        spawnAgent,
        log: (msg) => logged.push(msg),
        fetchUsage: usage(50, 96),
      });
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(tickApi.updated).toEqual([]);
      expect(logged.at(-1)).toMatch(/Holding every task: weekly reserve holds/);
    });

    it('dispatches when the reserve leaves room', async () => {
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      await runTick({
        api: api([makeTask({ id: 'a', project_id: 'OVL' })]),
        config: gated,
        spawnAgent,
        log: () => {},
        fetchUsage: usage(10, 96),
      });
      expect(spawnAgent).toHaveBeenCalledTimes(1);
    });

    it('dispatches when the usage cannot be measured', async () => {
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const logged: string[] = [];
      await runTick({
        api: api([makeTask({ id: 'a', project_id: 'OVL' })]),
        config: gated,
        spawnAgent,
        log: (msg) => logged.push(msg),
        fetchUsage: async () => null,
      });
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(logged).toContain('Usage unknown, dispatching anyway.');
    });

    it('asks nothing when the gate is off', async () => {
      const fetchUsage = vi.fn(async () => null);
      await runTick({
        api: api([makeTask({ id: 'a', project_id: 'OVL' })]),
        config,
        spawnAgent: vi.fn(async () => ({ ok: true, output: '' })),
        log: () => {},
        fetchUsage,
      });
      expect(fetchUsage).not.toHaveBeenCalled();
    });

    it('asks nothing when no task is due', async () => {
      const fetchUsage = vi.fn(async () => null);
      await runTick({
        api: api([
          makeTask({ id: 'a', project_id: 'OVL', due: { date: '2099-01-01' } }),
        ]),
        config: gated,
        spawnAgent: vi.fn(async () => ({ ok: true, output: '' })),
        log: () => {},
        fetchUsage,
      });
      expect(fetchUsage).not.toHaveBeenCalled();
    });

    it('spends the cap bonus before the reset', async () => {
      const capped: AgentSpawnerConfig = {
        ...gated,
        maxWorktrees: 1,
        maxWorktreesPerRepo: { '/repos/ovl': 1 },
      };
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const deps: TickDeps = {
        api: api([makeTask({ id: 'a', project_id: 'OVL' })]),
        config: capped,
        spawnAgent,
        log: () => {},
        listWorktreeBranches: () => ['agent/held'],
        // 4 hours to the reset, so the bonus applies: what the cap holds back
        // now is lost at the reset.
        fetchUsage: usage(60, 4),
      };
      await runTick(deps);
      expect(spawnAgent).toHaveBeenCalledTimes(1);

      // The same repo, same cap, a day earlier: the cap holds.
      const spawnLater = vi.fn(async () => ({ ok: true, output: '' }));
      await runTick({
        ...deps,
        api: api([makeTask({ id: 'a', project_id: 'OVL' })]),
        spawnAgent: spawnLater,
        fetchUsage: usage(10, 28),
      });
      expect(spawnLater).not.toHaveBeenCalled();
    });
  });
});

describe('runLoop', () => {
  function lockPath(): string {
    return path.join(
      os.tmpdir(),
      `as-loop-${Math.random().toString(36).slice(2)}`,
    );
  }

  it('reloads config and rebuilds the API on every tick', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let configCalls = 0;
      let apiCalls = 0;
      const fakeApi = api([
        makeTask({
          id: 'old',
          project_id: 'OVL',
          added_at: '2025-01-01T00:00:00Z',
        }),
      ]);
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const deps: LoopDeps = {
        loadConfig: () => {
          configCalls++;
          return config;
        },
        makeApi: () => {
          apiCalls++;
          return fakeApi;
        },
        spawnAgent,
        log: () => {},
      };
      const done = runLoop(deps, {
        signal: controller.signal,
        lockPath: lockPath(),
      });

      await vi.advanceTimersByTimeAsync(0); // immediate first tick
      expect(configCalls).toBe(1);
      expect(apiCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(600_000); // second tick after interval
      expect(configCalls).toBe(2);
      expect(apiCalls).toBe(2);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and keeps looping when a config reload throws', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const logs: string[] = [];
      let calls = 0;
      const fakeApi = api([makeTask({ id: 'old', project_id: 'OVL' })]);
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const deps: LoopDeps = {
        loadConfig: () => {
          calls++;
          if (calls === 1) throw new Error('bad config edit');
          return config;
        },
        makeApi: () => fakeApi,
        spawnAgent,
        log: (m) => logs.push(m),
      };
      const done = runLoop(deps, {
        signal: controller.signal,
        lockPath: lockPath(),
      });

      await vi.advanceTimersByTimeAsync(0); // first tick: reload throws
      expect(logs.some((l) => l.includes('bad config edit'))).toBe(true);
      expect(spawnAgent).not.toHaveBeenCalled();

      // loop keeps the default interval after a throw; next tick recovers
      await vi.advanceTimersByTimeAsync(600_000);
      expect(spawnAgent).toHaveBeenCalledTimes(1);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and keeps looping when dispatch (runTick) throws', async () => {
    // Unlike a spawnAgent throw (already caught inside dispatchTask itself,
    // see dispatch.test.ts), this drives a throw from further up the call
    // chain that dispatchTask -> runTick never catches (e.g. a Todoist API
    // call rejecting) to prove the per-tick catch in runLoop (loop.ts
    // ~104-116), not dispatchTask's own catch, is what keeps the daemon
    // alive.
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const logs: string[] = [];
      let apiCalls = 0;
      const workingApi = api([makeTask({ id: 'old', project_id: 'OVL' })]);
      const throwingApi: TodoistApi = {
        ...workingApi,
        listTasksByLabel: async () => {
          throw new Error('todoist unavailable');
        },
      };
      const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
      const deps: LoopDeps = {
        loadConfig: () => config,
        makeApi: () => {
          apiCalls++;
          return apiCalls === 1 ? throwingApi : workingApi;
        },
        spawnAgent,
        log: (m) => logs.push(m),
      };
      const done = runLoop(deps, {
        signal: controller.signal,
        lockPath: lockPath(),
      });

      await vi.advanceTimersByTimeAsync(0); // first tick: runTick throws
      expect(logs.some((l) => l.includes('todoist unavailable'))).toBe(true);
      expect(spawnAgent).not.toHaveBeenCalled();

      // the loop is still alive: next tick uses a healthy api and dispatches.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(spawnAgent).toHaveBeenCalledTimes(1);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pidfile lock', () => {
  it('blocks a second holder while held, frees on release', () => {
    const lock = path.join(
      os.tmpdir(),
      `as-lock-${Math.random().toString(36).slice(2)}`,
    );
    expect(acquireLock(lock)).toBe(true);
    expect(acquireLock(lock)).toBe(false);
    releaseLock(lock);
    expect(acquireLock(lock)).toBe(true);
    releaseLock(lock);
  });
});
