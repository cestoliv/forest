# ide-toggler — Linux (GNOME Shell extension)

The Linux build is a GNOME Shell extension (GJS). On GNOME/Wayland a normal app
cannot enumerate or raise other apps' windows, so the whole panel runs _inside_
the shell, where `Main.activateWindow` is privileged. See [`../SPEC.md`](../SPEC.md)
for the shared behavioral contract and §9 for the GNOME-only hide-to-top-bar
divergence.

## Layout

```
gnome-extension/ide-toggler@cestoliv.com/
├── extension.js        Orchestrator: enable/disable, window + session watching,
│                       St panel/footer/menu, drag, hide-to-top-bar, DBus, chime.
├── lib/
│   ├── editors.js      Editor catalog + WM_CLASS lookup            (pure)
│   ├── titleParser.js  Title → folder parsing + blocklist          (pure)
│   ├── sessions.js     Claude/Codex session parsing + cwd helpers  (pure)
│   ├── aggregator.js   Join / collapse / order / transition / blink (pure)
│   ├── statusIcons.js  Cairo status icons + looping animations     (gi: St/Clutter/Cairo)
│   └── indicator.js    Top-bar indicator                           (gi: St/PanelMenu)
├── metadata.json
└── stylesheet.css
tests/                  node:test suites over the pure lib/ modules
package.json            { "type": "module", "scripts": { "test": "node --test" } }
```

The `lib/` modules marked **pure** import nothing from `gi://` — that is what makes
them unit-testable under plain Node. The gi-bound modules and `extension.js` only
run inside GNOME Shell.

## Tests

```bash
cd linux
node --test          # or: npm test
```

No GNOME, GJS, or display server required — the suite exercises the pure logic only,
mirroring the macOS `IdeTogglerCore` tests. CI runs this on every push/PR.

## Install (end users)

See the [root README](../README.md#linux-gnome-shell-extension) for the user-facing
install instructions — download the `.shell-extension.zip` from a GitHub Release (or,
once review clears, install from extensions.gnome.org).

## Install / iterate from source (development)

```bash
# Copy the extension into the user extensions dir
cp -r gnome-extension/ide-toggler@cestoliv.com \
   ~/.local/share/gnome-shell/extensions/

gnome-extensions enable ide-toggler@cestoliv.com
```

On **Wayland** the running shell can't hot-reload an extension — log out and back in
(or reboot) to pick up changes. On **X11** you can restart the shell in place with
`Alt+F2` → `r`.

Inspect logs with `journalctl -f -o cat /usr/bin/gnome-shell` and filter for
`ide-toggler`.

## Releasing (maintainers)

The GitHub Release is automated by [`.github/workflows/release.yml`](../.github/workflows/release.yml).
Don't edit the version by hand — just push a `v*` tag:

```bash
git tag v1.2.0
git push origin v1.2.0
```

CI then runs the test suite, injects the tag into `metadata.json` as `version-name`,
packages `ide-toggler@cestoliv.com.shell-extension.zip`, and attaches it to a GitHub
Release.

### Publishing to extensions.gnome.org (manual)

EGO has no reliable automated upload path — both the official `gnome-extensions upload`
CLI and the undocumented web API are currently unstable — and every submission goes
through manual human review regardless. So the EGO step is done by hand, once per
release:

1. Download the `ide-toggler@cestoliv.com.shell-extension.zip` produced by the release
   (from the GitHub Release assets).
2. Upload it at [extensions.gnome.org/upload/](https://extensions.gnome.org/upload/)
   (the first upload also creates the listing — add the description/screenshots there).
3. Wait for a reviewer to approve it; the public listing goes live only after review
   (can take days to weeks). The GitHub Release install path is instant and unaffected.
