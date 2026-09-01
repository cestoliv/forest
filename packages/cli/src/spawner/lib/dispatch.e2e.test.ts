// True end-to-end test of the daemon's dispatch path against the REAL
// in-process runAgent (no mocking of git/worktree). `runWtAgent` itself can't
// take an injected store (its SpawnAgent signature has none, matching
// production, which always uses the global store), so this test builds a
// `spawnAgent` that calls the real `runAgent` WITH a temp store, making the
// flow hermetic while still exercising the real dispatchTask -> runAgent ->
// prepareWorktree -> real git chain.
//
// Only the Zed GUI automation and IDE launch are stubbed (they can't run in
// CI): the success path can prove the agent "started" -> task labelled Working,
// while the not-started path (non-Zed IDE) proves the fix — a worktree that was
// created but where no agent ran is labelled "Agent Error", not "Agent
// Working".
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The Zed automation and IDE launch can't run headless in CI; stub them so the
// success path's agent "starts" while the real git/worktree layer runs.
vi.mock('../../wt/lib/ide.js', () => ({
  openIde: vi.fn(async () => true),
}));

vi.mock('../../wt/lib/zed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../wt/lib/zed.js')>();
  return {
    AGENT_TASK_LABEL: 'wt: agent',
    buildAgentTask: vi.fn(actual.buildAgentTask),
    writeAgentTask: vi.fn(() => ({ createdDir: true, createdFile: true })),
    ensureKeymap: vi.fn(() => true),
    triggerChord: vi.fn(async () => ({ ok: true })),
    cleanupAgentTask: vi.fn(),
    openAccessibilitySettings: vi.fn(),
    isHeadlessSession: vi.fn(() => false),
  };
});

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
  vi.clearAllMocks();
  vi.useRealTimers();
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

function buildDeps(wtStore: ReturnType<typeof createWtStore>): DispatchDeps & {
  api: ReturnType<typeof fakeApi>;
} {
  const spawnAgent: SpawnAgent = (branch, prompt, repoPath) =>
    runAgent({ repoPath, branch, prompt, store: wtStore });

  const config: AgentSpawnerConfig = {
    token: 't',
    pollIntervalSeconds: 600,
    maxWorktrees: 0,
    maxWorktreesPerRepo: {},
    branchPrefix: 'agent/',
    promptTemplate: "Let's tackle this task {{url}}",
    labels: { ready: '2183654821', working: '900001', error: '900002' },
    rules: [{ project: 'OVL', labels: ['2183895737'], path: repoDir }],
  };

  const idToName = new Map(FIXTURE_LABELS.map((l) => [l.id, l.name]));
  const nameToId = new Map(FIXTURE_LABELS.map((l) => [l.name, l.id]));
  const api = fakeApi();
  return { api, config, idToName, nameToId, spawnAgent, log: () => {} };
}

const mobileTask: TodoistTask = makeTask({
  id: 'm1',
  content: 'Mobile crash',
  project_id: 'OVL',
  labels: ['Agent Ready', '📱 Overload Mobile'],
});

describe('dispatchTask (E2E, real runAgent + real git)', () => {
  it('drives dispatchTask -> real runAgent -> real prepareWorktree, creating a real worktree and labelling the task Working', async () => {
    vi.useFakeTimers();
    const wtStore = createWtStore(path.join(tmpDir, 'wt-config'));
    setGlobalConfig(
      {
        worktree_path: '../',
        base_branch: 'HEAD',
        setup_commands: [],
        ide: 'zed',
        ide_open_args: [],
        agent_command: 'echo agent',
      },
      wtStore,
    );

    const deps = buildDeps(wtStore);
    const promise = dispatchTask(mobileTask, deps);
    // The agent success path waits CLEANUP_DELAY_MS before cleanup.
    await vi.runAllTimersAsync();
    await promise;

    // real dispatch success path: relabelled Ready -> Working, no error comment.
    expect(deps.api.updated).toEqual([
      { id: 'm1', labels: ['📱 Overload Mobile', 'Agent Working'] },
    ]);
    expect(deps.api.comments).toEqual([]);

    // real worktree actually created by the real prepareWorktree via the
    // in-process dispatch -> runAgent chain:
    const wtPath = path.join(tmpDir, 'my-repo-agent-mobile-crash-m1');
    expect(existsSync(wtPath)).toBe(true);
    expect(
      execSync('git worktree list', { cwd: repoDir }).toString(),
    ).toContain(wtPath);
  });

  it('labels the task Agent Error when the worktree is created but the agent never starts', async () => {
    const wtStore = createWtStore(path.join(tmpDir, 'wt-config'));
    // A non-Zed IDE creates/opens the worktree but never starts an agent. The
    // daemon must treat that as an error, not a false "Agent Working".
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

    const deps = buildDeps(wtStore);
    await dispatchTask(mobileTask, deps);

    // Not started -> Agent Error label (Ready kept for retry) + explanatory
    // comment carrying the reason.
    const errored = deps.api.updated.at(-1);
    expect(errored?.labels).toContain('Agent Error');
    expect(errored?.labels).not.toContain('Agent Working');
    expect(deps.api.comments.at(-1)?.content).toContain('requires Zed');

    // The real worktree was still created; only the agent start failed.
    const wtPath = path.join(tmpDir, 'my-repo-agent-mobile-crash-m1');
    expect(existsSync(wtPath)).toBe(true);
  });
});
