import type { RouteRule } from './config.js';

export function resolveRoute(
  rules: RouteRule[],
  projectId: string,
  labelIds: string[],
): string | null {
  const labelSet = new Set(labelIds);
  for (const rule of rules) {
    if (rule.project !== projectId) continue;
    const required = rule.labels ?? [];
    if (required.every((id) => labelSet.has(id))) return rule.path;
  }
  return null;
}
