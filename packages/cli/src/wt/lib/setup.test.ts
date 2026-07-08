import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommands } from './setup.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'wt-setup-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('runCommands', () => {
  it('returns success for empty commands array', async () => {
    const result = await runCommands([], tmpDir);
    expect(result.success).toBe(true);
  });

  it('runs commands sequentially in the given directory', async () => {
    const result = await runCommands(
      ['touch file1.txt', 'touch file2.txt'],
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(existsSync(path.join(tmpDir, 'file1.txt'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'file2.txt'))).toBe(true);
  });

  it('stops on first failure and reports the failing command', async () => {
    const markerPath = path.join(tmpDir, 'should-not-exist.txt');
    const result = await runCommands(['exit 1', `touch ${markerPath}`], tmpDir);
    expect(result.success).toBe(false);
    expect(result.failedCommand).toBe('exit 1');
    expect(result.exitCode).toBe(1);
    expect(existsSync(markerPath)).toBe(false);
  });
});
