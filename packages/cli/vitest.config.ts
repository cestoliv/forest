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
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
