import { loadConfig } from '../lib/config.js';
import { runWtAgent } from '../lib/dispatch.js';
import { logPath } from '../lib/launchd.js';
import { createLogger } from '../lib/log.js';
import { runLoop } from '../lib/loop.js';
import { TodoistClient } from '../lib/todoist.js';

export async function runCommand(): Promise<void> {
  const log = createLogger(logPath());

  // Validate the config once up front so a broken config fails fast with a
  // clear message instead of only surfacing as a per-tick error in the log.
  try {
    loadConfig();
  } catch (err) {
    log(`Fatal: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  log('agent-spawner started (config reloaded each tick).');
  try {
    await runLoop(
      {
        loadConfig,
        makeApi: (config) => new TodoistClient(config.token),
        spawnAgent: runWtAgent,
        log,
      },
      { signal: controller.signal },
    );
  } catch (err) {
    log(`Fatal: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  log('agent-spawner stopped.');
}
