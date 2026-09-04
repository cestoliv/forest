// Smoke test for the daemon's public wiring: `agent-spawner run`
// (src/spawner/commands/run.ts) must dispatch through `runWtAgent`
// (src/spawner/lib/dispatch.ts) — the in-process adapter that replaced the
// old `wt` subprocess call (see packages/cli/CLAUDE.md's "Dispatch is now
// in-process, not a subprocess on $PATH"). `loadConfig`, `createLogger`, and
// `runLoop` are mocked so this stays hermetic (no real Todoist token, no real
// log file under the user's home dir, no real poll loop/timers) while
// `dispatch.js` is left unmocked so `runWtAgent` here is the exact same
// function reference `run.ts` wires in.
import { describe, expect, it, vi } from 'vitest';
import type { AgentSpawnerConfig } from './config.js';
import { runWtAgent } from './dispatch.js';
import type { LoopDeps } from './loop.js';

const config: AgentSpawnerConfig = {
  token: 't',
  pollIntervalSeconds: 600,
  maxWorktrees: 0,
  maxWorktreesPerRepo: {},
  // `./config.js` is mocked below, so the defaults are spelled out here.
  usage: {
    enabled: false,
    dailyReservePercent: 13,
    sessionMaxPercent: 50,
    preResetHours: 8,
    preResetBonusWorktrees: 2,
    night: null,
  },
  branchPrefix: 'agent/',
  promptTemplate: "Let's tackle this task {{url}}",
  labels: { ready: '1', working: '2', error: '3' },
  rules: [],
};

vi.mock('./config.js', () => ({ loadConfig: vi.fn(() => config) }));
vi.mock('./log.js', () => ({ createLogger: vi.fn(() => vi.fn()) }));
vi.mock('./launchd.js', () => ({ logPath: vi.fn(() => '/tmp/unused.log') }));

let capturedDeps: LoopDeps | undefined;
vi.mock('./loop.js', () => ({
  runLoop: vi.fn(async (deps: LoopDeps) => {
    capturedDeps = deps;
  }),
}));

describe('smoke: agent-spawner run wiring', () => {
  it('wires spawnAgent to the real runWtAgent (in-process wt agent adapter)', async () => {
    const { runCommand } = await import('../commands/run.js');
    await runCommand();

    expect(capturedDeps?.spawnAgent).toBe(runWtAgent);
  });
});
