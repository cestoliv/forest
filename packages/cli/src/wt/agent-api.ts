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
  /** IDE to launch (e.g. `zed`, `orca`); overrides the configured `ide`. */
  ide?: string;
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
    const outcome = await createAgentWorktree(opts.branch, opts.prompt, {
      // Pass repoRoot (not cwd): upstream's "always global" change made the repo
      // picker always run unless repoRoot is set, and the daemon has no TTY.
      repoRoot: opts.repoPath,
      // Undefined mode lets createAgentWorktree resolve config.agent_mode ?? 'default'.
      mode: opts.mode,
      // Undefined ide lets createAgentWorktree fall back to config.ide.
      ide: opts.ide,
      report,
      store: opts.store,
    });
    // `ok` reflects whether the agent actually started (the chord fired). A
    // worktree that was created but where the agent never launched (non-Zed IDE,
    // missing Accessibility, no keybinding, etc.) is NOT a success — the daemon
    // must label it "Agent Error", not "Agent Working".
    return { ok: outcome.started, output: lines.join('\n') };
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
    return { ok: false, output: lines.join('\n') };
  }
}
