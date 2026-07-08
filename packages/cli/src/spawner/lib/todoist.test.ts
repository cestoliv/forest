import { describe, expect, it } from 'vitest';
import { createTodoistMock, makeTask } from '../test-utils.js';
import { buildTaskUrl, TodoistClient } from './todoist.js';

const BASE = 'https://api.todoist.com/api/v1';

describe('buildTaskUrl', () => {
  it('builds the app task url', () => {
    expect(buildTaskUrl('6XGgmFVcrG5RRjVr')).toBe(
      'https://app.todoist.com/app/task/6XGgmFVcrG5RRjVr',
    );
  });
});

describe('TodoistClient', () => {
  it('lists tasks filtered by label name', async () => {
    const mock = createTodoistMock({
      tasks: [makeTask({ id: 'a' }), makeTask({ id: 'b', labels: ['other'] })],
    });
    const client = new TodoistClient('tok', mock.fetch, BASE);
    const tasks = await client.listTasksByLabel('Agent Ready');
    expect(tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('lists labels', async () => {
    const mock = createTodoistMock();
    const client = new TodoistClient('tok', mock.fetch, BASE);
    const labels = await client.listLabels();
    expect(labels.find((l) => l.id === '2183654821')?.name).toBe('Agent Ready');
  });

  it('updates a task label set', async () => {
    const mock = createTodoistMock({ tasks: [makeTask({ id: 'a' })] });
    const client = new TodoistClient('tok', mock.fetch, BASE);
    await client.updateTaskLabels('a', ['Agent Working']);
    expect(mock.state.tasks[0].labels).toEqual(['Agent Working']);
  });

  it('adds a comment', async () => {
    const mock = createTodoistMock({ tasks: [makeTask({ id: 'a' })] });
    const client = new TodoistClient('tok', mock.fetch, BASE);
    await client.addComment('a', 'hello');
    expect(mock.state.comments).toEqual([{ task_id: 'a', content: 'hello' }]);
  });

  it('throws on a non-2xx response', async () => {
    const mock = createTodoistMock();
    const client = new TodoistClient('', mock.fetch, BASE); // empty token -> 401
    await expect(client.listLabels()).rejects.toThrow(/401/);
  });
});
