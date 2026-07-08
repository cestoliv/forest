import { buildTaskUrl, type TodoistTask } from './todoist.js';

export function renderTemplate(template: string, task: TodoistTask): string {
  const values: Record<string, string> = {
    url: buildTaskUrl(task.id),
    title: task.content,
    id: task.id,
    description: task.description,
    projectId: task.project_id,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}
