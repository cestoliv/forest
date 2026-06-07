// Claude Code session model (SPEC §4). PURE logic — file I/O and PID-liveness
// checks live in extension.js; this module only validates/normalizes a decoded
// session object and provides the cwd-basename helper used for matching (§5).

export const KNOWN_STATUSES = new Set(['busy', 'shell', 'waiting', 'idle']);

// basename(cwd), tolerating a trailing slash (used by the §5 match rule).
export function basenameOfCwd(cwd) {
    let trimmed = cwd || '';
    while (trimmed.length > 1 && trimmed.endsWith('/'))
        trimmed = trimmed.slice(0, -1);
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// Validate a parsed session JSON object into {pid, cwd, status, updatedAt}, or
// null if it is malformed or carries an unknown status. Liveness is checked by
// the caller (a session whose process is dead is dropped there).
export function parseSessionObject(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    const pid = typeof obj.pid === 'number' ? obj.pid : parseInt(obj.pid, 10);
    const cwd = obj.cwd;
    const status = obj.status;
    if (!Number.isFinite(pid) || typeof cwd !== 'string' || !cwd.length)
        return null;
    if (!KNOWN_STATUSES.has(status))
        return null;
    const updatedAt = typeof obj.updatedAt === 'number' ? obj.updatedAt : NaN;
    return {pid, cwd, status, updatedAt};
}
