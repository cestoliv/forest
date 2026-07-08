import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_LABELS, makeTask } from '../test-utils.js';
import type { AgentSpawnerConfig } from './config.js';
import {
  type DispatchDeps,
  dispatchTask,
  type SpawnAgent,
} from './dispatch.js';
import type { TodoistApi, TodoistTask } from './todoist.js';

const config: AgentSpawnerConfig = {
  token: 't',
  pollIntervalSeconds: 600,
  branchPrefix: 'agent/',
  promptTemplate: "Let's tackle this task {{url}}",
  labels: { ready: '2183654821', working: '900001', error: '900002' },
  rules: [
    { project: 'OVL', labels: ['2183895737'], path: '/repos/mobile' },
    { project: 'OVL', labels: ['2183895740'], path: '/repos/backend' },
  ],
};

function maps() {
  const idToName = new Map(FIXTURE_LABELS.map((l) => [l.id, l.name]));
  const nameToId = new Map(FIXTURE_LABELS.map((l) => [l.name, l.id]));
  return { idToName, nameToId };
}

function fakeApi(): TodoistApi & {
  updated: { id: string; labels: string[] }[];
  comments: { id: string; content: string }[];
} {
  const updated: { id: string; labels: string[] }[] = [];
  const comments: { id: string; content: string }[] = [];
  return {
    updated,
    comments,
    listTasksByLabel: async () => [],
    listLabels: async () => FIXTURE_LABELS,
    updateTaskLabels: async (id, labels) => {
      updated.push({ id, labels });
    },
    addComment: async (id, content) => {
      comments.push({ id, content });
    },
  };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps & {
  api: ReturnType<typeof fakeApi>;
} {
  const api = fakeApi();
  const { idToName, nameToId } = maps();
  return {
    api,
    config,
    idToName,
    nameToId,
    spawnAgent: (async () => ({ ok: true, output: '' })) as SpawnAgent,
    log: () => {},
    ...over,
  } as DispatchDeps & { api: ReturnType<typeof fakeApi> };
}

const mobileTask: TodoistTask = makeTask({
  id: 'm1',
  content: 'Mobile crash',
  project_id: 'OVL',
  labels: ['Agent Ready', '📱 Overload Mobile'],
});

describe('dispatchTask', () => {
  it('on success: routes, spawns, swaps Ready -> Working', async () => {
    const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
    const d = deps({ spawnAgent });
    await dispatchTask(mobileTask, d);
    expect(spawnAgent).toHaveBeenCalledWith(
      'agent/mobile-crash-m1',
      "Let's tackle this task https://app.todoist.com/app/task/m1",
      '/repos/mobile',
    );
    expect(d.api.updated).toEqual([
      { id: 'm1', labels: ['📱 Overload Mobile', 'Agent Working'] },
    ]);
    expect(d.api.comments).toEqual([]);
  });

  it('on no route: adds Error label + comment, keeps Ready', async () => {
    const spawnAgent = vi.fn(async () => ({ ok: true, output: '' }));
    const task = makeTask({
      id: 'z1',
      project_id: 'UNKNOWN',
      labels: ['Agent Ready'],
    });
    const d = deps({ spawnAgent });
    await dispatchTask(task, d);
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(d.api.updated).toEqual([
      { id: 'z1', labels: ['Agent Ready', 'Agent Error'] },
    ]);
    expect(d.api.comments[0].content).toMatch(/no .*rule|route/i);
  });

  it('on spawn failure: adds Error label + comment, keeps Ready', async () => {
    const spawnAgent = vi.fn(async () => ({ ok: false, output: 'boom' }));
    const d = deps({ spawnAgent });
    await dispatchTask(mobileTask, d);
    expect(d.api.updated).toEqual([
      {
        id: 'm1',
        labels: ['Agent Ready', '📱 Overload Mobile', 'Agent Error'],
      },
    ]);
    expect(d.api.comments[0].content).toMatch(/boom/);
  });

  it('labels the task Agent Error when the in-process agent throws (loop survives)', async () => {
    const d = deps({
      spawnAgent: async () => {
        throw new Error('kaboom');
      },
    });
    const task = makeTask({
      id: 'm2',
      project_id: 'OVL',
      labels: ['Agent Ready', '📱 Overload Mobile'],
    });

    await expect(dispatchTask(task, d)).resolves.toBeUndefined();

    const errored = d.api.updated.at(-1);
    expect(errored?.labels).toContain('Agent Error');
    expect(d.api.comments.at(-1)?.content).toContain('kaboom');
  });
});
