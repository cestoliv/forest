// Adapter unit test for runWtAgent — the exact function that replaced the
// old subprocess `wt agent` call with an in-process call to
// `../../wt/agent-api.js`'s `runAgent`. Hermetic: `runAgent` is mocked here
// so this test only proves the arg-mapping/catch wiring of the adapter, not
// the real worktree flow (that's covered end-to-end in dispatch.e2e.test.ts
// and src/wt/agent-api.e2e.test.ts).
import { describe, expect, it, vi } from 'vitest';

const runAgentMock = vi.fn();
vi.mock('../../wt/agent-api.js', () => ({
  runAgent: runAgentMock,
}));

describe('runWtAgent (adapter)', () => {
  it('calls runAgent exactly once with the mapped args and returns its result', async () => {
    const { runWtAgent } = await import('./dispatch.js');
    runAgentMock.mockResolvedValueOnce({ ok: true, output: 'done' });

    const res = await runWtAgent('br', 'pr', '/repo');

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledWith({
      repoPath: '/repo',
      branch: 'br',
      prompt: 'pr',
    });
    expect(res).toEqual({ ok: true, output: 'done' });
  });

  it('forwards the per-route ide to runAgent', async () => {
    const { runWtAgent } = await import('./dispatch.js');
    runAgentMock.mockResolvedValueOnce({ ok: true, output: 'done' });

    await runWtAgent('br', 'pr', '/repo', 'orca');

    expect(runAgentMock).toHaveBeenCalledWith({
      repoPath: '/repo',
      branch: 'br',
      prompt: 'pr',
      ide: 'orca',
    });
  });

  it('resolves to { ok:false } instead of throwing when runAgent rejects', async () => {
    const { runWtAgent } = await import('./dispatch.js');
    runAgentMock.mockRejectedValueOnce(new Error('kaboom'));

    const res = await runWtAgent('br', 'pr', '/repo');

    expect(res.ok).toBe(false);
    expect(res.output).toContain('kaboom');
  });
});
