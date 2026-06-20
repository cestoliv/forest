// src/commands/config.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigFilePath } from '../lib/config.js';
import { openConfig, printConfigPath } from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'wt-config-cmd-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('printConfigPath', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs only the raw path', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printConfigPath(tmpDir);

    expect(logSpy).toHaveBeenCalledWith(getConfigFilePath(tmpDir));
  });
});

describe('openConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the config path', () => {
    const originalEditor = process.env.EDITOR;
    try {
      // Use a fast no-op editor so the test never spawns the machine's real
      // interactive editor (e.g. vim), which would hang on inherited stdio and
      // race the timer-based assertions in sibling tests.
      process.env.EDITOR = 'true';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      openConfig(tmpDir);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(getConfigFilePath(tmpDir)),
      );
    } finally {
      process.env.EDITOR = originalEditor;
    }
  });

  it('uses EDITOR env var when set', async () => {
    const originalEditor = process.env.EDITOR;
    try {
      process.env.EDITOR = 'true';
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      openConfig(tmpDir);

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(exitSpy).toHaveBeenCalledWith(0);
          resolve();
        }, 200);
      });
    } finally {
      process.env.EDITOR = originalEditor;
    }
  });
});

describe('printConfigPath without valid config', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the path even when config JSON is corrupt', () => {
    writeFileSync(path.join(tmpDir, 'config.json'), '{bad json!!!}');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printConfigPath(tmpDir);

    expect(logSpy).toHaveBeenCalledWith(getConfigFilePath(tmpDir));
  });
});

describe('openConfig without valid config', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens editor even when config JSON is corrupt', async () => {
    writeFileSync(path.join(tmpDir, 'config.json'), '{bad json!!!}');
    const originalEditor = process.env.EDITOR;
    try {
      process.env.EDITOR = 'true';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      openConfig(tmpDir);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(tmpDir));

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(exitSpy).toHaveBeenCalledWith(0);
          resolve();
        }, 200);
      });
    } finally {
      process.env.EDITOR = originalEditor;
    }
  });
});
