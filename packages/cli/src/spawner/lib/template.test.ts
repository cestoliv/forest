import { describe, expect, it } from 'vitest';
import { makeTask } from '../test-utils.js';
import { renderTemplate } from './template.js';

describe('renderTemplate', () => {
  const task = makeTask({
    id: 'X1',
    content: 'Fix login',
    description: 'It loops',
    project_id: 'P9',
  });

  it('renders the default url template', () => {
    expect(renderTemplate("Let's tackle this task {{url}}", task)).toBe(
      "Let's tackle this task https://app.todoist.com/app/task/X1",
    );
  });

  it('renders every placeholder', () => {
    const tpl = '{{title}}|{{id}}|{{description}}|{{projectId}}|{{url}}';
    expect(renderTemplate(tpl, task)).toBe(
      'Fix login|X1|It loops|P9|https://app.todoist.com/app/task/X1',
    );
  });

  it('leaves unknown placeholders untouched', () => {
    expect(renderTemplate('hi {{bogus}}', task)).toBe('hi {{bogus}}');
  });
});
