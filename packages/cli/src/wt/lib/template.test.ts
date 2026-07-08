// src/lib/template.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildTemplateVars,
  expandTemplate,
  hasPromptPlaceholder,
} from './template.js';

describe('expandTemplate', () => {
  it('substitutes a single variable (shell-quoted)', () => {
    expect(expandTemplate('claude {{branch}}', { branch: 'feat-x' })).toBe(
      "claude 'feat-x'",
    );
  });

  it('substitutes multiple distinct variables (shell-quoted)', () => {
    expect(
      expandTemplate('{{project}} on {{branch}}', {
        project: 'wt',
        branch: 'feat-x',
      }),
    ).toBe("'wt' on 'feat-x'");
  });

  it('substitutes the same variable repeated (shell-quoted)', () => {
    expect(expandTemplate('{{branch}}-{{branch}}', { branch: 'x' })).toBe(
      "'x'-'x'",
    );
  });

  it('leaves an unknown variable verbatim', () => {
    expect(expandTemplate('a {{unknown}} b', { branch: 'x' })).toBe(
      'a {{unknown}} b',
    );
  });

  it('allows whitespace inside braces', () => {
    expect(expandTemplate('{{ branch }}', { branch: 'x' })).toBe("'x'");
    expect(expandTemplate('{{\tbranch\t}}', { branch: 'x' })).toBe("'x'");
  });

  it('substitutes an empty-string value to empty quotes', () => {
    expect(expandTemplate('[{{branch}}]', { branch: '' })).toBe("['']");
  });

  it('leaves a string with no placeholders unchanged', () => {
    expect(expandTemplate('npm install', { branch: 'x' })).toBe('npm install');
  });

  it('substitutes adjacent placeholders (each shell-quoted)', () => {
    expect(expandTemplate('{{a}}{{b}}', { a: '1', b: '2' })).toBe("'1''2'");
  });

  it('is case-sensitive', () => {
    expect(expandTemplate('{{Branch}}', { branch: 'x' })).toBe('{{Branch}}');
  });

  it('neutralises shell metacharacters in a substituted value', () => {
    // A malicious Todoist title must stay a single inert token, never break out
    // into a second command.
    expect(expandTemplate('echo {{branch}}', { branch: '; rm -rf ~' })).toBe(
      "echo '; rm -rf ~'",
    );
    expect(expandTemplate('echo {{prompt}}', { prompt: '$(whoami)`id`' })).toBe(
      "echo '$(whoami)`id`'",
    );
  });

  it('escapes an embedded single quote so quoting cannot be broken out of', () => {
    // `a'b` -> `'a'\''b'`: closes the quote, escapes the literal ', reopens.
    expect(expandTemplate('echo {{branch}}', { branch: "a'b" })).toBe(
      "echo 'a'\\''b'",
    );
    // The classic break-out attempt: value containing `'; rm -rf ~; echo '`.
    expect(
      expandTemplate('echo {{branch}}', { branch: "'; rm -rf ~; echo '" }),
    ).toBe("echo ''\\''; rm -rf ~; echo '\\'''");
  });

  it('quotes a path with spaces so adjacent concatenation still works', () => {
    expect(expandTemplate('{{path}}/sub', { path: '/a b' })).toBe("'/a b'/sub");
  });
});

describe('hasPromptPlaceholder', () => {
  it('detects a plain {{prompt}}', () => {
    expect(hasPromptPlaceholder('claude -p {{prompt}}')).toBe(true);
  });

  it('detects {{prompt}} with whitespace inside the braces', () => {
    expect(hasPromptPlaceholder('claude {{ prompt }}')).toBe(true);
  });

  it('returns false when there is no {{prompt}}', () => {
    expect(hasPromptPlaceholder('claude --remote-control {{branch}}')).toBe(
      false,
    );
  });

  it('is case-sensitive', () => {
    expect(hasPromptPlaceholder('claude {{Prompt}}')).toBe(false);
  });
});

describe('buildTemplateVars', () => {
  it('maps inputs to the documented keys', () => {
    expect(
      buildTemplateVars({
        branch: 'feat-x',
        repoRoot: '/home/user/myrepo',
        worktreePath: '/home/user/myrepo-feat-x',
      }),
    ).toEqual({
      branch: 'feat-x',
      project: 'myrepo',
      path: '/home/user/myrepo-feat-x',
      repo_root: '/home/user/myrepo',
    });
  });

  it('omits prompt when not provided', () => {
    const vars = buildTemplateVars({
      branch: 'b',
      repoRoot: '/r',
      worktreePath: '/w',
    });
    expect('prompt' in vars).toBe(false);
  });

  it('includes prompt when provided', () => {
    const vars = buildTemplateVars({
      branch: 'b',
      repoRoot: '/r',
      worktreePath: '/w',
      prompt: 'do the thing',
    });
    expect(vars.prompt).toBe('do the thing');
  });
});
