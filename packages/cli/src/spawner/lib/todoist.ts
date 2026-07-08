export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  labels: string[];
  added_at: string;
}

export interface TodoistLabel {
  id: string;
  name: string;
}

export interface TodoistApi {
  listTasksByLabel(name: string): Promise<TodoistTask[]>;
  listLabels(): Promise<TodoistLabel[]>;
  updateTaskLabels(taskId: string, labels: string[]): Promise<void>;
  addComment(taskId: string, content: string): Promise<void>;
}

const DEFAULT_BASE = 'https://api.todoist.com/api/v1';

export function buildTaskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${id}`;
}

interface Page<T> {
  results: T[];
  next_cursor: string | null;
}

export class TodoistClient implements TodoistApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = DEFAULT_BASE,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`Todoist ${method} ${path} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const url: string = cursor
        ? `${path}${sep}cursor=${encodeURIComponent(cursor)}`
        : path;
      const page = await this.request<Page<T>>('GET', url);
      out.push(...page.results);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }

  listTasksByLabel(name: string): Promise<TodoistTask[]> {
    return this.paginate<TodoistTask>(
      `/tasks?label=${encodeURIComponent(name)}`,
    );
  }

  listLabels(): Promise<TodoistLabel[]> {
    return this.paginate<TodoistLabel>('/labels');
  }

  async updateTaskLabels(taskId: string, labels: string[]): Promise<void> {
    await this.request('POST', `/tasks/${taskId}`, { labels });
  }

  async addComment(taskId: string, content: string): Promise<void> {
    await this.request('POST', '/comments', { task_id: taskId, content });
  }
}
