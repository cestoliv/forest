// src/commands/config.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../lib/config.js';
import { getConfigPath, openConfig, printConfigPath } from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'wt-config-cmd-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('getConfigPath', () => {
  it('returns a path ending in config.json', () => {
    const store = createStore(tmpDir);
    const p = getConfigPath(store);
    expect(p.endsWith('config.json')).toBe(true);
  });

  it('returns a path inside the provided cwd', () => {
    const store = createStore(tmpDir);
    const p = getConfigPath(store);
    expect(p.startsWith(tmpDir)).toBe(true);
  });
});

describe('printConfigPath', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs only the raw path', () => {
    const store = createStore(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printConfigPath(store);

    expect(logSpy).toHaveBeenCalledWith(store.path);
  });
});

describe('openConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the config path', () => {
    const store = createStore(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    openConfig(store);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(store.path));
  });

  it('uses EDITOR env var when set', () => {
    const store = createStore(tmpDir);
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = 'true';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    openConfig(store);

    // "true" command exits immediately with code 0
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(exitSpy).toHaveBeenCalledWith(0);
        process.env.EDITOR = originalEditor;
        resolve();
      }, 200);
    });
  });
});
