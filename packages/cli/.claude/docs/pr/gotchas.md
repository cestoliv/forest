# Gotchas

- **`npm run lint` output is garbled by the user's local RTK proxy.** Call Biome directly: `npx @biomejs/biome check src`. Re-state this in each teammate spawn prompt — they don't inherit it.
- **ESM `.js`-extension imports.** Every internal import uses `.js` even when importing a `.ts` file. Easy to get wrong in new files; verify it on any new module.
- **Vitest is single-fork serial** (`pool: forks`, `singleFork: true`). Don't parallelize or change the pool — it's deliberate.
- **`.zed/` is an untracked local dir.** Don't `git add -A`; stage the feature files explicitly.
- **Three docs, not one.** A user-facing change means updating CLAUDE.md, SKILL.md, AND README.md together. SKILL.md is the one most likely to be forgotten.
