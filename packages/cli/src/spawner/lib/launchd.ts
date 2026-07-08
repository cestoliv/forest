import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LAUNCHD_LABEL = 'com.cestoliv.agent-spawner';

export function plistPath(): string {
  return path.join(
    os.homedir(),
    'Library/LaunchAgents',
    `${LAUNCHD_LABEL}.plist`,
  );
}

export function logPath(): string {
  return path.join(
    os.homedir(),
    'Library/Logs/agent-spawner/agent-spawner.log',
  );
}

export function buildPlist(opts: {
  nodePath: string;
  cliPath: string;
  logPath: string;
  pathEnv: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.cliPath}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${opts.pathEnv}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${opts.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${opts.logPath}</string>
</dict>
</plist>
`;
}

export function install(): void {
  const target = plistPath();
  const log = logPath();
  mkdirSync(path.dirname(log), { recursive: true });
  mkdirSync(path.dirname(target), { recursive: true });
  const pathEnv = `${path.dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
  writeFileSync(
    target,
    buildPlist({
      nodePath: process.execPath,
      cliPath: process.argv[1],
      logPath: log,
      pathEnv,
    }),
    'utf8',
  );
  try {
    execFileSync('launchctl', ['unload', target], { stdio: 'ignore' });
  } catch {
    // not loaded yet — ignore
  }
  execFileSync('launchctl', ['load', target], { stdio: 'inherit' });
}

export function uninstall(): void {
  const target = plistPath();
  try {
    execFileSync('launchctl', ['unload', target], { stdio: 'ignore' });
  } catch {
    // not loaded — ignore
  }
  try {
    rmSync(target);
  } catch {
    // already gone — ignore
  }
}
