import { createAgentWorktree } from './commands/agent.js';
import type { ConfigStore } from './lib/config.js';

export type Reporter = (msg: string) => void;
export interface AgentResult {
  ok: boolean;
  output: string;
}
export interface RunAgentOptions {
  repoPath: string;
  branch: string;
  prompt: string;
  mode?: string;
  /** Injected config store for tests; production omits it and uses the global store. */
  store?: ConfigStore;
}

/**
 * Library-safe entry to the `wt agent` flow: resolves the repo from `repoPath`
 * (no interactive picker), runs the worktree + agent automation, and returns a
 * structured result with all progress/error lines collected in `output`.
 * Never calls process.exit; a throw becomes `{ ok: false }`.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const lines: string[] = [];
  const report: Reporter = (m) => lines.push(m);
  try {
    await createAgentWorktree(opts.branch, opts.prompt, {
      cwd: opts.repoPath,
      mode: opts.mode ?? 'plan',
      report,
      store: opts.store,
    });
    return { ok: true, output: lines.join('\n') };
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
    return { ok: false, output: lines.join('\n') };
  }
}
