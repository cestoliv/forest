// src/lib/ide.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIdeCommand, openIde } from './ide.js';

describe('buildIdeCommand', () => {
  it('builds command with args and path', () => {
    const result = buildIdeCommand('zed', ['-n'], '/path/to/worktree');
    expect(result).toEqual({ cmd: 'zed', args: ['-n', '/path/to/worktree'] });
  });

  it('handles empty args array', () => {
    const result = buildIdeCommand('code', [], '/path/to/worktree');
    expect(result).toEqual({ cmd: 'code', args: ['/path/to/worktree'] });
  });

  it('places all ide_open_args before the path', () => {
    const result = buildIdeCommand('zed', ['--reuse', '--wait'], '/my/path');
    expect(result.args).toEqual(['--reuse', '--wait', '/my/path']);
  });
});

describe('openIde', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns false when ide is empty string', async () => {
    const result = await openIde('', [], '/path');
    expect(result).toBe(false);
  });

  it('returns true on successful spawn', async () => {
    const result = await openIde('echo', [], '/path');
    expect(result).toBe(true);
  });

  it('returns false and warns on stderr when command not found', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const result = await openIde('nonexistent-editor-xyz', [], '/path');
    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not open'),
    );
  });
});
