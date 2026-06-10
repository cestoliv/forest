// Joining sessions to windows, collapsing state, ordering, and transition/blink
// bookkeeping (SPEC §5 and §7). PURE logic — unit-testable under Node. Mirrors
// the macOS Aggregator in Sources/IdeTogglerCore/Aggregator.swift.

import {cwdMatchesFolder} from './sessions.js';

export const ORDER_MODES = ['statusPriority', 'alphabetical', 'recentlyActive'];

// Collapse a window's matched session statuses into one window state (§5).
export function collapseState(matchedStatuses) {
    if (matchedStatuses.length === 0)
        return 'noAgent';
    if (matchedStatuses.includes('waiting'))
        return 'needsAttention';
    if (matchedStatuses.some(s => s === 'busy' || s === 'shell'))
        return 'working';
    return 'idle';
}

export function priorityRank(state) {
    switch (state) {
    case 'needsAttention': return 0;
    case 'working':        return 1;
    case 'idle':           return 2;
    case 'noAgent':        return 3;
    default:               return 4;
    }
}

// Header group for a state; idle + noAgent collapse into the "idle" group (§7).
export function groupForState(state) {
    switch (state) {
    case 'needsAttention': return 'needs';
    case 'working':        return 'working';
    default:               return 'idle';
    }
}

// Join windows to sessions and produce ordered rows. `windows` carry whatever
// fields the caller attached (e.g. a native window handle); only .folder/.id are
// read here, so the handle rides through untouched.
//   windows:  [{ id, folder, ide, badge, ... }]
//   sessions: [{ pid, cwd, status, updatedAt }]
//   activity: Map<pid, updatedAt>
//   orderMode: one of ORDER_MODES
// Returns: [{ window, state, lastActive }]
export function buildRows({windows, sessions, activity, orderMode}) {
    const act = activity ?? new Map();
    const rows = windows.map(w => {
        const matched = sessions.filter(s => cwdMatchesFolder(s.cwd, w.folder));
        const state = collapseState(matched.map(s => s.status));
        let lastActive = -Infinity;
        for (const s of matched) {
            const a = act.get(s.pid);
            if (Number.isFinite(a) && a > lastActive)
                lastActive = a;
        }
        return {window: w, state, lastActive};
    });

    const byFolder = (a, b) =>
        a.window.folder.toLowerCase().localeCompare(b.window.folder.toLowerCase());

    if (orderMode === 'alphabetical') {
        rows.sort(byFolder);
    } else if (orderMode === 'recentlyActive') {
        rows.sort((a, b) => {
            const ax = a.lastActive > -Infinity;
            const bx = b.lastActive > -Infinity;
            if (ax && bx)
                return b.lastActive - a.lastActive;
            if (ax)
                return -1;
            if (bx)
                return 1;
            return byFolder(a, b);
        });
    } else {
        rows.sort((a, b) => {
            const ra = priorityRank(a.state), rb = priorityRank(b.state);
            if (ra !== rb)
                return ra - rb;
            return byFolder(a, b);
        });
    }
    return rows;
}

// Compact-mode row selection (mirrors macOS StatusAggregatorStore.compactRow):
// the most-recently-active needs-attention row, else the most-recently-active row.
export function compactRow(rows) {
    const mostRecent = rs => {
        let best = null, bestT = -Infinity;
        for (const r of rs) {
            if (r.lastActive > bestT) {
                bestT = r.lastActive;
                best = r;
            }
        }
        return best;
    };
    const needs = rows.filter(r => r.state === 'needsAttention');
    if (needs.length)
        return mostRecent(needs) ?? needs[0];
    return mostRecent(rows) ?? rows[0] ?? null;
}

// Window ids that just went working -> the quiet idle group (the §5 transition
// cue trigger). Codex can disappear as a live session immediately after writing
// task completion, which surfaces as noAgent rather than a literal idle session.
//   prevStates, newStates: Map<windowId, state>
export function detectTransitions(prevStates, newStates) {
    const transitions = [];
    for (const [id, state] of newStates) {
        if ((state === 'idle' || state === 'noAgent') && prevStates.get(id) === 'working')
            transitions.push(id);
    }
    return transitions;
}

// Next set of blinking window ids: keep existing blinkers that are still in the
// quiet idle group, but a fresh batch of transitions replaces them entirely.
export function nextBlinkSet(currentBlinking, rows, transitions) {
    const quietIds = new Set(
        rows.filter(r => r.state === 'idle' || r.state === 'noAgent').map(r => r.window.id));
    let next = new Set([...currentBlinking].filter(id => quietIds.has(id)));
    if (transitions.length)
        next = new Set(transitions);
    return next;
}
