import os from 'node:os';
import path from 'node:path';
import Conf from 'conf';

export interface RouteRule {
  project: string;
  labels?: string[];
  path: string;
  /**
   * IDE to launch the agent in for this route (e.g. `zed`, `orca`). When unset,
   * the dispatch falls back to `wt`'s configured `ide` default.
   */
  ide?: string;
}

export interface LabelConfig {
  ready: string;
  working: string;
  error: string;
}

export interface AgentSpawnerConfig {
  token: string;
  pollIntervalSeconds: number;
  branchPrefix: string;
  promptTemplate: string;
  labels: LabelConfig;
  rules: RouteRule[];
}

export const DEFAULT_CONFIG: AgentSpawnerConfig = {
  token: '',
  pollIntervalSeconds: 600,
  branchPrefix: 'agent/',
  promptTemplate: "Let's tackle this task {{url}}",
  labels: { ready: '', working: '', error: '' },
  rules: [],
};

export function createStore(cwd?: string): Conf<AgentSpawnerConfig> {
  return new Conf<AgentSpawnerConfig>({
    projectName: 'agent-spawner',
    defaults: DEFAULT_CONFIG,
    ...(cwd ? { cwd } : {}),
  });
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(
  store: Conf<AgentSpawnerConfig> = createStore(),
): AgentSpawnerConfig {
  const raw = store.store;
  const token =
    process.env.TODOIST_API_TOKEN?.trim() || raw.token?.trim() || '';
  if (!token) {
    throw new Error(
      'No Todoist token. Set TODOIST_API_TOKEN or "token" in the config file.',
    );
  }

  for (const key of ['ready', 'working', 'error'] as const) {
    if (!raw.labels?.[key]?.trim()) {
      throw new Error(`Missing labels.${key} id in config.`);
    }
  }

  const rules = (raw.rules ?? []).map((rule, i) => {
    if (!rule.project?.trim() || !rule.path?.trim()) {
      throw new Error(
        `Invalid rule at index ${i}: project and path are required.`,
      );
    }
    // Drop a blank `ide` so it falls back to wt's default (a falsy-but-defined
    // string would otherwise survive wt's `options.ide ?? config.ide`).
    const ide = rule.ide?.trim() ? rule.ide.trim() : undefined;
    return { ...rule, path: expandHome(rule.path), ide };
  });

  const pollIntervalSeconds =
    raw.pollIntervalSeconds ?? DEFAULT_CONFIG.pollIntervalSeconds;
  if (
    typeof pollIntervalSeconds !== 'number' ||
    !Number.isFinite(pollIntervalSeconds) ||
    pollIntervalSeconds <= 0
  ) {
    throw new Error(
      `Invalid pollIntervalSeconds: must be a positive number (got ${pollIntervalSeconds}).`,
    );
  }

  return {
    token,
    pollIntervalSeconds,
    branchPrefix: raw.branchPrefix ?? DEFAULT_CONFIG.branchPrefix,
    promptTemplate: raw.promptTemplate ?? DEFAULT_CONFIG.promptTemplate,
    labels: raw.labels,
    rules,
  };
}
