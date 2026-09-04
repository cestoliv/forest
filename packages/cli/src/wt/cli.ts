import { Command } from 'commander';

const program = new Command();

program
  .name('wt')
  .description('Git worktree manager')
  .version(__VERSION__)
  .action(async () => {
    const { runList } = await import('./commands/list.js');
    await runList();
  });

program
  .command('create [branch]')
  .description('Create a new worktree')
  .option('--repo <path>', 'Target repository path; skips the repo picker')
  .option(
    '--ide <ide>',
    'IDE to open the worktree in (e.g. zed, orca); overrides the configured ide',
  )
  .action(
    async (
      branch: string | undefined,
      options: { repo?: string; ide?: string },
    ) => {
      const { createWorktree } = await import('./commands/create.js');
      await createWorktree(branch, {
        repoRoot: options.repo,
        ide: options.ide,
        // Interactive CLI run: reveal the opened worktree (Orca --focus).
        focus: true,
      });
    },
  );

program
  .command('agent <branch> <plan_prompt>')
  .description('Create a worktree and auto-start an AI agent in Zed or Orca')
  .option(
    '--mode <mode>',
    'Claude Code permission mode (default, plan, auto, etc.); overrides the configured agent_mode',
  )
  .option(
    '--model <model>',
    'Model to run the agent on (e.g. fable, opus); overrides the configured agent_model',
  )
  .option('--repo <path>', 'Target repository path; skips the repo picker')
  .option(
    '--ide <ide>',
    'IDE to start the agent in (e.g. zed, orca); overrides the configured ide',
  )
  .action(
    async (
      branch: string,
      planPrompt: string,
      options: { mode?: string; model?: string; repo?: string; ide?: string },
    ) => {
      const { createAgentWorktree } = await import('./commands/agent.js');
      await createAgentWorktree(branch, planPrompt, {
        mode: options.mode,
        model: options.model,
        repoRoot: options.repo,
        ide: options.ide,
        // Interactive CLI run: reveal the agent's terminal (Orca --focus).
        focus: true,
      });
    },
  );

program
  .command('prune')
  .description(
    'Remove worktrees whose branch has been merged into the base branch',
  )
  .option(
    '--no-pull',
    'Skip pulling the main worktree after pruning merged worktrees',
  )
  .action(async (options) => {
    const { runPrune } = await import('./commands/prune.js');
    await runPrune({ pull: options.pull });
  });

program
  .command('count')
  .description('Count worktrees, total and per repo')
  .action(async () => {
    const { runCount } = await import('./commands/count.js');
    await runCount();
  });

program
  .command('config')
  .description('Open the config file in $EDITOR')
  .option('--path', 'Print the config file path and exit')
  .action(async (options: { path?: boolean }) => {
    if (options.path) {
      const { printConfigPath } = await import('./commands/config.js');
      printConfigPath();
    } else {
      const { openConfig } = await import('./commands/config.js');
      openConfig();
    }
  });

program
  .command('skill')
  .description('Print the wt skill file to stdout')
  .action(async () => {
    const { printSkill } = await import('./commands/skill.js');
    printSkill();
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
