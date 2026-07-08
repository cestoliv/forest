import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function createLogger(filePath: string): (msg: string) => void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    try {
      appendFileSync(filePath, `${line}\n`);
    } catch {
      // logging must never crash the daemon
    }
  };
}
