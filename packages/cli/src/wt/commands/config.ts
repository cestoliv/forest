// src/commands/config.ts
import type { ChildProcess } from 'node:child_process';
import { openConfigFile } from '../../config-file.js';
import { getConfigFilePath } from '../lib/config.js';

export function printConfigPath(cwd?: string): void {
  const configPath = getConfigFilePath(cwd);
  console.log(configPath);
}

export function openConfig(cwd?: string): ChildProcess {
  return openConfigFile(getConfigFilePath(cwd), 'wt');
}
