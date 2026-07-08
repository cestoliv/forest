import { describe, expect, it } from 'vitest';
import { runAgent } from './agent-api.js';

describe('runAgent', () => {
  it('returns { ok:false } instead of throwing/exiting when the flow throws', async () => {
    const res = await runAgent({
      repoPath: process.cwd(),
      branch: 'x',
      prompt: 'y',
      mode: 'bogus-mode',
    });
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/Invalid mode/);
  });
});
