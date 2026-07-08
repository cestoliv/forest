// True end-to-end test of the daemon's dispatch path against the REAL
// in-process runAgent (no mocking of git/worktree/ide). `runWtAgent` itself
// can't take an injected store (its SpawnAgent signature has none, matching
// production, which always uses the global store — see STEP 0 in the brief),
// so this test builds a `spawnAgent` that calls the real `runAgent` WITH a
// temp store, making the flow hermetic while still exercising the real
// dispatchTask -> runAgent -> prepareWorktree -> real git chain.
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from '../../wt/agent-api.js';
import {
  createStore as createWtStore,
  setGlobalConfig,
} from '../../wt/lib/config.js';
import { FIXTURE_LABELS, makeTask } from '../test-utils.js';
import type { AgentSpawnerConfig } from './config.js';
import {
  type DispatchDeps,
  dispatchTask,
  type SpawnAgent,
} from './dispatch.js';
import type { TodoistApi, TodoistTask } from './todoist.js';

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'as-dispatch-e2e-')));
  repoDir = path.join(tmpDir, 'my-repo');
  execSync(`mkdir -p ${repoDir}`);
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "t@t.com"', { cwd: repoDir });
  execSync('git config user.name "T"', { cwd: repoDir });
  execSync('touch README.md', { cwd: repoDir });
  execSync('git add .', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

describe('dispatchTask (E2E, real runAgent + real git)', () => {
  it('drives dispatchTask -> real runAgent -> real prepareWorktree, creating a real worktree and labelling the task Working', async () => {
    const wtStore = createWtStore(path.join(tmpDir, 'wt-config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'true',
        ide_open_args: [],
        agent_command: 'echo agent',
      },
      wtStore,
    );

    const spawnAgent: SpawnAgent = (branch, prompt, repoPath) =>
      runAgent({ repoPath, branch, prompt, store: wtStore });

    const config: AgentSpawnerConfig = {
      token: 't',
      pollIntervalSeconds: 600,
      branchPrefix: 'agent/',
      promptTemplate: "Let's tackle this task {{url}}",
      labels: { ready: '2183654821', working: '900001', error: '900002' },
      rules: [{ project: 'OVL', labels: ['2183895737'], path: repoDir }],
    };

    const idToName = new Map(FIXTURE_LABELS.map((l) => [l.id, l.name]));
    const nameToId = new Map(FIXTURE_LABELS.map((l) => [l.name, l.id]));
    const api = fakeApi();
    const deps: DispatchDeps = {
      api,
      config,
      idToName,
      nameToId,
      spawnAgent,
      log: () => {},
    };

    const task: TodoistTask = makeTask({
      id: 'm1',
      content: 'Mobile crash',
      project_id: 'OVL',
      labels: ['Agent Ready', '📱 Overload Mobile'],
    });

    await dispatchTask(task, deps);

    // real dispatch success path: relabelled Ready -> Working, no error comment.
    expect(api.updated).toEqual([
      { id: 'm1', labels: ['📱 Overload Mobile', 'Agent Working'] },
    ]);
    expect(api.comments).toEqual([]);

    // real worktree actually created by the real prepareWorktree via the
    // in-process dispatch -> runAgent chain:
    const wtPath = path.join(tmpDir, 'my-repo-agent-mobile-crash-m1');
    expect(existsSync(wtPath)).toBe(true);
    expect(
      execSync('git worktree list', { cwd: repoDir }).toString(),
    ).toContain(wtPath);
  });
});
