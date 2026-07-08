// Test helpers shared across the Node suite.
import {EDITORS} from '../gnome-extension/ide-toggler@cestoliv.com/lib/editors.js';

// Look up an editor descriptor by IDEKind, so tests can mirror the macOS
// `using: .zed` style.
export function editor(kind) {
    const ed = EDITORS.find(e => e.kind === kind);
    if (!ed)
        throw new Error(`unknown editor kind: ${kind}`);
    return ed;
}

// Build a minimal window record (the shape buildRows consumes).
export function win(id, folder, ide = 'zed', badge = 'ZED') {
    return {id, folder, ide, badge};
}

// Build a session record.
export function session(pid, cwd, status, updatedAt = NaN) {
    return {pid, cwd, status, updatedAt};
}
