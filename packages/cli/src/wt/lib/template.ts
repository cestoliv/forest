// src/lib/template.ts
import path from 'node:path';

/**
 * Wrap `value` in POSIX single quotes so a shell treats it as a single literal
 * token, neutralising every metacharacter (`;`, `$(...)`, backticks, spaces,
 * etc.). Embedded single quotes are closed, escaped, and reopened
 * (`'\''`).
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Expand `{{var}}` placeholders in `template` using `vars`. Whitespace inside
 * the braces is allowed and ignored (`{{ branch }}` == `{{branch}}`); names are
 * case-sensitive. An unknown/absent variable is left verbatim (pass-through),
 * never expanded to empty.
 *
 * All three call sites (`setup_commands`, `teardown_commands`, `agent_command`)
 * feed the result to a shell, and `branch`/`prompt` originate from untrusted
 * Todoist input, so every substituted value is POSIX single-quote escaped by
 * default to prevent command injection. Adjacent text still concatenates:
 * `{{path}}/sub` → `'/a b'/sub`, which the shell reads as `/a b/sub`.
 */
export function expandTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
    Object.hasOwn(vars, name) ? shellQuote(vars[name]) : match,
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
