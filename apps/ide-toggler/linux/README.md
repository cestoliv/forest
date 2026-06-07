# ide-toggler — Linux (GNOME Shell extension)

The Linux build is a GNOME Shell extension (GJS). On GNOME/Wayland a normal app
cannot enumerate or raise other apps' windows, so the whole panel runs *inside*
the shell, where `Main.activateWindow` is privileged. See [`../SPEC.md`](../SPEC.md)
for the shared behavioral contract and §9 for the GNOME-only hide-to-top-bar
divergence.

## Layout

```
gnome-extension/ide-toggler@cestoliv.dev/
├── extension.js        Orchestrator: enable/disable, window + session watching,
│                       St panel/footer/menu, drag, hide-to-top-bar, DBus, chime.
├── lib/
│   ├── editors.js      Editor catalog + WM_CLASS lookup            (pure)
│   ├── titleParser.js  Title → folder parsing + blocklist          (pure)
│   ├── sessions.js     Session validation + cwd basename           (pure)
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

## Install / iterate on the target machine

```bash
# Copy the extension into the user extensions dir
cp -r gnome-extension/ide-toggler@cestoliv.dev \
   ~/.local/share/gnome-shell/extensions/

gnome-extensions enable ide-toggler@cestoliv.dev
```

On **Wayland** the running shell can't hot-reload an extension — log out and back in
(or reboot) to pick up changes. On **X11** you can restart the shell in place with
`Alt+F2` → `r`.

Inspect logs with `journalctl -f -o cat /usr/bin/gnome-shell` and filter for
`ide-toggler`.
