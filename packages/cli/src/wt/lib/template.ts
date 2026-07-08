// src/lib/template.ts
import path from 'node:path';

/**
 * Expand `{{var}}` placeholders in `template` using `vars`. Whitespace inside
 * the braces is allowed and ignored (`{{ branch }}` == `{{branch}}`); names are
 * case-sensitive. An unknown/absent variable is left verbatim (pass-through),
 * never expanded to empty. Values are inserted raw (no shell-escaping).
 */
export function expandTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
    Object.hasOwn(vars, name) ? vars[name] : match,
  );
}

/**
 * True when `template` contains a `{{prompt}}` placeholder (whitespace inside
 * the braces allowed, case-sensitive). Used by the agent flow to decide whether
 * the plan prompt should be substituted in place rather than auto-appended.
 */
export function hasPromptPlaceholder(template: string): boolean {
  return /\{\{\s*prompt\s*\}\}/.test(template);
}

/**
 * Build the template variable map for a worktree. `prompt` is included only
 * when provided (agent flow); the other keys are always present.
 */
export function buildTemplateVars(input: {
  branch: string;
  repoRoot: string;
  worktreePath: string;
  prompt?: string;
}): Record<string, string> {
  const vars: Record<string, string> = {
    branch: input.branch,
    project: path.basename(input.repoRoot),
    path: input.worktreePath,
    repo_root: input.repoRoot,
  };
  if (input.prompt !== undefined) {
    vars.prompt = input.prompt;
  }
  return vars;
}
