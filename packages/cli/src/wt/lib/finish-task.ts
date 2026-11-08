// src/lib/finish-task.ts
//
// After `wt prune` removes the worktree of a merged agent branch, finish its
// Todoist task and start the next step of the chain. agent-spawner never
// prunes, so the user's own prune is the trigger. Every failure prints one
// line: the worktree is already gone, and the prune must never fail here.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import { parseTaskId } from '../../spawner/lib/branch.js';
import {
  createStore,
  getConfigFilePath,
  loadConfig,
} from '../../spawner/lib/config.js';
import {
  buildTaskUrl,
  TodoistClient,
  type TodoistTask,
} from '../../spawner/lib/todoist.js';
import type { PullRequest, PullRequests } from './forge.js';

export interface TaskFields {
  next: string[];
  epic?: string;
}

/**
 * Read the `next:` and `epic:` lines at the top of a task description. Only
 * the leading lines count: the first other line ends the fields.
 */
export function parseTaskFields(description: string): TaskFields {
  const fields: TaskFields = { next: [] };
  for (const line of description.split(/\r?\n/)) {
    const m = /^\s*(next|epic)\s*:\s*(.*)$/i.exec(line);
    if (!m) break;
    // A pasted task URL ends in `<slug>-<id>`: keep the id.
    const ids = m[2]
      .split(',')
      .map((id) => id.trim().split(/[/-]/).pop() ?? '')
      .filter(Boolean);
    if (m[1].toLowerCase() === 'next') fields.next.push(...ids);
    else fields.epic = ids[0];
  }
  return fields;
}

export type FinishApi = Pick<
  TodoistClient,
  | 'getTask'
  | 'closeTask'
  | 'updateTaskLabels'
  | 'addComment'
  | 'listTasksByProject'
>;

export interface FinishDeps {
  api: FinishApi;
  /** Label names, resolved from the agent-spawner label ids. */
  labels: { ready: string; working: string };
  log: (msg: string) => void;
  notify: (msg: string) => void;
}

/**
 * Complete task `taskId` for merged `pr`, mark each open `next` task Agent
 * Ready, and close the `epic` once nothing open belongs to it. Safe to run
 * twice: a completed task still releases its `next` tasks and its epic, and a
 * `next` task already Ready or Working is left alone.
 */
export async function finishTask(
  taskId: string,
  pr: PullRequest,
  deps: FinishDeps,
): Promise<void> {
  const { api, labels, log } = deps;
  const task = await api.getTask(taskId);
  if (!task) {
    log(pc.yellow(`Todoist: task ${taskId} not found.`));
    return;
  }

  if (!task.checked) {
    await api.updateTaskLabels(
      taskId,
      task.labels.filter((l) => l !== labels.working),
    );
    await api.closeTask(taskId);
    await api.addComment(taskId, `Merged in PR #${pr.number} ${pr.url}`);
    log(pc.green(`✓ Todoist: completed "${task.content}"`));
  }

  const { next, epic } = parseTaskFields(task.description);
  const broken: string[] = [];
  for (const id of next) {
    const n = await api.getTask(id);
    if (!n || n.checked) {
      broken.push(`next task ${id} is ${n ? 'already completed' : 'missing'}`);
      continue;
    }
    if (n.labels.includes(labels.ready) || n.labels.includes(labels.working))
      continue;
    await api.updateTaskLabels(id, [...n.labels, labels.ready]);
    log(pc.green(`→ Todoist: "${n.content}" is ${labels.ready}`));
  }
  if (epic) {
    const problem = await closeEpicIfDone(epic, pr, deps);
    if (problem) broken.push(problem);
  }

  if (broken.length > 0) {
    for (const b of broken) log(pc.yellow(`⚠ Todoist: ${b}.`));
    await api.addComment(
      taskId,
      `wt prune: broken chain.\n${broken.map((b) => `- ${b}`).join('\n')}`,
    );
  }
}

/** Close `epicId` when no open subtask or `epic:` task remains. Returns a problem to report, if any. */
async function closeEpicIfDone(
  epicId: string,
  pr: PullRequest,
  { api, log, notify }: FinishDeps,
): Promise<string | undefined> {
  const epic = await api.getTask(epicId);
  if (!epic) return `epic ${epicId} is missing`;
  if (epic.checked) return undefined;

  const open = await api.listTasksByProject(epic.project_id);
  const belongs = (t: TodoistTask) =>
    t.id !== epicId &&
    (t.parent_id === epicId || parseTaskFields(t.description).epic === epicId);
  if (open.some(belongs)) return undefined;

  await api.closeTask(epicId);
  await api.addComment(
    epicId,
    `All tasks done. The last one merged in PR #${pr.number} ${pr.url}`,
  );
  const msg = `Epic done: ${epic.content}`;
  log(pc.green(`🎉 Todoist: ${msg}`));
  notify(msg);
  return undefined;
}

function notifyMac(msg: string): void {
  if (process.platform !== 'darwin') return;
  // JSON string quoting matches AppleScript's for quotes and backslashes.
  execFile(
    'osascript',
    ['-e', `display notification ${JSON.stringify(msg)} with title "wt"`],
    () => {},
  );
}

/**
 * The prune hook: finish the Todoist task behind `branch` when its PR merged.
 * Does nothing for a branch with no task id or no merged PR, and never throws.
 */
export async function finishPrunedTask(
  branch: string,
  pullRequests: PullRequests | null | undefined,
): Promise<void> {
  const taskId = parseTaskId(branch);
  const pr = pullRequests?.mergedPr;
  if (!taskId || !pr) return;
  try {
    // `createStore` writes a default file when none exists, so check first.
    if (!existsSync(getConfigFilePath())) {
      console.log(pc.dim('Todoist: no agent-spawner config, task left as is.'));
      return;
    }
    const config = loadConfig(createStore());
    const api = new TodoistClient(config.token);
    const names = new Map(
      (await api.listLabels()).map((l) => [l.id, l.name] as const),
    );
    const ready = names.get(config.labels.ready);
    const working = names.get(config.labels.working);
    if (!ready || !working)
      throw new Error('agent-spawner label ids not found');
    await finishTask(taskId, pr, {
      api,
      labels: { ready, working },
      log: console.log,
      notify: notifyMac,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : error;
    console.log(
      pc.yellow(
        `Todoist: stopped (${reason}). Finish ${buildTaskUrl(taskId)} by hand.`,
      ),
    );
  }
}
