import { describe, expect, it } from 'vitest';
import type { TodoistTask } from '../../spawner/lib/todoist.js';
import { type FinishApi, finishTask, parseTaskFields } from './finish-task.js';
import type { PullRequest } from './forge.js';

describe('parseTaskFields', () => {
  it('reads next and epic from the leading lines', () => {
    expect(
      parseTaskFields('next: a1, b2\nepic: E1\n\nnext: ignored\nBody'),
    ).toEqual({ next: ['a1', 'b2'], epic: 'E1' });
  });
  it('stops at the first other line', () => {
    expect(parseTaskFields('Body first\nnext: a1')).toEqual({ next: [] });
  });
  it('reads CRLF lines and pasted task URLs', () => {
    expect(
      parseTaskFields(
        'next: https://app.todoist.com/app/task/do-it-6hMvpJ6h8pFV8Fg4\r\nepic: E1\r\nBody',
      ),
    ).toEqual({ next: ['6hMvpJ6h8pFV8Fg4'], epic: 'E1' });
  });
  it('reads an empty description as no fields', () => {
    expect(parseTaskFields('')).toEqual({ next: [] });
  });
  it('accepts case and spacing variants', () => {
    expect(parseTaskFields('Next :a1 ,, b2\nEPIC:  E1')).toEqual({
      next: ['a1', 'b2'],
      epic: 'E1',
    });
  });
});

const PR: PullRequest = {
  number: 34,
  title: 'feat',
  url: 'https://github.com/o/r/pull/34',
  state: 'merged',
};
const labels = { ready: 'Agent Ready', working: 'Agent Working' };

function task(id: string, extra: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id,
    content: `Task ${id}`,
    description: '',
    project_id: 'P',
    labels: [],
    added_at: '2026-11-01T00:00:00Z',
    checked: false,
    parent_id: null,
    ...extra,
  };
}

function setup(tasks: TodoistTask[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const comments: { id: string; text: string }[] = [];
  const logs: string[] = [];
  const notes: string[] = [];
  const api: FinishApi = {
    getTask: async (id) => byId.get(id) ?? null,
    closeTask: async (id) => {
      const t = byId.get(id);
      if (t) t.checked = true;
    },
    updateTaskLabels: async (id, l) => {
      const t = byId.get(id);
      if (t) t.labels = l;
    },
    addComment: async (id, text) => {
      comments.push({ id, text });
    },
    listTasksByProject: async (p) =>
      tasks.filter((t) => t.project_id === p && !t.checked),
  };
  const run = (id: string) =>
    finishTask(id, PR, {
      api,
      labels,
      log: (m) => logs.push(m),
      notify: (m) => notes.push(m),
    });
  return { byId, comments, logs, notes, run };
}

describe('finishTask', () => {
  it('completes the task, keeps other labels, and comments the PR', async () => {
    const s = setup([task('T', { labels: ['Agent Working', 'Feature'] })]);
    await s.run('T');
    expect(s.byId.get('T')).toMatchObject({
      checked: true,
      labels: ['Feature'],
    });
    expect(s.comments).toEqual([
      { id: 'T', text: 'Merged in PR #34 https://github.com/o/r/pull/34' },
    ]);
  });

  it('marks each open next task Agent Ready, keeping its labels', async () => {
    const s = setup([
      task('T', { description: 'next: N1, N2' }),
      task('N1', { labels: ['Backend'] }),
      task('N2'),
    ]);
    await s.run('T');
    expect(s.byId.get('N1')?.labels).toEqual(['Backend', 'Agent Ready']);
    expect(s.byId.get('N2')?.labels).toEqual(['Agent Ready']);
  });

  it('warns and comments when a next task is missing or completed', async () => {
    const s = setup([
      task('T', { description: 'next: GONE, DONE' }),
      task('DONE', { checked: true }),
    ]);
    await s.run('T');
    expect(s.logs.join('\n')).toMatch(/GONE is missing/);
    expect(s.logs.join('\n')).toMatch(/DONE is already completed/);
    expect(s.comments.at(-1)).toMatchObject({ id: 'T' });
    expect(s.comments.at(-1)?.text).toMatch(/GONE is missing[\s\S]*DONE/);
    expect(s.byId.get('DONE')?.labels).toEqual([]);
  });

  it('is idempotent on a completed task: no re-close, next still released', async () => {
    const s = setup([
      task('T', { checked: true, description: 'next: N1, N2' }),
      task('N1'),
      task('N2', { labels: ['Agent Working'] }),
    ]);
    await s.run('T');
    expect(s.comments).toEqual([]);
    expect(s.byId.get('N1')?.labels).toEqual(['Agent Ready']);
    expect(s.byId.get('N2')?.labels).toEqual(['Agent Working']);
    await s.run('T');
    expect(s.byId.get('N1')?.labels).toEqual(['Agent Ready']);
  });

  it('closes the epic, comments and notifies when nothing open belongs to it', async () => {
    const s = setup([
      task('T', { description: 'epic: E' }),
      task('E', { project_id: 'EP' }),
      task('OTHER', { project_id: 'EP' }),
    ]);
    await s.run('T');
    expect(s.byId.get('E')?.checked).toBe(true);
    expect(s.comments.some((c) => c.id === 'E')).toBe(true);
    expect(s.notes).toEqual(['Epic done: Task E']);
  });

  it('keeps the epic open while a subtask or an epic: task is open', async () => {
    const sub = setup([
      task('T', { description: 'epic: E' }),
      task('E'),
      task('S', { parent_id: 'E' }),
    ]);
    await sub.run('T');
    expect(sub.byId.get('E')?.checked).toBe(false);

    const sibling = setup([
      task('T', { description: 'epic: E' }),
      task('E'),
      task('U', { description: 'epic: E\nmore' }),
    ]);
    await sibling.run('T');
    expect(sibling.byId.get('E')?.checked).toBe(false);
    expect(sibling.notes).toEqual([]);
  });

  it('reports a missing epic on the pruned task', async () => {
    const s = setup([task('T', { description: 'epic: E' })]);
    await s.run('T');
    expect(s.comments.at(-1)?.text).toMatch(/epic E is missing/);
  });

  it('logs and stops when the task does not exist', async () => {
    const s = setup([]);
    await s.run('T');
    expect(s.logs.join('')).toMatch(/task T not found/);
    expect(s.comments).toEqual([]);
  });
});
