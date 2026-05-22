// src/commands/create.ts
import { existsSync } from 'node:fs';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  type ConfigStore,
  createStore,
  getEffectiveConfig,
} from '../lib/config.js';
import {
  addWorktree,
  branchExists,
  fetchRemote,
  getRepoRoot,
  resolveWorktreePath,
} from '../lib/git.js';
import { openIde } from '../lib/ide.js';
import { getRegisteredRepos, registerRepo } from '../lib/registry.js';
import { runSetupCommands } from '../lib/setup.js';
import { runBranchInput, runRepoPicker } from '../lib/tui.js';

interface CreateOptions {
  cwd?: string;
  store?: ConfigStore;
  repoPicker?: (repos: string[]) => Promise<string | null>;
  branchInput?: (repoRoot: string) => Promise<string | null>;
}

export async function createWorktree(
  branch: string | undefined,
  options: CreateOptions = {},
): Promise<void> {
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
      return;
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
    if (!picked) return;
    repoRoot = picked;
    if (!branch) {
      const entered = await branchInput(repoRoot);
      if (!entered) return;
      branch = entered;
    }
  }

  if (!repoRoot) return;

  if (!branch) {
    const input = await clack.text({
      message: 'Branch name:',
      validate: (v) => (!v || v.length === 0 ? 'Required' : undefined),
    });
    if (clack.isCancel(input)) return;
    branch = input as string;
  }

  registerRepo(repoRoot, store);

  const config = getEffectiveConfig(repoRoot, store);

  const parts = config.base_branch.split('/', 2);
  if (parts.length === 2) {
    const remote = parts[0];
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

  const worktreePath = resolveWorktreePath(
    repoRoot,
    config.worktree_path,
    branch,
  );

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  const exists = branchExists(repoRoot, branch);
  if (exists) {
    addWorktree(repoRoot, worktreePath, branch);
  } else {
    addWorktree(repoRoot, worktreePath, branch, config.base_branch);
  }

  console.log(pc.green(`✓ Created worktree at ${worktreePath}`));

  if (config.setup_commands.length > 0) {
    console.log(pc.dim('Running setup commands...'));
    const result = await runSetupCommands(config.setup_commands, worktreePath);
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

  if (config.ide) {
    const opened = await openIde(
      config.ide,
      config.ide_open_args,
      worktreePath,
    );
    if (opened) {
      console.log(pc.green(`✓ Opened ${config.ide}`));
    }
  }
}
