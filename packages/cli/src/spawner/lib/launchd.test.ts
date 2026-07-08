import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildPlist, LAUNCHD_LABEL, logPath, plistPath } from './launchd.js';

describe('launchd paths', () => {
  it('plist lives under LaunchAgents', () => {
    expect(plistPath()).toBe(
      `${os.homedir()}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
  });
  it('log lives under Library/Logs', () => {
    expect(logPath()).toBe(
      `${os.homedir()}/Library/Logs/agent-spawner/agent-spawner.log`,
    );
  });
});

describe('buildPlist', () => {
  const plist = buildPlist({
    nodePath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/agent-spawner/dist/cli.js',
    logPath: '/Users/me/Library/Logs/agent-spawner/agent-spawner.log',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
  });

  it('embeds the label, program args, run-at-load and keepalive', () => {
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain(
      '<string>/usr/local/lib/agent-spawner/dist/cli.js</string>',
    );
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/usr/local/bin:/usr/bin:/bin');
  });

  it('is valid-looking plist xml', () => {
    expect(plist.startsWith('<?xml')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
  });
});
