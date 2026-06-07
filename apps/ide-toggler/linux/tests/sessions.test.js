// Session validation + cwd basename (SPEC §4, §5).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    basenameOfCwd, parseSessionObject, KNOWN_STATUSES,
} from '../gnome-extension/ide-toggler@cestoliv.dev/lib/sessions.js';

test('basenameOfCwd returns the last path component', () => {
    assert.equal(basenameOfCwd('/abs/path/to/project'), 'project');
    assert.equal(basenameOfCwd('/abs/path/to/project/'), 'project'); // trailing slash
    assert.equal(basenameOfCwd('/abs/path/to/project///'), 'project');
    assert.equal(basenameOfCwd('project'), 'project'); // no slashes
    assert.equal(basenameOfCwd('/'), ''); // root has no basename (degenerate)
    assert.equal(basenameOfCwd(''), '');
});

test('parseSessionObject accepts a well-formed session', () => {
    const s = parseSessionObject({pid: 10985, cwd: '/x/mobile', status: 'idle', updatedAt: 1780644168474});
    assert.deepEqual(s, {pid: 10985, cwd: '/x/mobile', status: 'idle', updatedAt: 1780644168474});
});

test('parseSessionObject coerces a numeric-string pid', () => {
    const s = parseSessionObject({pid: '4242', cwd: '/x/y', status: 'busy'});
    assert.equal(s.pid, 4242);
    assert.ok(Number.isNaN(s.updatedAt)); // missing updatedAt -> NaN
});

test('parseSessionObject accepts every known status', () => {
    for (const status of KNOWN_STATUSES)
        assert.equal(parseSessionObject({pid: 1, cwd: '/x', status})?.status, status);
});

test('parseSessionObject rejects unknown / missing status', () => {
    assert.equal(parseSessionObject({pid: 1, cwd: '/x', status: 'paused'}), null);
    assert.equal(parseSessionObject({pid: 1, cwd: '/x'}), null);
});

test('parseSessionObject rejects bad pid / cwd', () => {
    assert.equal(parseSessionObject({pid: 'abc', cwd: '/x', status: 'idle'}), null);
    assert.equal(parseSessionObject({pid: 1, cwd: '', status: 'idle'}), null);
    assert.equal(parseSessionObject({pid: 1, status: 'idle'}), null);
    assert.equal(parseSessionObject(null), null);
    assert.equal(parseSessionObject('not an object'), null);
});
