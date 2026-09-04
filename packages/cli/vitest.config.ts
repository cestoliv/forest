import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __WT_SKILL__: JSON.stringify(
      readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8'),
    ),
  },
  test: {
    include: ['src/**/*.test.ts'],
    // The e2e tests shell out to real git (clone, worktree add). Those run
    // past the 5s default under full-suite load, so they fail at random. The
    // same holds for the setup hooks that build those repos, which the 10s
    // hookTimeout default cuts off.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
