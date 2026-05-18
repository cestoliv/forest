// src/lib/ide.ts
import { spawn } from 'node:child_process';

export function buildIdeCommand(
  ide: string,
  ideOpenArgs: string[],
  worktreePath: string,
): { cmd: string; args: string[] } {
  return { cmd: ide, args: [...ideOpenArgs, worktreePath] };
}

export function openIde(
  ide: string,
  ideOpenArgs: string[],
  worktreePath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ide) {
      resolve(false);
      return;
    }
    const { cmd, args } = buildIdeCommand(ide, ideOpenArgs, worktreePath);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.on('error', (err) => {
      process.stderr.write(
        `\nWarning: could not open "${ide}": ${err.message}\n`,
      );
      resolve(false);
    });
  });
}
