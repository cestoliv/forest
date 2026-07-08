import { plistPath, uninstall } from '../lib/launchd.js';

export function uninstallCommand(): void {
  uninstall();
  console.log(`Removed LaunchAgent: ${plistPath()}`);
}
