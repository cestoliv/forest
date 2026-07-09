import { runAgent } from '../../wt/agent-api.js';
import { buildBranchName } from './branch.js';
import type { AgentSpawnerConfig } from './config.js';
import { resolveRoute } from './router.js';
import { renderTemplate } from './template.js';
import type { TodoistApi, TodoistTask } from './todoist.js';

export type SpawnAgent = (
  branch: string,
  prompt: string,
  repoPath: string,
  ide?: string,
) => Promise<{ ok: boolean; output: string }>;

export interface DispatchDeps {
  api: TodoistApi;
  config: AgentSpawnerConfig;
  idToName: Map<string, string>;
  nameToId: Map<string, string>;
  spawnAgent: SpawnAgent;
  log: (msg: string) => void;
}

export async function dispatchTask(
  task: TodoistTask,
  deps: DispatchDeps,
): Promise<void> {
  const { api, config, nameToId, spawnAgent, log } = deps;
  const readyName = mustName(nameToId, config.labels.ready, 'ready');
  const workingName = mustName(nameToId, config.labels.working, 'working');
  const errorName = mustName(nameToId, config.labels.error, 'error');

  const labelIds = task.labels
    .map((name) => nameToId.get(name))
    .filter((id): id is string => id !== undefined);

  const rule = resolveRoute(config.rules, task.project_id, labelIds);
  if (!rule) {
    log(`No routing rule for task ${task.id} (project ${task.project_id}).`);
    await api.addComment(
      task.id,
      `agent-spawner: no routing rule matched (project ${task.project_id}). Add a rule or fix labels, then remove the "${errorName}" label to retry.`,
    );
    await api.updateTaskLabels(task.id, addOnce(task.labels, errorName));
    return;
  }
  const { path, ide } = rule;

  const branch = buildBranchName(config.branchPrefix, task.content, task.id);
  const prompt = renderTemplate(config.promptTemplate, task);
  log(
    `Dispatching task ${task.id} -> ${path}${ide ? ` (ide ${ide})` : ''} (branch ${branch}).`,
  );
  let result: { ok: boolean; output: string };
  try {
    result = await spawnAgent(branch, prompt, path, ide);
  } catch (err) {
    result = {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.ok) {
    const next = task.labels.filter((l) => l !== readyName);
    next.push(workingName);
    await api.updateTaskLabels(task.id, next);
    log(`Task ${task.id} dispatched; labelled "${workingName}".`);
    return;
  }

  log(`wt agent failed for task ${task.id}.`);
  await api.addComment(
    task.id,
    `agent-spawner: wt agent failed.\n\n${result.output}`.slice(0, 15000),
  );
  await api.updateTaskLabels(task.id, addOnce(task.labels, errorName));
}

function mustName(
  nameToId: Map<string, string>,
  id: string,
  which: string,
): string {
  for (const [name, labelId] of nameToId) if (labelId === id) return name;
  throw new Error(
    `Label id for "${which}" (${id}) not found in Todoist labels.`,
  );
}

function addOnce(labels: string[], name: string): string[] {
  return labels.includes(name) ? labels : [...labels, name];
}

// Calls wt's agent flow in-process (same package). runAgent already maps
// failures to { ok:false }, but we still guard against an unexpected throw so a
// single bad task can never take down the daemon poll loop.
export const runWtAgent: SpawnAgent = async (branch, prompt, repoPath, ide) => {
  try {
    return await runAgent({ repoPath, branch, prompt, ide });
  } catch (err) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
};
