import type { TodoistLabel, TodoistTask } from './lib/todoist.js';

export const FIXTURE_LABELS: TodoistLabel[] = [
  { id: '2183654821', name: 'Agent Ready' },
  { id: '900001', name: 'Agent Working' },
  { id: '900002', name: 'Agent Error' },
  { id: '2183895737', name: '📱 Overload Mobile' },
  { id: '2183895740', name: '💽 Overload Backend' },
];

export interface MockState {
  tasks: TodoistTask[];
  labels: TodoistLabel[];
  comments: { task_id: string; content: string }[];
}

export function createTodoistMock(initial: Partial<MockState> = {}): {
  fetch: typeof fetch;
  state: MockState;
  calls: { method: string; url: string }[];
} {
  const state: MockState = {
    tasks: initial.tasks ?? [],
    labels: initial.labels ?? FIXTURE_LABELS,
    comments: initial.comments ?? [],
  };
  const calls: { method: string; url: string }[] = [];

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url: url.pathname + url.search });

    if (init?.headers) {
      const auth = new Headers(init.headers).get('authorization');
      if (!auth?.startsWith('Bearer '))
        return json({ error: 'unauthorized' }, 401);
    }

    if (method === 'GET' && url.pathname.endsWith('/labels')) {
      return json({ results: state.labels, next_cursor: null });
    }
    if (method === 'GET' && url.pathname.endsWith('/tasks')) {
      const label = url.searchParams.get('label');
      const results = label
        ? state.tasks.filter((t) => t.labels.includes(label))
        : state.tasks;
      return json({ results, next_cursor: null });
    }
    if (method === 'POST' && /\/tasks\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split('/').pop();
      const body = JSON.parse((init?.body as string) ?? '{}');
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return json({ error: 'not found' }, 404);
      if (Array.isArray(body.labels)) task.labels = body.labels;
      return json(task);
    }
    if (method === 'POST' && url.pathname.endsWith('/comments')) {
      const body = JSON.parse((init?.body as string) ?? '{}');
      state.comments.push({ task_id: body.task_id, content: body.content });
      return json({ id: 'c1', content: body.content });
    }
    return json({ error: 'unhandled', path: url.pathname }, 404);
  }) as typeof fetch;

  return { fetch: fetchImpl, state, calls };
}

export function makeTask(over: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id: 't1',
    content: 'Sample task',
    description: '',
    project_id: 'p1',
    labels: ['Agent Ready'],
    added_at: '2025-01-01T00:00:00Z',
    ...over,
  };
}
