import { spawn } from 'node:child_process';
import { logPath } from '../lib/launchd.js';

export function logsCommand(): void {
  const file = logPath();
  console.log(`Tailing ${file}`);
  const child = spawn('tail', ['-f', '-n', '100', file], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`Failed to tail logs: ${err.message}`);
    process.exit(1);
  });
}
