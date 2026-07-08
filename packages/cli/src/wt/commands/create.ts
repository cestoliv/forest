// src/commands/create.ts
import { existsSync } from 'node:fs';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
  type RepoConfig,
} from '../lib/config.js';
import {
  addWorktree,
  branchExists,
  fetchRemote,
  getRepoRoot,
  listWorktrees,
  resolveWorktreePath,
  setUpstreamTracking,
} from '../lib/git.js';
import { openIde } from '../lib/ide.js';
import { getRegisteredRepos, registerRepo } from '../lib/registry.js';
import { runCommands } from '../lib/setup.js';
import { runBranchInput, runRepoPicker } from '../lib/tui.js';

export type ExistingWorktreeAction = 'open' | 'agent' | 'quit';

export interface CreateOptions {
  cwd?: string;
  store?: ConfigStore;
  repoPicker?: (repos: string[]) => Promise<string | null>;
  branchInput?: (repoRoot: string) => Promise<string | null>;
  existingWorktreePrompt?: (
    worktreePath: string,
    opts: { allowAgent: boolean },
  ) => Promise<ExistingWorktreeAction>;
  mode?: string;
  /** Sink for human-readable progress/error lines. Defaults to console. */
  report?: (msg: string) => void;
}

export interface PreparedWorktree {
  /** Whether the worktree was just created or already existed on disk. */
  status: 'created' | 'exists';
  repoRoot: string;
  worktreePath: string;
  config: RepoConfig;
}

/**
 * Resolve the repo + branch and ensure a worktree is available for it. Shared
 * by `wt create` and `wt agent`. When the path is free it creates the worktree,
 * runs `setup_commands`, and returns `status: 'created'`; when the path is
 * already a worktree it returns early with `status: 'exists'` (no fetch/create)
 * so the caller can prompt. Returns `null` if the user cancelled out of a
 * prompt, and hard-exits if the path exists but is not a worktree.
 */
export async function prepareWorktree(
  branch: string | undefined,
  options: CreateOptions = {},
): Promise<PreparedWorktree | null> {
  const {
    cwd = process.cwd(),
    store = createStore(),
    repoPicker = runRepoPicker,
    branchInput = runBranchInput,
  } = options;

  let repoRoot: string | undefined;

  try {
    repoRoot = getRepoRoot(cwd);
  } catch {
    const repos = getRegisteredRepos(store);
    if (repos.length === 0) {
      console.error(
        pc.red(
          'No repos registered. cd into a repo and run wt create to get started.',
        ),
      );
      return null;
    }

    // Guard against non-TTY contexts (e.g., pipes, non-interactive shells)
    if (!process.stdin.isTTY) {
      throw new Error(
        'Interactive repo picker requires a TTY. Please run this command in an interactive terminal.',
      );
    }

    const picked = await repoPicker(repos);
    if (!picked) return null;
    repoRoot = picked;
    if (!branch) {
      const entered = await branchInput(repoRoot);
      if (!entered) return null;
      branch = entered;
    }
  }

  if (!repoRoot) return null;

  if (!branch) {
    const input = await clack.text({
      message: 'Branch name:',
      validate: (v) => (!v || v.length === 0 ? 'Required' : undefined),
    });
    if (clack.isCancel(input)) return null;
    branch = input as string;
  }

  registerRepo(repoRoot, store);

  const config = getEffectiveConfig(repoRoot, store);

  const worktreePath = resolveWorktreePath(
    repoRoot,
    config.worktree_path,
    branch,
  );

  // Detect an existing worktree before doing any network work: the caller
  // prompts the user instead of erroring out. A path that exists but isn't a
  // registered worktree (e.g. a leftover dir from a half-failed create, or an
  // unrelated directory matching the naming convention) is not safe to open or
  // run an agent in, so error out instead of pretending it's a worktree.
  if (existsSync(worktreePath)) {
    const isWorktree = listWorktrees(repoRoot).some(
      (wt) => wt.path === worktreePath,
    );
    if (!isWorktree) {
      throw new Error(
        `Path already exists but is not a git worktree: ${worktreePath}`,
      );
    }
    return { status: 'exists', repoRoot, worktreePath, config };
  }

  const parts = config.base_branch.split('/', 2);
  const remote = parts[0] || 'origin';

  if (parts.length === 2) {
    try {
      fetchRemote(repoRoot, remote);
    } catch (err) {
      console.warn(
        pc.yellow(
          `⚠ Could not fetch from ${remote} — using local state${err instanceof Error ? ` (${err.message})` : ''}`,
        ),
      );
    }
  }

  const exists = branchExists(repoRoot, branch);
  if (exists) {
    addWorktree(repoRoot, worktreePath, branch);
  } else {
    addWorktree(repoRoot, worktreePath, branch, config.base_branch);
  }

  setUpstreamTracking(worktreePath, branch, remote);

  console.log(pc.green(`✓ Created worktree at ${worktreePath}`));

  if (config.setup_commands.length > 0) {
    console.log(pc.dim('Running setup commands...'));
    const result = await runCommands(config.setup_commands, worktreePath);
    if (!result.success) {
      throw new Error(
        `Setup failed: ${result.failedCommand} (exit code ${result.exitCode})\nWorktree left at ${worktreePath} for inspection`,
      );
    }
  }

  return { status: 'created', repoRoot, worktreePath, config };
}

/**
 * Prompt the user about a worktree that already exists. `wt create` offers
 * open-or-quit; `wt agent` additionally offers starting the agent. In
 * non-interactive contexts, throws a clear error so scripts still fail.
 */
export async function promptExistingWorktree(
  worktreePath: string,
  opts: { allowAgent: boolean },
): Promise<ExistingWorktreeAction> {
  if (!process.stdin.isTTY) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  const choice = await clack.select({
    message: `Worktree already exists at ${worktreePath}.`,
    options: [
      { value: 'open' as const, label: 'Open in IDE' },
      ...(opts.allowAgent
        ? [{ value: 'agent' as const, label: 'Open and start agent' }]
        : []),
      { value: 'quit' as const, label: 'Ignore and quit' },
    ],
  });

  if (clack.isCancel(choice)) return 'quit';
  return choice;
}

/**
 * Open the worktree in the configured IDE (if any) and report it. This is the
 * tail of the create flow; `wt agent` reuses it both for Zed and as the
 * non-AI fallback, so the open-and-report behaviour lives in one place.
 */
export async function openConfiguredIde(
  config: RepoConfig,
  worktreePath: string,
): Promise<boolean> {
  if (!config.ide) return false;
  const opened = await openIde(config.ide, config.ide_open_args, worktreePath);
  if (opened) {
    console.log(pc.green(`✓ Opened ${config.ide}`));
  }
  return opened;
}

export async function createWorktree(
  branch: string | undefined,
  options: CreateOptions = {},
): Promise<void> {
  const prepared = await prepareWorktree(branch, options);
  if (!prepared) return;

  const { status, config, worktreePath } = prepared;

  if (status === 'exists') {
    const prompt = options.existingWorktreePrompt ?? promptExistingWorktree;
    const action = await prompt(worktreePath, { allowAgent: false });
    // Only 'open' proceeds to open the existing worktree. 'quit' (and 'agent',
    // which is never offered here since allowAgent is false) stop instead.
    if (action !== 'open') return;
  }

  await openConfiguredIde(config, worktreePath);
}
