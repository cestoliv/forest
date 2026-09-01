import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function readConfigText(configPath: string): string | undefined {
  try {
    return readFileSync(configPath, 'utf8');
  } catch {
    // A config file that cannot be read is nothing to format and nothing to validate.
    return undefined;
  }
}

/** Rewrite the config tab-indented, the exact shape `conf` serializes to. */
export function formatConfigFile(configPath: string): void {
  const text = readConfigText(configPath);
  if (text === undefined) return;

  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(text), undefined, '\t');
  } catch {
    return; // Corrupt JSON is the user's to fix in the editor.
  }

  // ponytail: non-atomic rewrite; a tmp-file + rename would drop the config's
  // mode (it can hold an API token), and the payload is under 4 KB.
  if (formatted !== text) writeFileSync(configPath, formatted);
}

export function readConfigParseError(configPath: string): string | undefined {
  const text = readConfigText(configPath);
  if (text === undefined) return undefined;

  try {
    JSON.parse(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export function openConfigFile(
  configPath: string,
  commandName: string,
): ChildProcess {
  console.log(`Config: ${configPath}`);
  formatConfigFile(configPath);

  const editor = process.env.EDITOR ?? 'nano';
  const child = spawn(editor, [configPath], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`Failed to open editor: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code) => {
    const parseError = readConfigParseError(configPath);
    if (!parseError) {
      process.exit(code ?? 0);
      return;
    }
    console.error(`✗ Invalid JSON in ${configPath}`);
    console.error(`  ${parseError}`);
    console.error(`  Run \`${commandName} config\` again to fix it.`);
    process.exit(1);
  });
  return child;
}
