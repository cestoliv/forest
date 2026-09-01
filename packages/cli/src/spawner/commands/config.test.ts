import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfigParseError } from '../../config-file.js';
import { DEFAULT_CONFIG, getConfigFilePath } from '../lib/config.js';
import { openConfig, printConfigPath } from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'spawner-config-cmd-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('printConfigPath', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the path', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printConfigPath(tmpDir);

    expect(logSpy).toHaveBeenCalledWith(getConfigFilePath(tmpDir));
  });

  it('still logs the path when config.json is corrupt', () => {
    writeFileSync(path.join(tmpDir, 'config.json'), '{bad json!!!}');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printConfigPath(tmpDir);

    expect(logSpy).toHaveBeenCalledWith(getConfigFilePath(tmpDir));
  });
});

describe('openConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the editor when config.json is corrupt', async () => {
    writeFileSync(path.join(tmpDir, 'config.json'), '{bad json!!!}');
    const originalEditor = process.env.EDITOR;
    try {
      process.env.EDITOR = 'true';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const child = openConfig(tmpDir);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(getConfigFilePath(tmpDir)),
      );

      await new Promise<void>((resolve) => child.on('close', () => resolve()));

      const parseError = readConfigParseError(path.join(tmpDir, 'config.json'));
      expect(parseError).toBeDefined();
      if (!parseError) throw new Error('expected a parse error');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(parseError),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('agent-spawner config'),
      );
    } finally {
      if (originalEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = originalEditor;
    }
  });

  // Root ignores mode bits, so the unwritable dir this test relies on
  // wouldn't actually block the seed write.
  it.skipIf(process.getuid?.() === 0)(
    'still opens the editor when the config dir is unwritable and there is no config.json',
    async () => {
      chmodSync(tmpDir, 0o500);
      const originalEditor = process.env.EDITOR;
      try {
        process.env.EDITOR = 'true';
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

        const child = openConfig(tmpDir);

        await new Promise<void>((resolve) =>
          child.on('close', () => resolve()),
        );
      } finally {
        chmodSync(tmpDir, 0o700);
        if (originalEditor === undefined) delete process.env.EDITOR;
        else process.env.EDITOR = originalEditor;
      }
    },
  );

  it('seeds a missing config.json with the defaults', async () => {
    const originalEditor = process.env.EDITOR;
    try {
      process.env.EDITOR = 'true';
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const child = openConfig(tmpDir);

      await new Promise<void>((resolve) => child.on('close', () => resolve()));

      const seeded = JSON.parse(
        readFileSync(path.join(tmpDir, 'config.json'), 'utf8'),
      );
      expect(seeded).toEqual(DEFAULT_CONFIG);
    } finally {
      if (originalEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = originalEditor;
    }
  });
});
