import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listWorktreeBranches } from './capacity.js';
import { type AgentSpawnerConfig, DEFAULT_CONFIG } from './config.js';
import { dispatchTask, type SpawnAgent } from './dispatch.js';
import { isDue } from './due.js';
import type { TodoistApi } from './todoist.js';

export interface TickDeps {
  api: TodoistApi;
  config: AgentSpawnerConfig;
  spawnAgent: SpawnAgent;
  log: (msg: string) => void;
  /** Injected worktree reader for tests; production omits it. */
  listWorktreeBranches?: (repoPath: string) => string[];
}

export async function runTick(deps: TickDeps): Promise<void> {
  const { api, config, spawnAgent, log } = deps;
  const labels = await api.listLabels();
  const idToName = new Map(labels.map((l) => [l.id, l.name]));
  const nameToId = new Map(labels.map((l) => [l.name, l.id]));

  const readyName = idToName.get(config.labels.ready);
  const workingName = idToName.get(config.labels.working);
  const errorName = idToName.get(config.labels.error);
  if (!readyName || !workingName || !errorName) {
    throw new Error('Configured label ids were not found in Todoist labels.');
  }

  const unclaimed = (await api.listTasksByLabel(readyName)).filter(
    (t) => !t.labels.includes(workingName) && !t.labels.includes(errorName),
  );

  const now = new Date();
  const candidates = unclaimed
    .filter((t) => isDue(t, now))
    .sort((a, b) => a.added_at.localeCompare(b.added_at));

  const deferred = unclaimed.length - candidates.length;
  if (candidates.length === 0) {
    // Name the deferred tasks here rather than claiming there are none, so a
    // quiet tick explains itself in `agent-spawner logs`.
    log(
      deferred > 0
        ? `No Agent Ready tasks are due yet (${deferred} scheduled for later).`
        : 'No Agent Ready tasks to dispatch.',
    );
    return;
  }
  if (deferred > 0) {
    log(`Skipping ${deferred} task(s) scheduled for later.`);
  }

  // Read each repo's worktrees at most once per tick. Walking the candidates
  // would otherwise respawn `git worktree list` for every task against every
  // rule path, on every tick, for as long as a cap holds. One snapshot also
  // keeps a tick's decisions consistent with each other.
  // ponytail: the snapshot goes stale within the tick. Since a tick dispatches
  // at most once, only a `wt create` racing this walk can push a repo one over
  // its cap, and the next tick sees the true count. Re-read per task if a cap
  // ever has to hold exactly.
  const read = deps.listWorktreeBranches ?? listWorktreeBranches;
  const seen = new Map<string, string[]>();
  const readOnce = (repoPath: string): string[] => {
    const cached = seen.get(repoPath);
    if (cached !== undefined) return cached;
    const branches = read(repoPath);
    seen.set(repoPath, branches);
    return branches;
  };

  // Walk the candidates oldest first and stop at the first one that is not
  // held by a worktree cap, so a full repo cannot starve a task routed at a
  // repo that still has room. Still at most one dispatch per tick.
  for (const task of candidates) {
    const outcome = await dispatchTask(task, {
      api,
      config,
      idToName,
      nameToId,
      spawnAgent,
      log,
      listWorktreeBranches: readOnce,
    });
    if (outcome !== 'at-capacity') return;
  }

  log(`Every due task (${candidates.length}) targets a repo at its cap.`);
}

export function defaultLockPath(): string {
  return path.join(os.tmpdir(), 'agent-spawner.lock');
}

export function acquireLock(lockPath: string): boolean {
  if (existsSync(lockPath)) {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && isAlive(pid)) return false;
  }
  writeFileSync(lockPath, String(process.pid), 'utf8');
  return true;
}

export function releaseLock(lockPath: string): void {
  if (existsSync(lockPath)) rmSync(lockPath);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface LoopDeps {
  loadConfig: () => AgentSpawnerConfig;
  makeApi: (config: AgentSpawnerConfig) => TodoistApi;
  spawnAgent: SpawnAgent;
  log: (msg: string) => void;
}

/**
 * Run the poll loop until aborted. Config is reloaded and the API client
 * rebuilt at the START of every tick, so edits to the config file (rules,
 * labels, token, prompt, interval) take effect on the next tick without a
 * restart. A reload that throws (e.g. a malformed edit) is caught and logged;
 * the loop keeps running on the last known-good interval until the config is
 * valid again. The interval for the next tick is taken from the freshly
 * loaded config.
 */
export async function runLoop(
  deps: LoopDeps,
  opts: { lockPath?: string; signal?: AbortSignal },
): Promise<void> {
  const lockPath = opts.lockPath ?? defaultLockPath();
  if (!acquireLock(lockPath)) {
    throw new Error('agent-spawner is already running (lock held).');
  }

  let nextIntervalMs = DEFAULT_CONFIG.pollIntervalSeconds * 1000;

  const tick = async (): Promise<void> => {
    try {
      const config = deps.loadConfig();
      nextIntervalMs = config.pollIntervalSeconds * 1000;
      const api = deps.makeApi(config);
      await runTick({
        api,
        config,
        spawnAgent: deps.spawnAgent,
        log: deps.log,
      });
    } catch (err) {
      deps.log(`Tick error: ${(err as Error).message}`);
    }
  };

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      releaseLock(lockPath);
      resolve();
    };

    const loop = async (): Promise<void> => {
      await tick();
      if (stopped) return;
      timer = setTimeout(loop, nextIntervalMs);
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        stop();
        return;
      }
      opts.signal.addEventListener('abort', stop, { once: true });
    }

    void loop();
  });
}
