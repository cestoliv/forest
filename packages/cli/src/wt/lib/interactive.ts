// src/lib/interactive.ts

/**
 * Whether a human is available to answer a prompt. `process.stdin.isTTY` alone
 * is not enough: `agent-spawner run` is usually started from a shell, so the
 * daemon inherits a real TTY and a clack prompt renders to a terminal nobody is
 * watching. The daemon calls `setInteractive(false)` once, in `runAgent`, so
 * every prompt in the `wt` flow takes its non-interactive branch instead of
 * hanging.
 */

// module-global on purpose. A process is either the `wt` CLI or the
// daemon, never both. Thread a boolean through instead if that ever changes —
// createAgentWorktree → startAgentInWorktree → startAgentInOrcaWorktree →
// startAgentInOrca({ confirmRetry }).
let allowed = true;

export function setInteractive(value: boolean): void {
  allowed = value;
}

export function isInteractive(): boolean {
  return allowed && Boolean(process.stdin.isTTY);
}
