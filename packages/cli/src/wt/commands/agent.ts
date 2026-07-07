// src/commands/agent.ts
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import type { RepoConfig } from '../lib/config.js';
import {
  AGENT_TASK_LABEL,
  buildAgentTask,
  cleanupAgentTask,
  ensureKeymap,
  isHeadlessSession,
  openAccessibilitySettings,
  type TriggerResult,
  triggerChord,
  writeAgentTask,
} from '../lib/zed.js';
import {
  type CreateOptions,
  openConfiguredIde,
  prepareWorktree,
  promptExistingWorktree,
} from './create.js';

/** Valid Claude Code permission modes */
export const VALID_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

type AgentMode = (typeof VALID_MODES)[number];

/**
 * Delay after the chord fires before removing the ephemeral .zed task. Kept
 * generous so a slow machine or cold Zed start has read and spawned the task
 * before the file is deleted.
 */
const CLEANUP_DELAY_MS = 20000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a worktree and auto-start the configured AI agent in Zed. If the
 * worktree already exists, prompt the user to open it, open-and-start the agent,
 * or quit. The agent start itself lives in `startAgentInWorktree`. macOS/Zed-specific.
 */
export async function createAgentWorktree(
  branch: string | undefined,
  planPrompt: string,
  options: CreateOptions = {},
): Promise<void> {
  // Validate and normalize the mode
  const mode = options.mode ?? 'plan';
  if (!VALID_MODES.includes(mode as AgentMode)) {
    console.error(
      pc.red(`Invalid mode "${mode}". Valid modes: ${VALID_MODES.join(', ')}`),
    );
    process.exit(1);
  }

  const prepared = await prepareWorktree(branch, options);
  if (!prepared) return;

  const { status, config, worktreePath } = prepared;

  if (status === 'exists') {
    const prompt = options.existingWorktreePrompt ?? promptExistingWorktree;
    const action = await prompt(worktreePath, { allowAgent: true });
    if (action === 'quit') return;
    if (action === 'open') {
      await openConfiguredIde(config, worktreePath);
      return;
    }
    // 'agent' falls through to start the agent in the existing worktree.
  }

  await startAgentInWorktree(config, worktreePath, planPrompt, mode);
}

/**
 * Open the worktree in Zed and auto-start the configured AI agent: write a
 * `.zed/tasks.json` running the agent, ensure the global trigger chord exists,
 * open Zed, press the chord, then remove the ephemeral task to leave the repo
 * clean. Reused for freshly-created and pre-existing worktrees. macOS/Zed-only.
 */
async function startAgentInWorktree(
  config: RepoConfig,
  worktreePath: string,
  planPrompt: string,
  mode: string,
): Promise<void> {
  // The automation drives Zed specifically; fall back to the plain create
  // behaviour (open the worktree, no agent) otherwise.
  if (config.ide !== 'zed') {
    console.warn(
      pc.yellow(
        `⚠ Agent auto-start requires Zed (ide is "${config.ide}"). Opening without starting the agent.`,
      ),
    );
    await openConfiguredIde(config, worktreePath);
    return;
  }

  if (!config.agent_command) {
    console.error(
      pc.red('No agent_command configured. Set it with `wt config`.'),
    );
    // The worktree is already created; still open it so the user can work in it.
    await openConfiguredIde(config, worktreePath);
    return;
  }

  const task = buildAgentTask(
    config.agent_command,
    planPrompt,
    AGENT_TASK_LABEL,
    mode,
  );
  const created = writeAgentTask(worktreePath, task);
  const keymapOk = ensureKeymap(config.agent_trigger_chord, AGENT_TASK_LABEL);

  const opened = await openConfiguredIde(config, worktreePath);
  if (!opened) {
    console.error(pc.red('✗ Could not open Zed.'));
    cleanupAgentTask(worktreePath, AGENT_TASK_LABEL, created);
    return;
  }

  // Without the keybinding the chord does nothing, so pressing it would falsely
  // look successful. ensureKeymap already printed how to add it manually; keep
  // the task file so the chord works once the user does.
  if (!keymapOk) {
    console.warn(
      pc.yellow(
        '⚠ Could not install the Zed keybinding (see above). In Zed, press ' +
          `${config.agent_trigger_chord} to start the agent manually.`,
      ),
    );
    return;
  }

  console.log(pc.dim('Starting agent in Zed…'));
  let result = await triggerChord(config.agent_trigger_chord);

  // Missing Accessibility is the common first-run blocker and is fixable: guide
  // the user to grant it, then retry (Zed is already open, so skip the load
  // delay). Loop until it works or the user declines.
  while (
    !result.ok &&
    result.reason === 'accessibility' &&
    process.stdin.isTTY
  ) {
    console.warn(
      pc.yellow(
        '⚠ macOS Accessibility permission is required to send the keystroke ' +
          'that starts the agent.',
      ),
    );
    openAccessibilitySettings();
    // Over SSH the keystroke is sent by Terminal (the Launch Services helper),
    // so that is the app that needs Accessibility — not Zed.
    const grantee = isHeadlessSession()
      ? 'Terminal'
      : 'the app running wt (e.g. Zed)';
    const proceed = await clack.confirm({
      message:
        `Grant Accessibility to ${grantee} in the panel ` +
        'that opened, then confirm to retry. (If that app was already running, ' +
        'you may need to quit and reopen it for the grant to take effect.)',
    });
    if (clack.isCancel(proceed) || !proceed) break;
    result = await triggerChord(config.agent_trigger_chord, {
      loadDelay: 0,
      activateDelay: 0.5,
    });
  }

  if (!result.ok) {
    // Keep .zed/tasks.json so the chord can still be pressed manually.
    reportTriggerFailure(result, config.agent_trigger_chord);
    return;
  }

  console.log(pc.green('✓ Agent started'));
  // The command is already running in the terminal; the task file is safe to
  // remove once Zed has read it.
  await delay(CLEANUP_DELAY_MS);
  cleanupAgentTask(worktreePath, AGENT_TASK_LABEL, created);
}

function reportTriggerFailure(
  result: Extract<TriggerResult, { ok: false }>,
  chord: string,
): void {
  if (result.reason === 'unsupported') {
    console.warn(
      pc.yellow(
        '⚠ Agent auto-start is only supported on macOS. The worktree and Zed ' +
          `are open; press ${chord} in Zed to start the agent.`,
      ),
    );
    return;
  }
  if (result.reason === 'accessibility') {
    console.warn(
      pc.yellow(
        '⚠ Agent not started (Accessibility not granted). In Zed, press ' +
          `${chord} to start it manually.`,
      ),
    );
    return;
  }
  console.warn(
    pc.yellow(
      `⚠ Could not auto-start the agent${result.message ? `: ${result.message}` : ''}. ` +
        `In Zed, press ${chord} to start it manually. (Over SSH, this needs the ` +
        `same user logged into the Mac's graphical session.)`,
    ),
  );
}
