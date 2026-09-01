// src/config-file.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatConfigFile,
  openConfigFile,
  readConfigParseError,
} from './config-file.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'config-file-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('formatConfigFile', () => {
  it('rewrites valid but ugly JSON as tab-indented JSON with no trailing newline', () => {
    writeFileSync(configPath, '{"a":1,"b":{"c":2}}');

    formatConfigFile(configPath);

    expect(readFileSync(configPath, 'utf8')).toBe(
      JSON.stringify({ a: 1, b: { c: 2 } }, undefined, '\t'),
    );
  });

  it('leaves an already-formatted file byte-identical', () => {
    const formatted = JSON.stringify({ a: 1, b: { c: 2 } }, undefined, '\t');
    writeFileSync(configPath, formatted);

    formatConfigFile(configPath);

    expect(readFileSync(configPath, 'utf8')).toBe(formatted);
  });

  it('leaves corrupt JSON untouched', () => {
    writeFileSync(configPath, '{bad json!!!}');

    formatConfigFile(configPath);

    expect(readFileSync(configPath, 'utf8')).toBe('{bad json!!!}');
  });

  it('does not throw when the file does not exist', () => {
    expect(() => formatConfigFile(configPath)).not.toThrow();
  });
});

describe('readConfigParseError', () => {
  it('returns undefined for valid JSON', () => {
    writeFileSync(configPath, '{"a":1}');

    expect(readConfigParseError(configPath)).toBeUndefined();
  });

  it('returns undefined when the file does not exist', () => {
    expect(readConfigParseError(configPath)).toBeUndefined();
  });

  it('returns a message for corrupt JSON', () => {
    writeFileSync(configPath, '{bad json!!!}');

    expect(readConfigParseError(configPath)).toBeTypeOf('string');
  });

  it('returns a message for an empty file', () => {
    writeFileSync(configPath, '');

    expect(readConfigParseError(configPath)).toBe(
      'Unexpected end of JSON input',
    );
  });
});

describe('openConfigFile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the path, beautifies, and exits 0 when the JSON is valid', async () => {
    writeFileSync(configPath, '{"a":1,"b":{"c":2}}');
    const originalEditor = process.env.EDITOR;
    try {
      // 'true' exits 0 immediately, so the test never spawns a real
      // interactive editor and never hangs on inherited stdio.
      process.env.EDITOR = 'true';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const child = openConfigFile(configPath, 'wt');

      expect(logSpy).toHaveBeenCalledWith(`Config: ${configPath}`);
      expect(readFileSync(configPath, 'utf8')).toBe(
        JSON.stringify({ a: 1, b: { c: 2 } }, undefined, '\t'),
      );

      await new Promise<void>((resolve) => child.on('close', () => resolve()));
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      if (originalEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = originalEditor;
    }
  });

  it('exits 1 and prints the parse error when the JSON is invalid', async () => {
    writeFileSync(configPath, '{bad json!!!}');
    const originalEditor = process.env.EDITOR;
    try {
      process.env.EDITOR = 'true';
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const child = openConfigFile(configPath, 'wt');

      await new Promise<void>((resolve) => child.on('close', () => resolve()));

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(configPath),
      );
      const parseError = readConfigParseError(configPath);
      expect(parseError).toBeDefined();
      if (!parseError) throw new Error('expected a parse error');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(parseError),
      );
    } finally {
      if (originalEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = originalEditor;
    }
  });

  it('exits with the editor exit code when the JSON is valid', async () => {
    writeFileSync(configPath, '{"a":1,"b":{"c":2}}');
    const originalEditor = process.env.EDITOR;
    try {
      // 'false' exits 1, proving the passthrough: a hardcoded `process.exit(0)`
      // could not produce this.
      process.env.EDITOR = 'false';
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);

      const child = openConfigFile(configPath, 'wt');

      await new Promise<void>((resolve) => child.on('close', () => resolve()));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      if (originalEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = originalEditor;
    }
  });
});
