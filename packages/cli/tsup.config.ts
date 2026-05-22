import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  shims: true,
  define: {
    __WT_VERSION__: JSON.stringify(version),
    __WT_SKILL__: JSON.stringify(
      readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8'),
    ),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
});
