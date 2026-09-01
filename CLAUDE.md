# CLAUDE.md

This file provides repo-wide guidance to Claude Code (claude.ai/code) when
working anywhere in the `forest` monorepo. For tool-specific detail, see the
per-package docs linked below — they take precedence over this file for their
own subtree.

## Layout

Plain polyglot monorepo — no workspace tooling (no npm/pnpm/yarn workspaces,
no Lerna/Nx). Each top-level package is self-contained with its own
dependencies, config, and CI job:

```
packages/cli/          @cestoliv/forest — Node/TypeScript, npm package
  src/wt/                the wt CLI (git worktrees + AI agents)
  src/spawner/            the agent-spawner CLI (Todoist daemon)
apps/ide-toggler/       ide-toggler — native app, not an npm package
  macos/                  Swift Package (IdeTogglerCore + IdeTogglerApp)
  linux/                  GNOME Shell extension (GJS) + Node test suite
docs/                   monorepo-level planning docs (e.g. superpowers
                        plan/design docs for the merge itself) — NOT
                        per-tool documentation, see "Where docs live" below
```

## One package, two bins

`packages/cli/` publishes a single npm package, **`@cestoliv/forest`**, whose
`package.json` declares two `bin` entries — `wt` and `agent-spawner` — built
from `src/wt/` and `src/spawner/` respectively into `dist/wt.js` and
`dist/spawner.js`. `npm install -g @cestoliv/forest` installs both commands at
once; there is no separate package for either binary anymore (the tools were
previously two standalone repos — `worktrees` and `agent-spawner` — merged
here with history preserved).

Because they ship from the same package, `agent-spawner` calls into `wt`'s
agent flow **in-process** via `runAgent` (`packages/cli/src/wt/agent-api.ts`)
rather than shelling out to a `wt` binary resolved on `$PATH`. See the
`## agent-spawner` section of `packages/cli/CLAUDE.md` for what that replaced
and why.

`apps/ide-toggler/` is **not** part of `@cestoliv/forest` — it has its own
release pipeline (see below) and is not installed by `npm install -g
@cestoliv/forest`.

## Release model

- **`packages/cli`** — `.github/workflows/publish-cli.yml`. Pushing to `main`
  (when `packages/cli/**` changed) publishes the `package.json` version to npm
  under `latest` via OIDC trusted publishing (skipped if that version already
  exists — bump `version` to release). Adding the `publish-dev` label to a PR
  publishes a throwaway pinned prerelease (`X.Y.Z-pr<N>.g<sha>`) under a
  `pr-<N>` dist-tag and comments the install command on the PR. **Always bump
  `packages/cli/package.json` version in the PR that changes `packages/cli/**`.**
  Without a bump, the merge publishes nothing and the change never reaches npm.
- **`apps/ide-toggler`** — tagged independently, `ide-toggler-v*` (e.g.
  `ide-toggler-v1.2.0`). `.github/workflows/release-ide-toggler.yml` builds and
  tests the GNOME extension, injects the version from the tag, packages it as
  a `.shell-extension.zip`, and attaches it to a GitHub Release. The macOS app
  has no automated release pipeline yet — see `apps/ide-toggler/README.md` for
  the manual build steps (`scripts/make_app.sh`).
- **CI** (`.github/workflows/ci.yml`) is a single path-aware workflow: a
  `changes` job filters on `packages/cli/**` vs `apps/ide-toggler/**`, each
  affected area runs its own job (`cli`; `ide-toggler-macos`;
  `ide-toggler-linux`), and one aggregator job (`ci-ok`) is the single required
  status check — it passes if every job that ran passed (jobs for unchanged
  areas are skipped and count as success).

## Where docs live

- **`wt`** — usage in `packages/cli/README.md`; architecture, commands, and
  dev conventions in `packages/cli/CLAUDE.md`; agent-facing reference in
  `packages/cli/SKILL.md` (embedded into the built binary, printed by
  `wt skill`).
- **`agent-spawner`** — the `## agent-spawner` section of
  `packages/cli/CLAUDE.md` (appended from its original standalone repo's
  CLAUDE.md, updated for the in-process `wt` integration). There is no
  separate `agent-spawner`-only README in this monorepo; usage lives in
  `packages/cli/README.md` alongside `wt`'s, if/when it's added there.
- **`ide-toggler`** — usage and architecture in `apps/ide-toggler/README.md`;
  the cross-platform behavioral contract (source of truth for both the macOS
  and GNOME implementations) in `apps/ide-toggler/SPEC.md`.
- **This file** — conventions that span the whole repo (layout, the
  one-package/two-bins model, release/tag scheme, CI). Keep it in sync when
  any of those change; keep tool-specific detail in the per-package docs
  instead of duplicating it here.
- **`docs/`** at the repo root holds monorepo-level planning artifacts (e.g.
  the plan/design docs for the `worktrees` + `agent-spawner` + `ide-toggler`
  merge itself), not per-tool user or developer documentation.

## Working across packages

- Each package keeps its own lockfile, lint/format config, and test runner —
  don't add root-level tooling that assumes a single toolchain (e.g. a root
  `package.json` workspace) unless explicitly asked.
- A PR can touch either or both packages; CI only runs the jobs for the areas
  that changed (see Release model above).
- Never commit directly to `main`; changes land via PR (see the user's global
  git workflow rules).
- Before you merge a PR touching `packages/cli/**`, check that it bumps the
  package version (see Release model).
