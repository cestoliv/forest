export interface TodoistDue {
  /**
   * `YYYY-MM-DD` for a date-only due date, `YYYY-MM-DDTHH:MM:SS` for a
   * floating time, or the same with a zone suffix for an absolute instant.
   */
  date: string;
}

export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  labels: string[];
  added_at: string;
  due?: TodoistDue | null;
  /** True once the task is completed. */
  checked?: boolean;
  parent_id?: string | null;
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
    /** Resolve null when the resource does not exist (404, or 400 for a malformed id). */
    nullIfMissing = false,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (nullIfMissing && (res.status === 404 || res.status === 400)) {
      return null as T;
    }
    if (!res.ok) {
      throw new Error(`Todoist ${method} ${path} failed: ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
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

  /** The task, open or completed, or null when no task has this id. */
  getTask(taskId: string): Promise<TodoistTask | null> {
    return this.request<TodoistTask | null>(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      true,
    );
  }

  async closeTask(taskId: string): Promise<void> {
    await this.request('POST', `/tasks/${taskId}/close`);
  }

  /** Open tasks of one project. */
  listTasksByProject(projectId: string): Promise<TodoistTask[]> {
    return this.paginate<TodoistTask>(
      `/tasks?project_id=${encodeURIComponent(projectId)}`,
    );
  }
}
