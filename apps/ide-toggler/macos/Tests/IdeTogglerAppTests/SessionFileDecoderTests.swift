import XCTest
@testable import IdeTogglerApp
@testable import IdeTogglerCore

private struct FixedLiveness: LivenessChecker {
    let alive: Set<Int32>
    func isAlive(pid: Int32) -> Bool { alive.contains(pid) }
}

final class SessionFileDecoderTests: XCTestCase {
    private func writeFixture(_ name: String, _ json: String, dir: URL) throws {
        try json.data(using: .utf8)!.write(to: dir.appendingPathComponent(name))
    }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("ide-toggler-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func test_decodesValidSession() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeFixture("1234.json", """
        {"pid":1234,"sessionId":"s","cwd":"/x/proj","status":"busy",
         "startedAt":1780606800000,"updatedAt":1780606860000}
        """, dir: dir)

        let decoder = SessionFileDecoder(liveness: FixedLiveness(alive: [1234]))
        let result = decoder.loadSessions(fromDirectory: dir)
        XCTAssertEqual(result.sessions, [Session(pid: 1234, cwd: "/x/proj", status: .busy)])
    }

    func test_dropsStaleFile_whenPidNotAlive() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeFixture("999.json", """
        {"pid":999,"sessionId":"s","cwd":"/x/proj","status":"idle",
         "startedAt":1780606800000,"updatedAt":1780606860000}
        """, dir: dir)

        let decoder = SessionFileDecoder(liveness: FixedLiveness(alive: []))  // nothing alive
        XCTAssertTrue(decoder.loadSessions(fromDirectory: dir).sessions.isEmpty)
    }

    func test_skipsUnknownStatus() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeFixture("5.json", """
        {"pid":5,"sessionId":"s","cwd":"/x/proj","status":"banana",
         "startedAt":1780606800000,"updatedAt":1780606860000}
        """, dir: dir)

        let decoder = SessionFileDecoder(liveness: FixedLiveness(alive: [5]))
        XCTAssertTrue(decoder.loadSessions(fromDirectory: dir).sessions.isEmpty)
    }

    func test_ignoresNonJsonFiles() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeFixture("notes.txt", "hello", dir: dir)
        let decoder = SessionFileDecoder(liveness: FixedLiveness(alive: [1]))
        XCTAssertTrue(decoder.loadSessions(fromDirectory: dir).sessions.isEmpty)
    }

    func test_buildsActivityMapFromUpdatedAt() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let updatedAtMillis = 1780607100000
        try writeFixture("7.json", """
        {"pid":7,"sessionId":"s","cwd":"/x/proj","status":"idle",
         "startedAt":1780606800000,"updatedAt":\(updatedAtMillis)}
        """, dir: dir)
        let decoder = SessionFileDecoder(liveness: FixedLiveness(alive: [7]))
        let activity = decoder.loadSessions(fromDirectory: dir).activity
        // Exact-value check catches a seconds-vs-millis scale error.
        XCTAssertEqual(
            activity[7],
            Date(timeIntervalSince1970: Double(updatedAtMillis) / 1000)
        )
    }

    func test_corruptJson_isSkippedNotCrashing() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeFixture("bad.json", "{not json", dir: dir)
        let decoder = SessionFileDecoder(liveness: FixedLiveness(alive: [1]))
        XCTAssertTrue(decoder.loadSessions(fromDirectory: dir).sessions.isEmpty)
    }

    /// Proves the decoder tolerates the FULL real on-disk schema. Keys mirror an
    /// actual ~/.claude/sessions/{pid}.json (read read-only): sessionId, startedAt,
    /// procStart, version, peerProtocol, kind, entrypoint, status, updatedAt,
    /// bridgeSessionId — with integer epoch-millis timestamps.
    func test_decodesFullRealSchema() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        try writeFixture("47995.json", """
        {"pid":47995,"sessionId":"f1f84377-f6ff-4324-be70-025c9026b84e",\
        "cwd":"/Users/me/Development/proj","startedAt":1780482335093,\
        "procStart":"Wed Jun  3 10:25:33 2026","version":"2.1.161",\
        "peerProtocol":1,"kind":"interactive","entrypoint":"cli",\
        "status":"idle","updatedAt":1780607153479,\
        "bridgeSessionId":"session_01RRRuxg9hHvuVC2D7YF6BmJ"}
        """, dir: dir)

        let decoder = SessionFileDecoder(liveness: FixedLiveness(alive: [47995]))
        let result = decoder.loadSessions(fromDirectory: dir)
        XCTAssertEqual(
            result.sessions,
            [Session(pid: 47995, cwd: "/Users/me/Development/proj", status: .idle)]
        )
        XCTAssertEqual(
            result.activity[47995],
            Date(timeIntervalSince1970: Double(1780607153479) / 1000)
        )
    }
}
