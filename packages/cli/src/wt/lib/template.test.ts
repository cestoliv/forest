// src/lib/template.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildTemplateVars,
  expandTemplate,
  hasPromptPlaceholder,
} from './template.js';

describe('expandTemplate', () => {
  it('substitutes a single variable', () => {
    expect(expandTemplate('claude {{branch}}', { branch: 'feat-x' })).toBe(
      'claude feat-x',
    );
  });

  it('substitutes multiple distinct variables', () => {
    expect(
      expandTemplate('{{project}} on {{branch}}', {
        project: 'wt',
        branch: 'feat-x',
      }),
    ).toBe('wt on feat-x');
  });

  it('substitutes the same variable repeated', () => {
    expect(expandTemplate('{{branch}}-{{branch}}', { branch: 'x' })).toBe(
      'x-x',
    );
  });

  it('leaves an unknown variable verbatim', () => {
    expect(expandTemplate('a {{unknown}} b', { branch: 'x' })).toBe(
      'a {{unknown}} b',
    );
  });

  it('allows whitespace inside braces', () => {
    expect(expandTemplate('{{ branch }}', { branch: 'x' })).toBe('x');
    expect(expandTemplate('{{\tbranch\t}}', { branch: 'x' })).toBe('x');
  });

  it('substitutes an empty-string value to empty', () => {
    expect(expandTemplate('[{{branch}}]', { branch: '' })).toBe('[]');
  });

  it('leaves a string with no placeholders unchanged', () => {
    expect(expandTemplate('npm install', { branch: 'x' })).toBe('npm install');
  });

  it('substitutes adjacent placeholders', () => {
    expect(expandTemplate('{{a}}{{b}}', { a: '1', b: '2' })).toBe('12');
  });

  it('is case-sensitive', () => {
    expect(expandTemplate('{{Branch}}', { branch: 'x' })).toBe('{{Branch}}');
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
