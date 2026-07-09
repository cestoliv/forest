import type { RouteRule } from './config.js';

/**
 * Return the first rule matching the project (and whose required labels are all
 * present), or null. Returns the whole rule — not just `path` — so callers can
 * read per-route fields like `ide`.
 */
export function resolveRoute(
  rules: RouteRule[],
  projectId: string,
  labelIds: string[],
): RouteRule | null {
  const labelSet = new Set(labelIds);
  for (const rule of rules) {
    if (rule.project !== projectId) continue;
    const required = rule.labels ?? [];
    if (required.every((id) => labelSet.has(id))) return rule;
  }
  return null;
}
