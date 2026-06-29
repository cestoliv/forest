// Elapsed-time formatting for the per-row state timer. Mirrors the macOS
// formatStuckDuration buckets.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {formatDuration} from '../gnome-extension/ide-toggler@cestoliv.com/lib/format.js';

test('formatDuration: seconds only under a minute', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(59_900), '59s');
});

test('formatDuration: minutes and seconds under an hour', () => {
    assert.equal(formatDuration(60_000), '1m 0s');
    assert.equal(formatDuration(5 * 60_000 + 12_000), '5m 12s');
});

test('formatDuration: hours and minutes under a day', () => {
    assert.equal(formatDuration(2 * 3600_000 + 30 * 60_000), '2h 30m');
});

test('formatDuration: days and hours beyond a day', () => {
    assert.equal(formatDuration(3 * 86_400_000 + 4 * 3600_000), '3d 4h');
});

test('formatDuration: negative input clamps to 0s', () => {
    assert.equal(formatDuration(-1000), '0s');
});
