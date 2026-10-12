import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findWorktreeProcesses,
  killProcesses,
  parseWorktreeProcesses,
} from './processes.js';

describe('parseWorktreeProcesses', () => {
  const ps = [
    '    1     0 /sbin/launchd',
    '  100     1 -zsh',
    '  200   100 node /dev/wt/dist/wt.js prune',
    '  300     1 node /dev/repo-a/storybook/node_modules/.bin/storybook dev',
    '  301   300 /dev/repo-a/node_modules/@esbuild/bin/esbuild --service',
    '  400     1 node /dev/repo-ab/server.js',
    '  500   200 sh -c cleanup /dev/repo-a/x',
    '  600     1 node /Volumes/bak/dev/repo-a/server.js',
    '  700     1 node --root=/dev/repo-a/apps',
  ].join('\n');

  it('matches processes running code from the worktree, at a path boundary', () => {
    expect(
      parseWorktreeProcesses(ps, '/dev/repo-a', 200).map((p) => p.pid),
    ).toEqual([300, 301, 500, 700]);
  });

  it('never returns its own ancestors', () => {
    expect(
      parseWorktreeProcesses(ps, '/dev/repo-a', 301).map((p) => p.pid),
    ).toEqual([500, 700]);
  });
});

describe('findWorktreeProcesses + killProcesses', () => {
  it('finds and kills a process running a script from the worktree', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wt-proc-')));
    const script = path.join(dir, 'serve.sh');
    writeFileSync(script, 'sleep 30\n');
    const child = spawn('sh', [script], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const found = findWorktreeProcesses(dir).map((p) => p.pid);
      expect(found).toContain(child.pid);
      expect(await killProcesses(found)).toEqual([]);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
