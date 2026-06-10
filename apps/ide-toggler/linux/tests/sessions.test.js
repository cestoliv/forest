// Session validation + cwd basename (SPEC §4, §5).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    basenameOfCwd, cwdMatchesFolder, KNOWN_STATUSES, latestCodexSessionsByCwd, normalizePath,
    parseCodexRolloutJsonl, parseSessionObject, pseudoPidForCodexThread,
} from '../gnome-extension/ide-toggler@cestoliv.com/lib/sessions.js';

test('basenameOfCwd returns the last path component', () => {
    assert.equal(basenameOfCwd('/abs/path/to/project'), 'project');
    assert.equal(basenameOfCwd('/abs/path/to/project/'), 'project'); // trailing slash
    assert.equal(basenameOfCwd('/abs/path/to/project///'), 'project');
    assert.equal(basenameOfCwd('project'), 'project'); // no slashes
    assert.equal(basenameOfCwd('/'), ''); // root has no basename (degenerate)
    assert.equal(basenameOfCwd(''), '');
});

test('cwdMatchesFolder matches exact basename or ancestor component', () => {
    assert.equal(cwdMatchesFolder('/x/ide-toggler-support-codex', 'ide-toggler-support-codex'), true);
    assert.equal(cwdMatchesFolder('/x/ide-toggler-support-codex/macos', 'ide-toggler-support-codex'), true);
    assert.equal(cwdMatchesFolder('/x/ide-toggler-support-codex-macos', 'ide-toggler-support-codex'), false);
    assert.equal(cwdMatchesFolder('/x/other', 'ide-toggler-support-codex'), false);
});

test('cwdMatchesFolder rejects empty folder', () => {
    assert.equal(cwdMatchesFolder('/x/proj', ''), false);
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

test('normalizePath removes trailing slash except root', () => {
    assert.equal(normalizePath('/x/proj/'), '/x/proj');
    assert.equal(normalizePath('/'), '/');
});

test('pseudoPidForCodexThread is stable and positive', () => {
    const a = pseudoPidForCodexThread('019eac08-863c-7991-a160-2515ebb99fec');
    const b = pseudoPidForCodexThread('019eac08-863c-7991-a160-2515ebb99fec');
    assert.equal(a, b);
    assert.ok(a > 0);
});

test('parseCodexRolloutJsonl: completed turn is idle', () => {
    const s = parseCodexRolloutJsonl(`
{"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-idle","cwd":"/x/proj"}}
{"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-06-09T10:00:02.000Z","type":"event_msg","payload":{"type":"task_complete"}}
`, new Set(['/x/proj']));
    assert.equal(s.cwd, '/x/proj');
    assert.equal(s.status, 'idle');
    assert.equal(s.updatedAt, Date.parse('2026-06-09T10:00:02.000Z'));
});

test('parseCodexRolloutJsonl: active turn is busy', () => {
    const s = parseCodexRolloutJsonl(`
{"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-busy","cwd":"/x/proj"}}
{"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_1"}}
`, new Set(['/x/proj']));
    assert.equal(s.status, 'busy');
});

test('parseCodexRolloutJsonl: pending user input is waiting', () => {
    const s = parseCodexRolloutJsonl(`
{"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-wait","cwd":"/x/proj"}}
{"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call_input"}}
`, new Set(['/x/proj']));
    assert.equal(s.status, 'waiting');
});

test('parseCodexRolloutJsonl: completed user input falls back to busy until task completes', () => {
    const s = parseCodexRolloutJsonl(`
{"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-resumed","cwd":"/x/proj"}}
{"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call_input"}}
{"timestamp":"2026-06-09T10:00:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_input"}}
`, new Set(['/x/proj']));
    assert.equal(s.status, 'busy');
});

test('parseCodexRolloutJsonl: approval request is waiting', () => {
    const s = parseCodexRolloutJsonl(`
{"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-approval","cwd":"/x/proj"}}
{"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_cmd","arguments":"{\\"sandbox_permissions\\":\\"require_escalated\\"}"}}
`, new Set(['/x/proj']));
    assert.equal(s.status, 'waiting');
});

test('parseCodexRolloutJsonl drops stale and malformed rollouts', () => {
    assert.equal(parseCodexRolloutJsonl(`
not json
{"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-stale","cwd":"/x/proj"}}
`, new Set(['/x/other'])), null);
    assert.equal(parseCodexRolloutJsonl('not json', new Set(['/x/proj'])), null);
});

test('latestCodexSessionsByCwd keeps only the most recent rollout per workspace', () => {
    const oldWaiting = {
        pid: 1,
        cwd: '/x/proj',
        status: 'waiting',
        updatedAt: Date.parse('2026-06-09T10:00:02.000Z'),
    };
    const newIdle = {
        pid: 2,
        cwd: '/x/proj/',
        status: 'idle',
        updatedAt: Date.parse('2026-06-09T10:01:02.000Z'),
    };
    assert.deepEqual(latestCodexSessionsByCwd([oldWaiting, newIdle]), [newIdle]);
});
