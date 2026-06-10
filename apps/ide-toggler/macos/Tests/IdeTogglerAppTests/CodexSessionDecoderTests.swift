import XCTest
@testable import IdeTogglerApp
@testable import IdeTogglerCore

final class CodexSessionDecoderTests: XCTestCase {
    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ide-toggler-codex-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func writeRollout(_ jsonl: String, dir: URL, name: String = "rollout.jsonl") throws {
        try jsonl.data(using: .utf8)!.write(to: dir.appendingPathComponent(name))
    }

    func test_completedTurn_decodesAsIdle() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeRollout("""
        {"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-idle","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
        {"timestamp":"2026-06-09T10:00:02.000Z","type":"event_msg","payload":{"type":"task_complete"}}
        """, dir: dir)

        let result = CodexSessionDecoder().loadSessions(fromDirectory: dir, liveWorkspaces: ["/x/proj"])
        XCTAssertEqual(result.sessions.count, 1)
        XCTAssertEqual(result.sessions[0].cwd, "/x/proj")
        XCTAssertEqual(result.sessions[0].status, .idle)
        XCTAssertNotNil(result.activity[result.sessions[0].pid])
    }

    func test_startedWithoutCompletion_decodesAsBusy() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeRollout("""
        {"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-busy","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
        {"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_1"}}
        """, dir: dir)

        let result = CodexSessionDecoder().loadSessions(fromDirectory: dir, liveWorkspaces: ["/x/proj"])
        XCTAssertEqual(result.sessions.map(\.status), [.busy])
    }

    func test_pendingUserInput_decodesAsWaiting() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeRollout("""
        {"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-wait","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
        {"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call_input"}}
        """, dir: dir)

        let result = CodexSessionDecoder().loadSessions(fromDirectory: dir, liveWorkspaces: ["/x/proj"])
        XCTAssertEqual(result.sessions.map(\.status), [.waiting])
    }

    func test_completedUserInputFallsBackToBusyUntilTaskCompletes() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeRollout("""
        {"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-resumed","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
        {"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call_input"}}
        {"timestamp":"2026-06-09T10:00:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_input"}}
        """, dir: dir)

        let result = CodexSessionDecoder().loadSessions(fromDirectory: dir, liveWorkspaces: ["/x/proj"])
        XCTAssertEqual(result.sessions.map(\.status), [.busy])
    }

    func test_staleRolloutWithoutLiveWorkspace_isDropped() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeRollout("""
        {"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-stale","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_complete"}}
        """, dir: dir)

        let result = CodexSessionDecoder().loadSessions(fromDirectory: dir, liveWorkspaces: ["/x/other"])
        XCTAssertTrue(result.sessions.isEmpty)
    }

    func test_malformedLinesAreSkipped() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeRollout("""
        not json
        {"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-ok","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_complete"}}
        """, dir: dir)

        let result = CodexSessionDecoder().loadSessions(fromDirectory: dir, liveWorkspaces: ["/x/proj"])
        XCTAssertEqual(result.sessions.map(\.status), [.idle])
    }

    func test_sameLiveWorkspaceKeepsOnlyLatestRollout() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeRollout("""
        {"timestamp":"2026-06-09T10:00:00.000Z","type":"session_meta","payload":{"id":"thread-old","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
        {"timestamp":"2026-06-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call_input"}}
        """, dir: dir, name: "old.jsonl")
        try writeRollout("""
        {"timestamp":"2026-06-09T10:01:00.000Z","type":"session_meta","payload":{"id":"thread-new","cwd":"/x/proj"}}
        {"timestamp":"2026-06-09T10:01:01.000Z","type":"event_msg","payload":{"type":"task_started"}}
        {"timestamp":"2026-06-09T10:01:02.000Z","type":"event_msg","payload":{"type":"task_complete"}}
        """, dir: dir, name: "new.jsonl")

        let result = CodexSessionDecoder().loadSessions(fromDirectory: dir, liveWorkspaces: ["/x/proj"])
        XCTAssertEqual(result.sessions.count, 1)
        XCTAssertEqual(result.sessions[0].status, .idle)
    }
}
