// src/lib/config.ts
import path from 'node:path';
import Conf from 'conf';
import envPaths from 'env-paths';

export interface RepoConfig {
  worktree_path: string;
  base_branch: string;
  setup_commands: string[];
  teardown_commands: string[];
  ide: string;
  ide_open_args: string[];
  agent_command: string;
  agent_trigger_chord: string;
  auto_refresh_minutes: number;
  agent_mode: string;
}

export interface WtConfig extends RepoConfig {
  repos: string[];
  repo_overrides: Record<string, Partial<RepoConfig>>;
}

export const DEFAULT_CONFIG: WtConfig = {
  worktree_path: '../',
  base_branch: 'origin/main',
  setup_commands: [],
  teardown_commands: [],
  ide: 'zed',
  ide_open_args: ['-n'],
  agent_command: 'claude',
  agent_trigger_chord: 'ctrl-shift-cmd-c',
  auto_refresh_minutes: 5,
  agent_mode: 'default',
  repos: [],
  repo_overrides: {},
};

export type ConfigStore = Conf<WtConfig>;

const DEFAULT_CONFIG_DIR = envPaths('wt').config;

export function getConfigFilePath(cwd?: string): string {
  const dir = cwd ?? DEFAULT_CONFIG_DIR;
  return path.join(dir, 'config.json');
}

export function createStore(cwd?: string): ConfigStore {
  try {
    return new Conf<WtConfig>({
      projectName: 'wt',
      defaults: DEFAULT_CONFIG,
      ...(cwd ? { cwd } : {}),
    });
  } catch (error) {
    const configPath = getConfigFilePath(cwd);
    console.error(
      `Error reading config file: ${configPath}\n${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

export function getGlobalConfig(store: ConfigStore = createStore()): WtConfig {
  return store.store;
}

export function setGlobalConfig(
  updates: Partial<WtConfig>,
  store: ConfigStore = createStore(),
): void {
  const { repo_overrides, ...rest } = updates;

  // Apply non-override fields directly
  for (const key of Object.keys(rest) as Array<keyof typeof rest>) {
    store.set(key, rest[key]);
  }

  // Deep-merge repo_overrides at both levels (repo path AND per-field within a repo)
  if (repo_overrides) {
    const existing = store.get('repo_overrides') as Record<
      string,
      Partial<RepoConfig>
    >;
    const merged: Record<string, Partial<RepoConfig>> = { ...existing };
    for (const [repoPath, overrideUpdate] of Object.entries(repo_overrides)) {
      merged[repoPath] = { ...existing[repoPath], ...overrideUpdate };
    }
    store.set('repo_overrides', merged);
  }
}

export function getEffectiveConfig(
  repoPath: string,
  store: ConfigStore = createStore(),
): RepoConfig {
  const {
    repos: _repos,
    repo_overrides,
    ...repoFields
  } = getGlobalConfig(store);
  const override = repo_overrides[repoPath] ?? {};
  return { ...repoFields, ...override };
}
