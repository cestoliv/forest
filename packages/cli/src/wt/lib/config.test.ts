// src/lib/config.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStore,
  DEFAULT_CONFIG,
  getConfigFilePath,
  getEffectiveConfig,
  getGlobalConfig,
  setGlobalConfig,
} from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'wt-config-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('createStore', () => {
  it('initialises with default config', () => {
    const store = createStore(tmpDir);
    expect(store.store).toMatchObject(DEFAULT_CONFIG);
  });
});

describe('getGlobalConfig', () => {
  it('returns full config with defaults', () => {
    const store = createStore(tmpDir);
    const config = getGlobalConfig(store);
    expect(config.ide).toBe('zed');
    expect(config.repos).toEqual([]);
    expect(config.repo_overrides).toEqual({});
  });
});

describe('setGlobalConfig', () => {
  it('updates a top-level field', () => {
    const store = createStore(tmpDir);
    setGlobalConfig({ ide: 'code' }, store);
    expect(getGlobalConfig(store).ide).toBe('code');
  });

  it('deep-merges repo_overrides', () => {
    const store = createStore(tmpDir);
    setGlobalConfig({ repo_overrides: { '/a': { ide: 'code' } } }, store);
    setGlobalConfig({ repo_overrides: { '/b': { ide: 'zed' } } }, store);
    const config = getGlobalConfig(store);
    expect(config.repo_overrides['/a']).toBeDefined();
    expect(config.repo_overrides['/b']).toBeDefined();
  });

  it('deep-merges fields within the same repo override', () => {
    const store = createStore(tmpDir);
    setGlobalConfig({ repo_overrides: { '/r': { ide: 'code' } } }, store);
    setGlobalConfig(
      { repo_overrides: { '/r': { base_branch: 'main' } } },
      store,
    );
    expect(getGlobalConfig(store).repo_overrides['/r']).toEqual({
      ide: 'code',
      base_branch: 'main',
    });
  });
});

describe('getEffectiveConfig', () => {
  it('returns global defaults when no repo override exists', () => {
    const store = createStore(tmpDir);
    const config = getEffectiveConfig('/no/override', store);
    expect(config.ide).toBe('zed');
    expect(config.setup_commands).toEqual([]);
    expect(config.auto_refresh_minutes).toBe(5);
  });

  it('honours a per-repo auto_refresh_minutes override', () => {
    const store = createStore(tmpDir);
    setGlobalConfig(
      { repo_overrides: { '/my/repo': { auto_refresh_minutes: 1 } } },
      store,
    );
    expect(getEffectiveConfig('/my/repo', store).auto_refresh_minutes).toBe(1);
    expect(getEffectiveConfig('/other/repo', store).auto_refresh_minutes).toBe(
      5,
    );
  });

  it('overrides global fields with repo-specific values', () => {
    const store = createStore(tmpDir);
    setGlobalConfig(
      {
        repo_overrides: {
          '/my/repo': { ide: 'code', setup_commands: ['yarn'] },
        },
      },
      store,
    );
    const config = getEffectiveConfig('/my/repo', store);
    expect(config.ide).toBe('code');
    expect(config.setup_commands).toEqual(['yarn']);
    expect(config.worktree_path).toBe('../');
  });

  it('repo override does not affect other repos', () => {
    const store = createStore(tmpDir);
    setGlobalConfig({ repo_overrides: { '/my/repo': { ide: 'code' } } }, store);
    const other = getEffectiveConfig('/other/repo', store);
    expect(other.ide).toBe('zed');
  });
});

describe('getConfigFilePath', () => {
  it('returns a path ending with config.json', () => {
    const p = getConfigFilePath();
    expect(p).toMatch(/config\.json$/);
  });
});

describe('createStore error handling', () => {
  it('prints error and exits on malformed config JSON', () => {
    writeFileSync(path.join(tmpDir, 'config.json'), '{bad json!!!}');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    createStore(tmpDir);

    expect(errorSpy).toHaveBeenCalledOnce();
    const errorMsg = errorSpy.mock.calls[0][0];
    expect(errorMsg).toContain('Error reading config file');
    expect(errorMsg).toContain(tmpDir);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
