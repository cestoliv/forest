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
  /**
   * Cap on the worktrees of every repo the `rules` point at, counted together.
   * 0 means unlimited.
   */
  maxWorktrees: number;
  /**
   * Cap on one repo's worktrees, keyed by the same path a `RouteRule` uses
   * (`~` is expanded). An absent entry, or 0, means unlimited.
   */
  maxWorktreesPerRepo: Record<string, number>;
  rules: RouteRule[];
}

export const DEFAULT_CONFIG: AgentSpawnerConfig = {
  token: '',
  pollIntervalSeconds: 600,
  branchPrefix: 'agent/',
  promptTemplate: "Let's tackle this task {{url}}",
  labels: { ready: '', working: '', error: '' },
  maxWorktrees: 0,
  maxWorktreesPerRepo: {},
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

  // Reject a value that is not a path-to-cap map. `Object.entries` reads a
  // number as empty, so `"maxWorktreesPerRepo": 4` (a slip for `maxWorktrees`)
  // would otherwise leave every per-repo cap quietly off.
  const rawPerRepo = raw.maxWorktreesPerRepo ?? {};
  if (typeof rawPerRepo !== 'object' || Array.isArray(rawPerRepo)) {
    throw new Error(
      'Invalid maxWorktreesPerRepo: must be an object mapping a repo path to a cap.',
    );
  }

  // Expand the per-repo keys the same way rule paths are expanded, so
  // `~/dev/repo` in the map still matches the repo a rule routes to.
  const maxWorktreesPerRepo = Object.fromEntries(
    Object.entries(rawPerRepo).map(([repo, cap]) => [
      expandHome(repo),
      readCap(cap, `maxWorktreesPerRepo["${repo}"]`),
    ]),
  );

  // The cap is looked up by exact path, so a key that matches no rule would do
  // nothing at all. Say so instead: a silent no-op cap is worse than a
  // startup error, and a trailing slash or a typo is easy to make.
  const rulePaths = new Set(rules.map((rule) => rule.path));
  for (const repo of Object.keys(maxWorktreesPerRepo)) {
    if (!rulePaths.has(repo)) {
      throw new Error(
        `Invalid maxWorktreesPerRepo["${repo}"]: matches no rules[].path.`,
      );
    }
  }

  return {
    token,
    pollIntervalSeconds,
    branchPrefix: raw.branchPrefix ?? DEFAULT_CONFIG.branchPrefix,
    promptTemplate: raw.promptTemplate ?? DEFAULT_CONFIG.promptTemplate,
    labels: raw.labels,
    maxWorktrees: readCap(raw.maxWorktrees, 'maxWorktrees'),
    maxWorktreesPerRepo,
    rules,
  };
}

function readCap(value: number | undefined, key: string): number {
  const cap = value ?? 0;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) {
    throw new Error(
      `Invalid ${key}: must be a non-negative integer (got ${cap}).`,
    );
  }
  return cap;
}
