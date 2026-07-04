// src/commands/create.ts
import { existsSync } from 'node:fs';
import path from 'node:path';
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
  remoteExists,
  resolveWorktreePath,
  setUpstreamTracking,
} from '../lib/git.js';
import { openIde } from '../lib/ide.js';
import { getRegisteredRepos, registerRepo } from '../lib/registry.js';
import { runCommands } from '../lib/setup.js';
import { buildTemplateVars, expandTemplate } from '../lib/template.js';
import { runBranchInput, runRepoPicker } from '../lib/tui.js';

export type ExistingWorktreeAction = 'open' | 'agent' | 'quit';

export interface CreateOptions {
  cwd?: string;
  /**
   * Pre-resolved target repo (e.g. from the TUI wizard's repo picker). When
   * set, `prepareWorktree` skips the picker; `cwd` is used only for discovery.
   */
  repoRoot?: string;
  store?: ConfigStore;
  repoPicker?: (repos: string[]) => Promise<string | null>;
  branchInput?: (repoRoot: string) => Promise<string | null>;
  existingWorktreePrompt?: (
    worktreePath: string,
    opts: { allowAgent: boolean },
  ) => Promise<ExistingWorktreeAction>;
  mode?: string;
}

export interface PreparedWorktree {
  /** Whether the worktree was just created or already existed on disk. */
  status: 'created' | 'exists';
  /** The resolved branch name (so callers can template-expand commands). */
  branch: string;
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

  // Auto-register the current repo for discovery (best-effort; a non-repo cwd
  // is silently ignored). This runs regardless of `--repo` so the current repo
  // stays discoverable next time — it never scopes/defaults the target repo.
  try {
    registerRepo(getRepoRoot(cwd), store);
  } catch {
    // not in a repo — nothing to auto-register
  }

  if (options.repoRoot) {
    // An explicit repo (CLI `--repo` or the TUI wizard's already-picked repo).
    // The CLI value is untrusted, so resolve it against cwd and confirm it is a
    // real git repo root before trusting it; re-resolving the wizard's
    // already-valid root is harmless. A bad path is a hard CLI-input error, so
    // exit(1) (like `--mode` validation) rather than falling through.
    const resolved = path.resolve(cwd, options.repoRoot);
    try {
      repoRoot = getRepoRoot(resolved);
    } catch {
      console.error(pc.red(`✗ ${options.repoRoot} is not a git repository`));
      process.exit(1);
    }
  } else {
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
      console.error(
        pc.red(
          'Interactive repo picker requires a TTY. Please run this command in an interactive terminal.',
        ),
      );
      process.exit(1);
    }

    const picked = await repoPicker(repos);
    if (!picked) return null;
    repoRoot = picked;
  }

  if (!branch) {
    const entered = await branchInput(repoRoot);
    if (!entered) return null;
    branch = entered;
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
      console.error(
        pc.red(
          `Path already exists but is not a git worktree: ${worktreePath}`,
        ),
      );
      process.exit(1);
    }
    return { status: 'exists', branch, repoRoot, worktreePath, config };
  }

  const parts = config.base_branch.split('/', 2);
  const remote = parts[0] || 'origin';

  if (parts.length === 2) {
    if (!remoteExists(repoRoot, remote)) {
      console.warn(
        pc.yellow(
          `⚠ ${path.basename(repoRoot)} has no "${remote}" remote — falling back to local git`,
        ),
      );
    } else {
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
    const vars = buildTemplateVars({ branch, repoRoot, worktreePath });
    const result = await runCommands(
      config.setup_commands.map((c) => expandTemplate(c, vars)),
      worktreePath,
    );
    if (!result.success) {
      console.error(
        pc.red(
          `✗ Setup failed: ${result.failedCommand} (exit code ${result.exitCode})`,
        ),
      );
      console.error(pc.dim(`Worktree left at ${worktreePath} for inspection`));
      process.exit(1);
    }
  }

  return { status: 'created', branch, repoRoot, worktreePath, config };
}

/**
 * Prompt the user about a worktree that already exists. `wt create` offers
 * open-or-quit; `wt agent` additionally offers starting the agent. Falls back to
 * a clear error + exit(1) in non-interactive contexts so scripts still fail.
 */
export async function promptExistingWorktree(
  worktreePath: string,
  opts: { allowAgent: boolean },
): Promise<ExistingWorktreeAction> {
  if (!process.stdin.isTTY) {
    console.error(pc.red(`Worktree path already exists: ${worktreePath}`));
    process.exit(1);
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
