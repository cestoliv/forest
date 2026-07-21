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
  slugifyBranch,
} from '../lib/git.js';
import { openIde } from '../lib/ide.js';
import { openWorktreeInOrca } from '../lib/orca.js';
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
  /**
   * IDE to open the worktree in (e.g. `zed`, `orca`); overrides the configured
   * `ide`. Precedence: this flag → `config.ide` → the built-in default `zed`.
   */
  ide?: string;
  /**
   * Reveal/focus the opened target (currently only Orca's `terminal create
   * --focus`). Set for interactive CLI runs; left false for the daemon so a
   * batch of dispatches doesn't keep stealing focus.
   */
  focus?: boolean;
  /** Sink for human-readable progress/error lines. Defaults to console. */
  report?: (msg: string) => void;
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
  const report = options.report ?? ((m: string) => console.log(m));

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
    // already-valid root is harmless. A bad path is a hard input error, so
    // throw (never process.exit — a library caller like the daemon reaches this
    // via runAgent's repoRoot and must get { ok:false }, not be killed).
    const resolved = path.resolve(cwd, options.repoRoot);
    try {
      repoRoot = getRepoRoot(resolved);
    } catch {
      throw new Error(`${options.repoRoot} is not a git repository`);
    }
  } else {
    const repos = getRegisteredRepos(store);
    if (repos.length === 0) {
      report(
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
  }

  if (!branch) {
    const entered = await branchInput(repoRoot);
    if (!entered) return null;
    branch = entered;
  }

  // Normalize into a valid git branch name so free-form input (e.g. "detection
  // issues 13-07") doesn't make `git worktree add -b` fail. Reported when it
  // changes so the user knows the branch they got.
  const requested = branch;
  branch = slugifyBranch(branch);
  if (!branch) {
    report(pc.red(`"${requested}" is not a usable branch name.`));
    return null;
  }
  if (branch !== requested) {
    report(pc.dim(`Using branch name "${branch}" (from "${requested}")`));
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
    return { status: 'exists', branch, repoRoot, worktreePath, config };
  }

  const parts = config.base_branch.split('/', 2);
  const remote = parts[0] || 'origin';

  if (parts.length === 2) {
    if (!remoteExists(repoRoot, remote)) {
      report(
        pc.yellow(
          `⚠ ${path.basename(repoRoot)} has no "${remote}" remote — falling back to local git`,
        ),
      );
    } else {
      try {
        fetchRemote(repoRoot, remote);
      } catch (err) {
        report(
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

  report(pc.green(`✓ Created worktree at ${worktreePath}`));

  if (config.setup_commands.length > 0) {
    report(pc.dim('Running setup commands...'));
    const vars = buildTemplateVars({ branch, repoRoot, worktreePath });
    const result = await runCommands(
      config.setup_commands.map((c) => expandTemplate(c, vars)),
      worktreePath,
    );
    if (!result.success) {
      throw new Error(
        `Setup failed: ${result.failedCommand} (exit code ${result.exitCode})\nWorktree left at ${worktreePath} for inspection`,
      );
    }
  }

  return { status: 'created', branch, repoRoot, worktreePath, config };
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
 *
 * `orca` is not a plain `spawn`-and-open editor: it opens the worktree by
 * registering the repo (`orca repo add`) and attaching a terminal to it via the
 * Orca CLI, which needs the repo root — so `repoRoot` is required for that path.
 */
export async function openConfiguredIde(
  config: RepoConfig,
  worktreePath: string,
  report: (msg: string) => void = (m) => console.log(m),
  repoRoot?: string,
  focus = false,
): Promise<boolean> {
  if (!config.ide) return false;
  if (config.ide === 'orca') {
    if (!repoRoot) {
      report(pc.red('✗ Cannot open Orca without the repo root.'));
      return false;
    }
    const opened = await openWorktreeInOrca({
      repoRoot,
      worktreePath,
      focus,
      report,
    });
    if (opened) {
      report(pc.green('✓ Opened orca'));
    }
    return opened;
  }
  const opened = await openIde(config.ide, config.ide_open_args, worktreePath);
  if (opened) {
    report(pc.green(`✓ Opened ${config.ide}`));
  }
  return opened;
}

export async function createWorktree(
  branch: string | undefined,
  options: CreateOptions = {},
): Promise<void> {
  const report = options.report ?? ((m: string) => console.log(m));
  const prepared = await prepareWorktree(branch, options);
  if (!prepared) return;

  const { status, worktreePath, repoRoot } = prepared;
  // Resolve the IDE: --ide flag → configured ide → default. Overriding it on a
  // copy keeps the rest of the flow (and openConfiguredIde) reading config.ide.
  const config = {
    ...prepared.config,
    ide: options.ide ?? prepared.config.ide,
  };

  if (status === 'exists') {
    const prompt = options.existingWorktreePrompt ?? promptExistingWorktree;
    const action = await prompt(worktreePath, { allowAgent: false });
    // Only 'open' proceeds to open the existing worktree. 'quit' (and 'agent',
    // which is never offered here since allowAgent is false) stop instead.
    if (action !== 'open') return;
  }

  await openConfiguredIde(
    config,
    worktreePath,
    report,
    repoRoot,
    options.focus ?? false,
  );
}
