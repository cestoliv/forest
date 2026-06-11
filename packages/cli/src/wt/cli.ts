import { Command } from 'commander';

const program = new Command();

program
  .name('wt')
  .description('Git worktree manager')
  .version(__WT_VERSION__)
  .action(async () => {
    const { runList } = await import('./commands/list.js');
    await runList();
  });

program
  .command('create [branch]')
  .description('Create a new worktree')
  .action(async (branch?: string) => {
    const { createWorktree } = await import('./commands/create.js');
    await createWorktree(branch);
  });

program
  .command('agent <branch> <plan_prompt>')
  .description('Create a worktree and auto-start an AI agent in Zed (macOS)')
  .option(
    '--mode <mode>',
    'Claude Code permission mode (default, plan, auto, etc.)',
    'plan',
  )
  .action(
    async (branch: string, planPrompt: string, options: { mode: string }) => {
      const { createAgentWorktree } = await import('./commands/agent.js');
      await createAgentWorktree(branch, planPrompt, { mode: options.mode });
    },
  );

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

await program.parseAsync(process.argv);
