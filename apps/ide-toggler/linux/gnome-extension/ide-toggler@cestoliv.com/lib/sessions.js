// Agent session model (SPEC §4). PURE logic — file I/O, PID-liveness, and
// process-cwd checks live in extension.js; this module validates/normalizes
// decoded sessions and provides helpers used for matching (§5).

export const KNOWN_STATUSES = new Set(['busy', 'shell', 'waiting', 'idle']);

// basename(cwd), tolerating a trailing slash (used by the §5 match rule).
export function basenameOfCwd(cwd) {
    let trimmed = cwd || '';
    while (trimmed.length > 1 && trimmed.endsWith('/'))
        trimmed = trimmed.slice(0, -1);
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function cwdMatchesFolder(cwd, folder) {
    if (typeof folder !== 'string' || !folder.length)
        return false;
    if (basenameOfCwd(cwd) === folder)
        return true;
    return normalizePath(cwd).split('/').includes(folder);
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

export function normalizePath(path) {
    let trimmed = path || '';
    while (trimmed.length > 1 && trimmed.endsWith('/'))
        trimmed = trimmed.slice(0, -1);
    return trimmed;
}

export function pseudoPidForCodexThread(threadId) {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < threadId.length; i++) {
        hash ^= threadId.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    const positive = hash & 0x7fffffff;
    return positive === 0 ? 1 : positive;
}

function isUserBlockingCodexCall(payload) {
    const name = payload?.name;
    if (typeof name !== 'string')
        return false;
    if (name === 'request_user_input')
        return true;
    if (name.toLowerCase().includes('approval'))
        return true;
    if (name !== 'exec_command' || typeof payload.arguments !== 'string')
        return false;
    return payload.arguments.includes('require_escalated');
}

// Parse one Codex rollout JSONL file into the same session shape as Claude:
// {pid, cwd, status, updatedAt}. Codex keeps historical rollout files, so callers
// pass the live Codex cwd set and stale workspaces are dropped here.
export function parseCodexRolloutJsonl(text, liveWorkspaces = new Set()) {
    const live = new Set([...liveWorkspaces].map(normalizePath));
    let threadId = null;
    let cwd = null;
    let latestTimestamp = NaN;
    let lastTaskStarted = NaN;
    let lastTaskComplete = NaN;
    const pendingUserCalls = new Map();

    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        } catch (_e) {
            continue;
        }

        const timestamp = Date.parse(obj.timestamp);
        if (Number.isFinite(timestamp))
            latestTimestamp = Number.isFinite(latestTimestamp) ? Math.max(latestTimestamp, timestamp) : timestamp;

        const payload = obj.payload;
        if (!payload || typeof payload !== 'object')
            continue;

        if (obj.type === 'session_meta') {
            if (typeof payload.id === 'string')
                threadId = payload.id;
            if (typeof payload.cwd === 'string')
                cwd = payload.cwd;
        } else if (obj.type === 'event_msg') {
            if (payload.type === 'task_started')
                lastTaskStarted = Number.isFinite(timestamp) ? timestamp : latestTimestamp;
            else if (payload.type === 'task_complete') {
                lastTaskComplete = Number.isFinite(timestamp) ? timestamp : latestTimestamp;
                pendingUserCalls.clear();
            }
        } else if (obj.type === 'response_item') {
            if (payload.type === 'function_call') {
                if (isUserBlockingCodexCall(payload) && typeof payload.call_id === 'string') {
                    const callTime = Number.isFinite(timestamp) ? timestamp : latestTimestamp;
                    if (Number.isFinite(callTime))
                        pendingUserCalls.set(payload.call_id, callTime);
                }
            } else if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
                pendingUserCalls.delete(payload.call_id);
            }
        }
    }

    if (!threadId || !cwd)
        return null;
    if (!live.has(normalizePath(cwd)))
        return null;

    const unresolvedUserCall = [...pendingUserCalls.values()].some(callTime =>
        !Number.isFinite(lastTaskComplete) || callTime > lastTaskComplete);

    let status = 'idle';
    if (unresolvedUserCall)
        status = 'waiting';
    else if (Number.isFinite(lastTaskStarted) &&
             (!Number.isFinite(lastTaskComplete) || lastTaskStarted > lastTaskComplete))
        status = 'busy';

    return {
        pid: pseudoPidForCodexThread(threadId),
        cwd,
        status,
        updatedAt: latestTimestamp,
    };
}

export function latestCodexSessionsByCwd(sessions) {
    const byCwd = new Map();
    for (const session of sessions) {
        const key = normalizePath(session.cwd);
        const existing = byCwd.get(key);
        const existingTime = existing && Number.isFinite(existing.updatedAt) ? existing.updatedAt : -Infinity;
        const sessionTime = Number.isFinite(session.updatedAt) ? session.updatedAt : -Infinity;
        if (!existing || sessionTime > existingTime)
            byCwd.set(key, session);
    }
    return [...byCwd.values()];
}
