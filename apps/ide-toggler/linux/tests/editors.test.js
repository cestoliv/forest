// Editor catalog + WM_CLASS lookup (SPEC §1). Guards against typos in the
// catalog (the most likely silent failure).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {EDITORS, editorForWmClass} from '../gnome-extension/ide-toggler@cestoliv.com/lib/editors.js';

test('catalog has the three supported editors with stable kinds', () => {
    assert.deepEqual(EDITORS.map(e => e.kind), ['zed', 'vscode', 'jetBrains']);
});

test('each editor carries the expected WM_CLASS list and strategy', () => {
    const byKind = Object.fromEntries(EDITORS.map(e => [e.kind, e]));
    assert.deepEqual(byKind.zed.wmClasses, ['dev.zed.Zed', 'zed']);
    assert.equal(byKind.zed.titleStrategy, 'beforeEmDash');
    assert.deepEqual(byKind.vscode.wmClasses, ['code', 'Code', 'code-insiders', 'code-oss']);
    assert.equal(byKind.vscode.titleStrategy, 'vscodeRootName');
    assert.deepEqual(byKind.jetBrains.wmClasses, ['jetbrains-webstorm']);
    assert.equal(byKind.jetBrains.titleStrategy, 'beforeFirstBracketOrHyphen');
});

test('editorForWmClass matches exact and case-insensitively', () => {
    assert.equal(editorForWmClass('dev.zed.Zed')?.kind, 'zed');
    assert.equal(editorForWmClass('zed')?.kind, 'zed');
    assert.equal(editorForWmClass('Code')?.kind, 'vscode');
    assert.equal(editorForWmClass('code')?.kind, 'vscode');
    assert.equal(editorForWmClass('CODE-INSIDERS')?.kind, 'vscode'); // case-insensitive
    assert.equal(editorForWmClass('jetbrains-webstorm')?.kind, 'jetBrains');
});

test('editorForWmClass returns null for unknown / empty', () => {
    assert.equal(editorForWmClass('firefox'), null);
    assert.equal(editorForWmClass(''), null);
    assert.equal(editorForWmClass(null), null);
    assert.equal(editorForWmClass(undefined), null);
});

test('every editor exposes a badge', () => {
    for (const e of EDITORS)
        assert.ok(e.badge && e.badge.length, `${e.kind} has a badge`);
});
