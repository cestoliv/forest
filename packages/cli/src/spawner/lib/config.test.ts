import os from 'node:os';
import path from 'node:path';
import type Conf from 'conf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentSpawnerConfig,
  createStore,
  DEFAULT_CONFIG,
  loadConfig,
} from './config.js';

function tmpStore(): Conf<AgentSpawnerConfig> {
  const cwd = path.join(
    os.tmpdir(),
    `as-cfg-${Math.random().toString(36).slice(2)}`,
  );
  return createStore(cwd);
}

const valid: AgentSpawnerConfig = {
  token: 'cfg-token',
  pollIntervalSeconds: 600,
  branchPrefix: 'agent/',
  promptTemplate: "Let's tackle this task {{url}}",
  labels: { ready: '1', working: '2', error: '3' },
  rules: [{ project: 'p1', path: '~/dev/repo' }],
};

describe('loadConfig', () => {
  const saved = process.env.TODOIST_API_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.TODOIST_API_TOKEN;
    else process.env.TODOIST_API_TOKEN = saved;
  });
  beforeEach(() => {
    delete process.env.TODOIST_API_TOKEN;
  });

  it('expands ~ in rule paths', () => {
    const store = tmpStore();
    store.store = valid;
    const cfg = loadConfig(store);
    expect(cfg.rules[0].path).toBe(path.join(os.homedir(), 'dev/repo'));
  });

  it('prefers TODOIST_API_TOKEN env over config token', () => {
    const store = tmpStore();
    store.store = valid;
    process.env.TODOIST_API_TOKEN = 'env-token';
    expect(loadConfig(store).token).toBe('env-token');
  });

  it('throws when no token is available', () => {
    const store = tmpStore();
    store.store = { ...valid, token: '' };
    expect(() => loadConfig(store)).toThrow(/token/i);
  });

  it('throws when a label id is missing', () => {
    const store = tmpStore();
    store.store = { ...valid, labels: { ready: '1', working: '', error: '3' } };
    expect(() => loadConfig(store)).toThrow(/working/i);
  });

  it('throws when a rule lacks project or path', () => {
    const store = tmpStore();
    store.store = { ...valid, rules: [{ project: '', path: '' }] };
    expect(() => loadConfig(store)).toThrow(/rule/i);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_CONFIG.pollIntervalSeconds).toBe(600);
    expect(DEFAULT_CONFIG.branchPrefix).toBe('agent/');
    expect(DEFAULT_CONFIG.promptTemplate).toContain('{{url}}');
  });

  describe('pollIntervalSeconds validation', () => {
    it('throws when pollIntervalSeconds is 0', () => {
      const store = tmpStore();
      store.store = { ...valid, pollIntervalSeconds: 0 };
      expect(() => loadConfig(store)).toThrow(/pollIntervalSeconds/i);
    });

    it('throws when pollIntervalSeconds is negative', () => {
      const store = tmpStore();
      store.store = { ...valid, pollIntervalSeconds: -5 };
      expect(() => loadConfig(store)).toThrow(/pollIntervalSeconds/i);
    });

    it('throws when pollIntervalSeconds is non-numeric', () => {
      const store = tmpStore();
      store.store = {
        ...valid,
        pollIntervalSeconds: '600' as unknown as number,
      };
      expect(() => loadConfig(store)).toThrow(/pollIntervalSeconds/i);
    });

    it('accepts a valid positive pollIntervalSeconds', () => {
      const store = tmpStore();
      store.store = { ...valid, pollIntervalSeconds: 30 };
      const cfg = loadConfig(store);
      expect(cfg.pollIntervalSeconds).toBe(30);
    });
  });
});
