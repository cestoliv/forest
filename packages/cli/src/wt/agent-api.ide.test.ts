// Isolated from agent-api.test.ts (which exercises the real createAgentWorktree
// flow): here we mock ./commands/agent.js to prove runAgent forwards `ide`.
import { describe, expect, it, vi } from 'vitest';

const createAgentWorktreeMock = vi.fn(async () => ({ started: true }));
vi.mock('./commands/agent.js', () => ({
  createAgentWorktree: createAgentWorktreeMock,
}));

describe('runAgent (ide forwarding)', () => {
  it('forwards ide into createAgentWorktree', async () => {
    const { runAgent } = await import('./agent-api.js');
    createAgentWorktreeMock.mockClear();
    await runAgent({
      repoPath: '/repo',
      branch: 'b',
      prompt: 'p',
      ide: 'orca',
    });
    expect(createAgentWorktreeMock).toHaveBeenCalledWith(
      'b',
      'p',
      expect.objectContaining({ repoRoot: '/repo', ide: 'orca' }),
    );
  });

  it('passes ide undefined when unset (wt falls back to config.ide)', async () => {
    const { runAgent } = await import('./agent-api.js');
    createAgentWorktreeMock.mockClear();
    await runAgent({ repoPath: '/repo', branch: 'b', prompt: 'p' });
    expect(createAgentWorktreeMock).toHaveBeenCalledWith(
      'b',
      'p',
      expect.objectContaining({ ide: undefined }),
    );
  });

  it('never sets focus (the daemon must not steal focus on dispatch)', async () => {
    const { runAgent } = await import('./agent-api.js');
    createAgentWorktreeMock.mockClear();
    await runAgent({
      repoPath: '/repo',
      branch: 'b',
      prompt: 'p',
      ide: 'orca',
    });
    const lastCall = createAgentWorktreeMock.mock.calls.at(-1) as
      | unknown[]
      | undefined;
    const opts = lastCall?.[2] as { focus?: boolean } | undefined;
    expect(opts?.focus).toBeUndefined();
  });
});
