import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { openConfigFile } from '../../config-file.js';
import { createStore, getConfigFilePath } from '../lib/config.js';

export function printConfigPath(cwd?: string): void {
  console.log(getConfigFilePath(cwd));
}

export function openConfig(cwd?: string): ChildProcess {
  const configPath = getConfigFilePath(cwd);
  // A missing file cannot be corrupt, so no parse can run here.
  if (!existsSync(configPath)) {
    try {
      createStore(cwd);
    } catch {
      // Seeding is a convenience. An unwritable config dir must not stop the
      // editor from opening — that is the crash this command exists to escape.
    }
  }
  return openConfigFile(configPath, 'agent-spawner');
}
