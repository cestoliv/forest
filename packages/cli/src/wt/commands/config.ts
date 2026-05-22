// src/commands/config.ts
import { spawn } from 'node:child_process';
import { type ConfigStore, createStore } from '../lib/config.js';

export function getConfigPath(store: ConfigStore = createStore()): string {
  return store.path;
}

export function printConfigPath(store: ConfigStore = createStore()): void {
  console.log(store.path);
}

export function openConfig(store: ConfigStore = createStore()): void {
  const configPath = store.path;
  console.log(`Config: ${configPath}`);
  const editor = process.env.EDITOR ?? 'nano';
  const child = spawn(editor, [configPath], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`Failed to open editor: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code) => process.exit(code ?? 0));
}
