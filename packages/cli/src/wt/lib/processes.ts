import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export interface WorktreeProcess {
  pid: number;
  command: string;
}

/**
 * Pure: the processes in `ps -A -o pid=,ppid=,command=` output whose command
 * line runs code from `worktreePath` (a dev server, a watcher, esbuild). They
 * keep writing into the directory while `git worktree remove` deletes it, so
 * git fails with "Directory not empty" and leaves a half-deleted orphan.
 *
 * It matches the command line, not the cwd: a cwd alone does not block a
 * delete, and the cwd also matches idle shells and the shared browser daemon.
 * `selfPid` and its ancestors are excluded so `wt` never kills itself or the
 * shell it runs in.
 */
export function parseWorktreeProcesses(
  psOutput: string,
  worktreePath: string,
  selfPid: number,
): WorktreeProcess[] {
  const rows = psOutput
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));

  const parents = new Map(rows.map((r) => [r.pid, r.ppid]));
  const ancestors = new Set<number>();
  for (let pid: number | undefined = selfPid; pid && !ancestors.has(pid); ) {
    ancestors.add(pid);
    pid = parents.get(pid);
  }

  const escaped = worktreePath
    .replace(/\/+$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inWorktree = new RegExp(`(^|[\\s='"])${escaped}/`);
  return rows
    .filter((r) => !ancestors.has(r.pid) && inWorktree.test(r.command))
    .map(({ pid, command }) => ({ pid, command }));
}

/**
 * The processes running code from `worktreePath`, under its registered path or
 * its resolved one (a process may have started through a symlink). `[]` when
 * `ps` fails.
 */
export function findWorktreeProcesses(worktreePath: string): WorktreeProcess[] {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    });
    const paths = new Set([worktreePath, realpathSync(worktreePath)]);
    const found = new Map<number, WorktreeProcess>();
    for (const p of paths) {
      for (const proc of parseWorktreeProcesses(out, p, process.pid)) {
        found.set(proc.pid, proc);
      }
    }
    return [...found.values()];
  } catch {
    return [];
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * SIGTERM each pid, wait up to `graceMs` for them to exit, then SIGKILL the
 * survivors. Returns the pids still alive after that (e.g. EPERM on another
 * user's process).
 */
export async function killProcesses(
  pids: number[],
  graceMs = 2000,
): Promise<number[]> {
  const signal = (sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone, or not ours to kill
      }
    }
  };

  signal('SIGTERM');
  for (let waited = 0; waited < graceMs && pids.some(isAlive); waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pids.some(isAlive)) {
    signal('SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.filter(isAlive);
}
