// Join / collapse / order / transition logic (SPEC §5, §7). Mirrors the macOS
// Aggregator tests.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    collapseState, priorityRank, groupForState, ORDER_MODES,
    buildRows, compactRow, detectTransitions, nextBlinkSet,
} from '../gnome-extension/ide-toggler@cestoliv.com/lib/aggregator.js';
import {win, session} from './helpers.js';

// --- collapseState (§5 priority) --------------------------------------------
test('collapseState: no sessions -> noAgent', () => {
    assert.equal(collapseState([]), 'noAgent');
});
test('collapseState: any waiting -> needsAttention (wins over busy)', () => {
    assert.equal(collapseState(['idle', 'busy', 'waiting']), 'needsAttention');
});
test('collapseState: busy or shell -> working', () => {
    assert.equal(collapseState(['idle', 'busy']), 'working');
    assert.equal(collapseState(['shell']), 'working');
});
test('collapseState: all idle -> idle', () => {
    assert.equal(collapseState(['idle', 'idle']), 'idle');
});

// --- ranks / groups ---------------------------------------------------------
test('priorityRank orders needs < working < idle < noAgent', () => {
    assert.ok(priorityRank('needsAttention') < priorityRank('working'));
    assert.ok(priorityRank('working') < priorityRank('idle'));
    assert.ok(priorityRank('idle') < priorityRank('noAgent'));
});
test('groupForState collapses idle + noAgent into idle', () => {
    assert.equal(groupForState('needsAttention'), 'needs');
    assert.equal(groupForState('working'), 'working');
    assert.equal(groupForState('idle'), 'idle');
    assert.equal(groupForState('noAgent'), 'idle');
});

// --- buildRows: matching (§5) -----------------------------------------------
test('buildRows matches a session to a window by basename(cwd) == folder', () => {
    const rows = buildRows({
        windows: [win('zed-win-1', 'mobile')],
        sessions: [session(1, '/home/me/code/mobile', 'busy')],
        activity: new Map(),
        orderMode: 'statusPriority',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'working');
});

test('buildRows leaves an unmatched window at noAgent', () => {
    const rows = buildRows({
        windows: [win('zed-win-1', 'mobile')],
        sessions: [session(1, '/x/other', 'busy')],
        activity: new Map(),
        orderMode: 'statusPriority',
    });
    assert.equal(rows[0].state, 'noAgent');
});

test('buildRows matches a nested session cwd to the project root window', () => {
    const rows = buildRows({
        windows: [win('zed-win-1', 'ide-toggler-support-codex')],
        sessions: [session(1, '/Users/me/Development/ide-toggler-support-codex/macos', 'waiting')],
        activity: new Map([[1, 500]]),
        orderMode: 'statusPriority',
    });
    assert.equal(rows[0].state, 'needsAttention');
    assert.equal(rows[0].lastActive, 500);
});

test('buildRows: same folder open in two editors matches both windows', () => {
    const rows = buildRows({
        windows: [win('zed-win-1', 'mobile', 'zed'), win('vscode-win-2', 'mobile', 'vscode')],
        sessions: [session(1, '/x/mobile', 'waiting')],
        activity: new Map(),
        orderMode: 'alphabetical',
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.state === 'needsAttention'));
});

test('buildRows combines Claude and Codex sessions with existing priority', () => {
    const rows = buildRows({
        windows: [win('zed-win-1', 'mobile')],
        sessions: [
            session(1, '/x/mobile', 'idle'),
            session(2, '/x/mobile', 'busy'),
        ],
        activity: new Map([[1, 100], [2, 200]]),
        orderMode: 'statusPriority',
    });
    assert.equal(rows[0].state, 'working');
    assert.equal(rows[0].lastActive, 200);
});

// --- buildRows: ordering (§7) -----------------------------------------------
test('statusPriority orders by state rank then folder name', () => {
    const rows = buildRows({
        windows: [win('w-idle', 'zeta'), win('w-needs', 'alpha'), win('w-work', 'beta')],
        sessions: [
            session(1, '/x/alpha', 'waiting'),
            session(2, '/x/beta', 'busy'),
            session(3, '/x/zeta', 'idle'),
        ],
        activity: new Map(),
        orderMode: 'statusPriority',
    });
    assert.deepEqual(rows.map(r => r.window.folder), ['alpha', 'beta', 'zeta']);
});

test('statusPriority breaks ties alphabetically (case-insensitive)', () => {
    const rows = buildRows({
        windows: [win('a', 'Banana'), win('b', 'apple')],
        sessions: [],
        activity: new Map(),
        orderMode: 'statusPriority',
    });
    assert.deepEqual(rows.map(r => r.window.folder), ['apple', 'Banana']);
});

test('alphabetical orders purely by folder name', () => {
    const rows = buildRows({
        windows: [win('a', 'gamma'), win('b', 'alpha'), win('c', 'beta')],
        sessions: [session(1, '/x/gamma', 'waiting')], // would be first by priority
        activity: new Map(),
        orderMode: 'alphabetical',
    });
    assert.deepEqual(rows.map(r => r.window.folder), ['alpha', 'beta', 'gamma']);
});

test('recentlyActive sorts by max updatedAt desc, inactive last then alphabetical', () => {
    const activity = new Map([[1, 100], [2, 300]]);
    const rows = buildRows({
        windows: [win('a', 'old'), win('b', 'new'), win('c', 'zzz'), win('d', 'aaa')],
        sessions: [session(1, '/x/old', 'idle'), session(2, '/x/new', 'idle')],
        activity,
        orderMode: 'recentlyActive',
    });
    // new(300) > old(100), then inactive windows alphabetical: aaa, zzz
    assert.deepEqual(rows.map(r => r.window.folder), ['new', 'old', 'aaa', 'zzz']);
});

// --- compactRow -------------------------------------------------------------
test('compactRow prefers the most-recently-active needs-attention row', () => {
    const rows = [
        {window: win('a', 'a'), state: 'needsAttention', lastActive: 10},
        {window: win('b', 'b'), state: 'needsAttention', lastActive: 50},
        {window: win('c', 'c'), state: 'working', lastActive: 99},
    ];
    assert.equal(compactRow(rows).window.folder, 'b');
});

test('compactRow falls back to the most-recently-active row when no needs', () => {
    const rows = [
        {window: win('a', 'a'), state: 'idle', lastActive: 10},
        {window: win('b', 'b'), state: 'working', lastActive: 50},
    ];
    assert.equal(compactRow(rows).window.folder, 'b');
});

test('compactRow returns null on empty input', () => {
    assert.equal(compactRow([]), null);
});

// --- transitions / blink ----------------------------------------------------
test('detectTransitions reports working -> quiet idle-group states', () => {
    const prev = new Map([['a', 'working'], ['b', 'idle'], ['c', 'needsAttention']]);
    const next = new Map([['a', 'idle'], ['b', 'noAgent'], ['c', 'idle']]);
    assert.deepEqual(detectTransitions(prev, next), ['a']);
});

test('detectTransitions reports working -> noAgent', () => {
    const prev = new Map([['a', 'working']]);
    const next = new Map([['a', 'noAgent']]);
    assert.deepEqual(detectTransitions(prev, next), ['a']);
});

test('detectTransitions: a brand-new idle window is not a transition', () => {
    const prev = new Map();
    const next = new Map([['a', 'idle']]);
    assert.deepEqual(detectTransitions(prev, next), []);
});

test('detectTransitions: a brand-new noAgent window is not a transition', () => {
    const prev = new Map();
    const next = new Map([['a', 'noAgent']]);
    assert.deepEqual(detectTransitions(prev, next), []);
});

test('nextBlinkSet keeps existing quiet blinkers and drops non-quiet/gone ones', () => {
    const rows = [
        {window: win('a', 'a'), state: 'idle'},
        {window: win('c', 'c'), state: 'noAgent'},
        {window: win('b', 'b'), state: 'working'},
    ];
    const next = nextBlinkSet(new Set(['a', 'b', 'c', 'gone']), rows, []);
    assert.deepEqual([...next], ['a', 'c']); // b left quiet, gone disappeared
});

test('nextBlinkSet: a fresh transition replaces the blink set entirely', () => {
    const rows = [
        {window: win('a', 'a'), state: 'idle'},
        {window: win('c', 'c'), state: 'idle'},
    ];
    const next = nextBlinkSet(new Set(['a']), rows, ['c']);
    assert.deepEqual([...next], ['c']);
});

test('ORDER_MODES is the canonical list', () => {
    assert.deepEqual(ORDER_MODES, ['statusPriority', 'alphabetical', 'recentlyActive']);
});
