import { install, plistPath } from '../lib/launchd.js';

export function installCommand(): void {
  install();
  console.log(`Installed LaunchAgent: ${plistPath()}`);
  console.log(
    'Tip: run `agent-spawner run` once in the foreground first to grant Accessibility to the agent process.',
  );
}
