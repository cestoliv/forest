import { Command } from 'commander';

const program = new Command();

program
  .name('agent-spawner')
  .description('Dispatch Todoist "Agent Ready" tasks to wt agent Zed sessions')
  .version(__VERSION__);

program
  .command('run')
  .description('Run the poll loop in the foreground')
  .action(async () => {
    const { runCommand } = await import('./commands/run.js');
    await runCommand();
  });

program
  .command('install')
  .description('Install the launchd LaunchAgent (auto-start on login)')
  .action(async () => {
    const { installCommand } = await import('./commands/install.js');
    installCommand();
  });

program
  .command('uninstall')
  .description('Remove the launchd LaunchAgent')
  .action(async () => {
    const { uninstallCommand } = await import('./commands/uninstall.js');
    uninstallCommand();
  });

program
  .command('logs')
  .description('Tail the daemon log file')
  .action(async () => {
    const { logsCommand } = await import('./commands/logs.js');
    logsCommand();
  });

program
  .command('config')
  .description('Open the config file in $EDITOR')
  .option('--path', 'Print the config file path and exit')
  .action(async (options: { path?: boolean }) => {
    const mod = await import('./commands/config.js');
    if (options.path) mod.printConfigPath();
    else mod.openConfig();
  });

await program.parseAsync(process.argv);
