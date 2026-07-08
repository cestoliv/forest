import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AgentSpawnerConfig, DEFAULT_CONFIG } from './config.js';
import { dispatchTask, type SpawnAgent } from './dispatch.js';
import type { TodoistApi, TodoistTask } from './todoist.js';

export interface TickDeps {
  api: TodoistApi;
  config: AgentSpawnerConfig;
  spawnAgent: SpawnAgent;
  log: (msg: string) => void;
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

  const candidates = (await api.listTasksByLabel(readyName))
    .filter(
      (t) => !t.labels.includes(workingName) && !t.labels.includes(errorName),
    )
    .sort((a, b) => a.added_at.localeCompare(b.added_at));

  const task: TodoistTask | undefined = candidates[0];
  if (!task) {
    log('No Agent Ready tasks to dispatch.');
    return;
  }

  await dispatchTask(task, {
    api,
    config,
    idToName,
    nameToId,
    spawnAgent,
    log,
  });
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
