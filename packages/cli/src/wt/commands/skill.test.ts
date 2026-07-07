import { afterEach, describe, expect, it, vi } from 'vitest';
import { printSkill } from './skill.js';

describe('printSkill', () => {
  afterEach(() => vi.restoreAllMocks());

  it('outputs the SKILL.md content', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printSkill();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('wt');
    expect(output).toContain('Git Worktree Manager');
  });
});
