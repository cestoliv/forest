// src/commands/agent.ts
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import type { RepoConfig } from '../lib/config.js';
import { isInteractive } from '../lib/interactive.js';
import { buildAgentCommandLine, startAgentInOrca } from '../lib/orca.js';
import {
  buildTemplateVars,
  expandTemplate,
  hasPromptPlaceholder,
} from '../lib/template.js';
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

const isValidMode = (mode: string): mode is AgentMode =>
  VALID_MODES.includes(mode as AgentMode);

/**
 * Delay after the chord fires before removing the ephemeral .zed task. Kept
 * generous so a slow machine or cold Zed start has read and spawned the task
 * before the file is deleted.
 */
const CLEANUP_DELAY_MS = 20000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Outcome of the agent flow. `started` is true only when the AI agent actually
 * launched (the Zed trigger chord fired). It is false for every path that
 * created/opened the worktree but never started the agent — non-Zed IDE,
 * missing `agent_command`, Zed/keymap/Accessibility/trigger failures, or the
 * user choosing "quit"/"open" on an existing worktree. The daemon
 * (`runAgent`) maps `started` onto its `{ ok }` so it never mislabels a
 * not-started task as "Agent Working".
 */
export interface AgentOutcome {
  started: boolean;
}

/**
 * Create a worktree and auto-start the configured AI agent in Zed. If the
 * worktree already exists, prompt the user to open it, open-and-start the agent,
 * or quit. The agent start itself lives in `startAgentInWorktree`. macOS/Zed-specific.
 *
 * Returns `{ started }` — true only when the agent actually launched. The
 * interactive CLI ignores this (the user sees the warnings directly); the
 * daemon relies on it to distinguish a real "Agent Working" from a not-started
 * worktree.
 */
export async function createAgentWorktree(
  branch: string | undefined,
  planPrompt: string,
  options: CreateOptions = {},
): Promise<AgentOutcome> {
  const report = options.report ?? ((m: string) => console.log(m));
  // Fail fast on an invalid explicit --mode (user input) before creating any
  // worktree, so a typo never leaves an orphan worktree behind. Throw rather
  // than process.exit so a library caller (the daemon) is not killed.
  if (options.mode !== undefined && !isValidMode(options.mode)) {
    throw new Error(
      `Invalid mode "${options.mode}". Valid modes: ${VALID_MODES.join(', ')}`,
    );
  }
  const prepared = await prepareWorktree(branch, options);
  if (!prepared) return { started: false };

  const { status, worktreePath, repoRoot, branch: resolvedBranch } = prepared;
  // Resolve the IDE: --ide flag → configured ide → default. Overriding it on a
  // copy keeps startAgentInWorktree/openConfiguredIde reading config.ide.
  const config: RepoConfig = {
    ...prepared.config,
    ide: options.ide ?? prepared.config.ide,
  };
  // Focus/reveal the launched target — set by the interactive CLI, off for the
  // daemon (runAgent) so batch dispatches don't keep stealing focus.
  const focus = options.focus ?? false;

  // Resolve the permission mode: --mode flag → configured agent_mode →
  // 'default'. --mode is already validated above; a misconfigured (invalid or
  // empty) agent_mode shouldn't orphan the freshly-created worktree or crash,
  // so warn and fall back to 'default' instead of exiting.
  let mode = options.mode ?? config.agent_mode ?? 'default';
  if (!isValidMode(mode)) {
    console.warn(
      pc.yellow(
        `⚠ Invalid agent_mode "${mode}" in config; using "default". ` +
          `Valid modes: ${VALID_MODES.join(', ')}`,
      ),
    );
    mode = 'default';
  }

  // Resolve the model: --model flag → configured agent_model → unset ('').
  // No validation (open string); empty means "don't inject --model".
  const model = options.model ?? config.agent_model ?? '';

  if (status === 'exists') {
    const prompt = options.existingWorktreePrompt ?? promptExistingWorktree;
    const action = await prompt(worktreePath, { allowAgent: true });
    if (action === 'quit') return { started: false };
    if (action === 'open') {
      await openConfiguredIde(config, worktreePath, report, repoRoot, focus);
      return { started: false };
    }
  }
  const started = await startAgentInWorktree(
    config,
    worktreePath,
    planPrompt,
    mode,
    model,
    resolvedBranch,
    repoRoot,
    report,
    focus,
  );
  return { started };
}

/**
 * Open the worktree in Zed and auto-start the configured AI agent: write a
 * `.zed/tasks.json` running the agent, ensure the global trigger chord exists,
 * open Zed, press the chord, then remove the ephemeral task to leave the repo
 * clean. Reused for freshly-created and pre-existing worktrees. macOS/Zed-only.
 *
 * Returns `true` only when the agent actually started (the chord fired). Every
 * not-started path (non-Zed IDE, missing `agent_command`, Zed-open/keymap/
 * Accessibility/trigger failure) returns `false` so the caller — and ultimately
 * the daemon — knows no agent is running, even though the worktree exists.
 */
async function startAgentInWorktree(
  config: RepoConfig,
  worktreePath: string,
  planPrompt: string,
  mode: string,
  model: string,
  branch: string,
  repoRoot: string,
  report: (msg: string) => void,
  focus: boolean,
): Promise<boolean> {
  // Orca uses its CLI (not the Zed task+keystroke automation): register the
  // repo and start the agent in a terminal attached to the worktree.
  if (config.ide === 'orca') {
    return startAgentInOrcaWorktree(
      config,
      worktreePath,
      planPrompt,
      mode,
      model,
      branch,
      repoRoot,
      report,
      focus,
    );
  }

  // The Zed automation drives Zed specifically; fall back to the plain create
  // behaviour (open the worktree, no agent) for any other IDE.
  if (config.ide !== 'zed') {
    report(
      pc.yellow(
        `⚠ Agent auto-start requires Zed or Orca (ide is "${config.ide}"). Opening without starting the agent.`,
      ),
    );
    await openConfiguredIde(config, worktreePath, report, repoRoot, focus);
    return false;
  }

  if (!config.agent_command) {
    report(pc.red('No agent_command configured. Set it with `wt config`.'));
    // The worktree is already created; still open it so the user can work in it.
    await openConfiguredIde(config, worktreePath, report, repoRoot, focus);
    return false;
  }

  // Expand `{{…}}` placeholders in the base command before Zed runs it. If the
  // raw command already contains `{{prompt}}`, the plan prompt is substituted in
  // place and buildAgentTask must NOT append it again (which would emit it
  // twice); otherwise buildAgentTask appends it single-quoted as usual.
  const appendPrompt = !hasPromptPlaceholder(config.agent_command);
  const command = expandTemplate(
    config.agent_command,
    buildTemplateVars({ branch, repoRoot, worktreePath, prompt: planPrompt }),
  );
  const task = buildAgentTask(
    command,
    planPrompt,
    AGENT_TASK_LABEL,
    mode,
    appendPrompt,
    model,
  );
  const created = writeAgentTask(worktreePath, task);
  const keymapOk = ensureKeymap(config.agent_trigger_chord, AGENT_TASK_LABEL);

  const opened = await openConfiguredIde(config, worktreePath, report);
  if (!opened) {
    report(pc.red('✗ Could not open Zed.'));
    cleanupAgentTask(worktreePath, AGENT_TASK_LABEL, created);
    return false;
  }

  // Without the keybinding the chord does nothing, so pressing it would falsely
  // look successful. ensureKeymap already printed how to add it manually; keep
  // the task file so the chord works once the user does.
  if (!keymapOk) {
    report(
      pc.yellow(
        '⚠ Could not install the Zed keybinding (see above). In Zed, press ' +
          `${config.agent_trigger_chord} to start the agent manually.`,
      ),
    );
    return false;
  }

  report(pc.dim('Starting agent in Zed…'));
  let result = await triggerChord(config.agent_trigger_chord);

  // Missing Accessibility is the common first-run blocker and is fixable: guide
  // the user to grant it, then retry (Zed is already open, so skip the load
  // delay). Loop until it works or the user declines.
  while (!result.ok && result.reason === 'accessibility' && isInteractive()) {
    report(
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
    reportTriggerFailure(result, config.agent_trigger_chord, report);
    return false;
  }

  report(pc.green('✓ Agent started'));
  // The command is already running in the terminal; the task file is safe to
  // remove once Zed has read it.
  await delay(CLEANUP_DELAY_MS);
  cleanupAgentTask(worktreePath, AGENT_TASK_LABEL, created);
  return true;
}

/**
 * Orca variant of the agent start: build the same agent command line the Zed
 * path builds (shared `buildAgentCommandLine`), then hand it to the Orca CLI via
 * `startAgentInOrca` (register repo + create a terminal in the worktree running
 * the command). Returns true only when the terminal actually launched. Falls
 * back to just opening the worktree in Orca when `agent_command` is unset.
 */
async function startAgentInOrcaWorktree(
  config: RepoConfig,
  worktreePath: string,
  planPrompt: string,
  mode: string,
  model: string,
  branch: string,
  repoRoot: string,
  report: (msg: string) => void,
  focus: boolean,
): Promise<boolean> {
  if (!config.agent_command) {
    report(pc.red('No agent_command configured. Set it with `wt config`.'));
    // The worktree is already created; still open it so the user can work in it.
    await openConfiguredIde(config, worktreePath, report, repoRoot, focus);
    return false;
  }

  // Same templating/prompt-placement rules as the Zed path (see above): if the
  // raw command carries `{{prompt}}`, substitute it inline and don't append.
  const appendPrompt = !hasPromptPlaceholder(config.agent_command);
  const command = expandTemplate(
    config.agent_command,
    buildTemplateVars({ branch, repoRoot, worktreePath, prompt: planPrompt }),
  );
  const commandLine = buildAgentCommandLine(
    command,
    planPrompt,
    mode,
    appendPrompt,
    model,
  );

  report(pc.dim('Starting agent in Orca…'));
  const started = await startAgentInOrca({
    repoRoot,
    worktreePath,
    commandLine,
    title: AGENT_TASK_LABEL,
    focus,
    report,
  });
  if (started) report(pc.green('✓ Agent started'));
  return started;
}

function reportTriggerFailure(
  result: Extract<TriggerResult, { ok: false }>,
  chord: string,
  report: (msg: string) => void,
): void {
  if (result.reason === 'unsupported') {
    report(
      pc.yellow(
        '⚠ Agent auto-start is only supported on macOS. The worktree and Zed ' +
          `are open; press ${chord} in Zed to start the agent.`,
      ),
    );
    return;
  }
  if (result.reason === 'accessibility') {
    report(
      pc.yellow(
        '⚠ Agent not started (Accessibility not granted). In Zed, press ' +
          `${chord} to start it manually.`,
      ),
    );
    return;
  }
  report(
    pc.yellow(
      `⚠ Could not auto-start the agent${result.message ? `: ${result.message}` : ''}. ` +
        `In Zed, press ${chord} to start it manually. (Over SSH, this needs the ` +
        `same user logged into the Mac's graphical session.)`,
    ),
  );
}
