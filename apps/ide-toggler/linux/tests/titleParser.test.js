// Mirrors macos/Tests/IdeTogglerCoreTests/TitleParserTests.swift — the title->folder
// parsing rules (SPEC §3) and the per-IDE non-project blocklist (SPEC §2.1).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {folderFromTitle} from '../gnome-extension/ide-toggler@cestoliv.dev/lib/titleParser.js';
import {editor} from './helpers.js';

const folder = (title, kind) => folderFromTitle(title, editor(kind));

// --- Zed: "<folder> — <detail>" (em-dash) -----------------------------------
test('zed: takes substring before the em-dash separator', () => {
    assert.equal(folder('ide-toggler — main.swift', 'zed'), 'ide-toggler');
});
test('zed: trims whitespace', () => {
    assert.equal(folder('  my-project   — README.md', 'zed'), 'my-project');
});
test('zed: no separator returns trimmed whole title', () => {
    assert.equal(folder('Untitled', 'zed'), 'Untitled');
});
test('zed: empty title returns null', () => {
    assert.equal(folder('', 'zed'), null);
});
test('zed: whitespace-only title returns null', () => {
    assert.equal(folder('   ', 'zed'), null);
});
test('zed: multiple separators use the first', () => {
    assert.equal(folder('proj — a — b', 'zed'), 'proj');
});

// --- JetBrains/WebStorm: "<project> [<path>] - <file>" ----------------------
test('jetBrains: bracketed path', () => {
    assert.equal(folder('my-project [~/dev/my-project] - src/index.ts', 'jetBrains'), 'my-project');
});
test('jetBrains: no bracket uses the hyphen', () => {
    assert.equal(folder('my-project - file.ts', 'jetBrains'), 'my-project');
});
test('jetBrains: project only returns whole', () => {
    assert.equal(folder('my-project', 'jetBrains'), 'my-project');
});

// --- VSCode: native title "${dirty}${file} — ${rootName}" (project on RIGHT) -
test('vscode: file and folder (real default, the bug repro)', () => {
    assert.equal(folder('.env — mobile', 'vscode'), 'mobile');
});
test('vscode: dirty indicator', () => {
    assert.equal(folder('● App.tsx — my-project', 'vscode'), 'my-project');
});
test('vscode: folder with hyphens (em-dash split preserves hyphens)', () => {
    assert.equal(folder('App.tsx — mobile-eslint-rules', 'vscode'), 'mobile-eslint-rules');
});
test('vscode: folder only, no active editor', () => {
    assert.equal(folder('mobile', 'vscode'), 'mobile');
});
test('vscode: app-name suffix stripped defensively', () => {
    assert.equal(folder('file.ts — my-project — Visual Studio Code', 'vscode'), 'my-project');
});
test('vscode: insiders suffix stripped defensively', () => {
    assert.equal(folder('file.ts — my-project — Visual Studio Code - Insiders', 'vscode'), 'my-project');
});
test('vscode: app name only returns null', () => {
    assert.equal(folder('Visual Studio Code', 'vscode'), null);
});

// Linux window title: " - " separator, app-name suffix present, rootName before it.
test('vscode (linux): active file + project + app name -> project', () => {
    // The exact title observed on Ubuntu (the status-detection bug repro).
    assert.equal(folder('Welcome - Musique - Visual Studio Code', 'vscode'), 'Musique');
});
test('vscode (linux): project + app name, no active editor -> project', () => {
    assert.equal(folder('Musique - Visual Studio Code', 'vscode'), 'Musique');
});
test('vscode (linux): file + project + app name -> project', () => {
    assert.equal(folder('index.js - my-project - Visual Studio Code', 'vscode'), 'my-project');
});
test('vscode (linux): folder with internal hyphens survives " - " split', () => {
    assert.equal(folder('App.tsx - mobile-eslint-rules - Visual Studio Code', 'vscode'), 'mobile-eslint-rules');
});

// --- Non-project chrome rejected (best-effort title blocklist) --------------
test('zed: About / empty project rejected', () => {
    assert.equal(folder('About Zed', 'zed'), null);
    assert.equal(folder('empty project', 'zed'), null);
});
test('vscode: chrome rejected', () => {
    assert.equal(folder('Welcome', 'vscode'), null);
    assert.equal(folder('Get Started', 'vscode'), null);
    assert.equal(folder('Release Notes: 1.123.0', 'vscode'), null);
});
test('jetBrains: chrome rejected', () => {
    assert.equal(folder('About WebStorm', 'jetBrains'), null);
    assert.equal(folder('Open File or Project', 'jetBrains'), null);
    assert.equal(folder('Welcome to WebStorm', 'jetBrains'), null);
});
// Linux chrome titles carry the app-name suffix, so the blocklist must catch the
// parsed rootName (the raw title isn't an exact match).
test('vscode (linux): Welcome screen with app-name suffix is rejected', () => {
    assert.equal(folder('Welcome - Visual Studio Code', 'vscode'), null);
});
test('vscode (linux): Get Started with app-name suffix is rejected', () => {
    assert.equal(folder('Get Started - Visual Studio Code', 'vscode'), null);
});
test('vscode (linux): Welcome tab open in a real project is kept', () => {
    assert.equal(folder('Welcome - Musique - Visual Studio Code', 'vscode'), 'Musique');
});

test('blocklist is per-IDE, does not affect other editors', () => {
    // "Welcome" is VSCode chrome but a valid Zed folder name.
    assert.equal(folder('Welcome', 'zed'), 'Welcome');
    assert.equal(folder('.env — mobile', 'vscode'), 'mobile');
});
