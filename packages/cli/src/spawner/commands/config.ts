import { spawn } from 'node:child_process';
import { createStore } from '../lib/config.js';

export function printConfigPath(): void {
  console.log(createStore().path);
}

export function openConfig(): void {
  const configPath = createStore().path;
  console.log(`Config: ${configPath}`);
  const editor = process.env.EDITOR ?? 'nano';
  const child = spawn(editor, [configPath], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`Failed to open editor: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code) => process.exit(code ?? 0));
}
