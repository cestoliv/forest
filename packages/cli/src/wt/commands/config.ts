// src/commands/config.ts
import { type ChildProcess, spawn } from 'node:child_process';
import { getConfigFilePath } from '../lib/config.js';

export function printConfigPath(cwd?: string): void {
  const configPath = getConfigFilePath(cwd);
  console.log(configPath);
}

export function openConfig(cwd?: string): ChildProcess {
  const configPath = getConfigFilePath(cwd);
  console.log(`Config: ${configPath}`);
  const editor = process.env.EDITOR ?? 'nano';
  const child = spawn(editor, [configPath], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`Failed to open editor: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code) => process.exit(code ?? 0));
  return child;
}
