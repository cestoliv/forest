// src/lib/registry.ts
import { type ConfigStore, createStore, getGlobalConfig } from './config.js';

export function registerRepo(
  repoPath: string,
  store: ConfigStore = createStore(),
): void {
  const { repos } = getGlobalConfig(store);
  if (!repos.includes(repoPath)) {
    store.set('repos', [...repos, repoPath]);
  }
}

export function getRegisteredRepos(
  store: ConfigStore = createStore(),
): string[] {
  return getGlobalConfig(store).repos;
}
