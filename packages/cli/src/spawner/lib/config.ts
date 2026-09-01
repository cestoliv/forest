import os from 'node:os';
import path from 'node:path';
import Conf from 'conf';
import envPaths from 'env-paths';

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

/** The two thresholds that differ between the day and the night regime. */
export interface UsageRegime {
  /**
   * Percentage of the weekly limit to reserve per day left before the reset,
   * for your own interactive work. Times the days remaining, this is the
   * decreasing reserve the daemon refuses to spend.
   */
  dailyReservePercent: number;
  /** Utilization of the 5h window above which the daemon stops dispatching. */
  sessionMaxPercent: number;
}

export interface NightRegime extends UsageRegime {
  /** Local `[start, end)` hours. An end at or before the start wraps midnight. */
  hours: [number, number];
  /**
   * Local hour the 5h window must be free by. A night agent that would still
   * own the window at that hour is held, so it cannot eat the window you wake
   * up into.
   */
  morningGuardHour: number;
}

export interface UsageConfig extends UsageRegime {
  enabled: boolean;
  /** Hours before the weekly reset where the reserve and the 5h ceiling drop. */
  preResetHours: number;
  /** Worktrees allowed over both caps during the pre-reset window. */
  preResetBonusWorktrees: number;
  /** Overrides for the night hours, or null for one regime all day. */
  night: NightRegime | null;
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
  /** The usage gate: how much of the weekly limit the daemon may spend. */
  usage: UsageConfig;
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
  usage: {
    enabled: true,
    // 13% of a weekly limit is one heavy interactive day, measured on a Max
    // plan. Raise it if the daemon leaves you short mid-week.
    dailyReservePercent: 13,
    sessionMaxPercent: 50,
    preResetHours: 8,
    preResetBonusWorktrees: 2,
    night: {
      hours: [2, 6],
      dailyReservePercent: 4,
      sessionMaxPercent: 90,
      morningGuardHour: 8,
    },
  },
  rules: [],
};

const DEFAULT_CONFIG_DIR = envPaths('agent-spawner').config;

export function getConfigFilePath(cwd?: string): string {
  const dir = cwd ?? DEFAULT_CONFIG_DIR;
  return path.join(dir, 'config.json');
}

export function createStore(cwd?: string): Conf<AgentSpawnerConfig> {
  try {
    return new Conf<AgentSpawnerConfig>({
      projectName: 'agent-spawner',
      defaults: DEFAULT_CONFIG,
      ...(cwd ? { cwd } : {}),
    });
  } catch (error) {
    const configPath = getConfigFilePath(cwd);
    throw new Error(
      `Error reading config file: ${configPath}\n${error instanceof Error ? error.message : error}`,
    );
  }
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
    usage: readUsage(raw.usage),
    rules,
  };
}

/**
 * Fill in every missing usage field from the defaults. Conf merges its defaults
 * per top-level key, so a config that sets only `usage.enabled` would otherwise
 * arrive with the rest undefined.
 */
function readUsage(raw: Partial<UsageConfig> | undefined): UsageConfig {
  const defaults = DEFAULT_CONFIG.usage;
  const settings = { ...defaults, ...(raw ?? {}) };
  if (typeof settings.enabled !== 'boolean') {
    throw new Error(
      `Invalid usage.enabled: must be true or false (got ${settings.enabled}).`,
    );
  }
  return {
    enabled: settings.enabled,
    dailyReservePercent: readPercent(
      settings.dailyReservePercent,
      'usage.dailyReservePercent',
    ),
    sessionMaxPercent: readPercent(
      settings.sessionMaxPercent,
      'usage.sessionMaxPercent',
    ),
    preResetHours: readHours(settings.preResetHours, 'usage.preResetHours'),
    preResetBonusWorktrees: readCap(
      settings.preResetBonusWorktrees,
      'usage.preResetBonusWorktrees',
    ),
    night: readNight(settings.night),
  };
}

function readNight(raw: NightRegime | null | undefined): NightRegime | null {
  if (raw === null) return null;
  const night = {
    ...DEFAULT_CONFIG.usage.night,
    ...(raw ?? {}),
  } as NightRegime;
  const hours = night.hours;
  if (
    !Array.isArray(hours) ||
    hours.length !== 2 ||
    hours.some((hour) => !isHour(hour))
  ) {
    throw new Error(
      `Invalid usage.night.hours: must be two local hours between 0 and 24 (got ${JSON.stringify(hours)}).`,
    );
  }
  return {
    hours: [hours[0], hours[1]],
    dailyReservePercent: readPercent(
      night.dailyReservePercent,
      'usage.night.dailyReservePercent',
    ),
    sessionMaxPercent: readPercent(
      night.sessionMaxPercent,
      'usage.night.sessionMaxPercent',
    ),
    morningGuardHour: isHour(night.morningGuardHour)
      ? night.morningGuardHour
      : throwHour('usage.night.morningGuardHour', night.morningGuardHour),
  };
}

function isHour(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 24
  );
}

function throwHour(key: string, value: unknown): never {
  throw new Error(
    `Invalid ${key}: must be a local hour between 0 and 24 (got ${value}).`,
  );
}

function readPercent(value: unknown, key: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new Error(
      `Invalid ${key}: must be a percentage between 0 and 100 (got ${value}).`,
    );
  }
  return value;
}

function readHours(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid ${key}: must be a non-negative number of hours (got ${value}).`,
    );
  }
  return value;
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
