import { spawn } from 'node:child_process';

export interface SetupResult {
  success: boolean;
  failedCommand?: string;
  exitCode?: number;
}

export async function runSetupCommands(
  commands: string[],
  cwd: string,
): Promise<SetupResult> {
  for (const command of commands) {
    const result = await runCommand(command, cwd);
    if (!result.success) {
      return {
        success: false,
        failedCommand: command,
        exitCode: result.exitCode,
      };
    }
  }
  return { success: true };
}

function runCommand(
  command: string,
  cwd: string,
): Promise<{ success: boolean; exitCode?: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, stdio: 'inherit', shell: true });
    child.on('error', () => {
      resolve({ success: false, exitCode: undefined });
    });
    child.on('close', (code) => {
      resolve({ success: code === 0, exitCode: code ?? undefined });
    });
  });
}
