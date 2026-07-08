import XCTest
@testable import IdeTogglerCore

final class AggregatorJoinTests: XCTestCase {
    func test_joinsSessionToWindowByBasenameOfCwd() {
        let win = EditorWindow(id: "w1", folder: "ide-toggler")
        let sess = Session(pid: 1, cwd: "/Users/me/Development/ide-toggler", status: .busy)
        let rows = Aggregator.rows(windows: [win], sessions: [sess], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].state, .working)
    }

    func test_windowWithNoMatchingSession_isNoAgent() {
        let win = EditorWindow(id: "w1", folder: "lonely")
        let rows = Aggregator.rows(windows: [win], sessions: [], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows[0].state, .noAgent)
    }

    func test_sessionWithNoMatchingWindow_isIgnored() {
        // Agent in an unrelated external terminal: no path component matches the window folder.
        let win = EditorWindow(id: "w1", folder: "ide-toggler")
        let orphan = Session(pid: 2, cwd: "/tmp/other-thing", status: .busy)
        let rows = Aggregator.rows(windows: [win], sessions: [orphan], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].state, .noAgent)
    }

    func test_nestedSessionCwd_matchesProjectRootWindow() {
        let win = EditorWindow(id: "w1", folder: "ide-toggler-support-codex")
        let sess = Session(
            pid: 1,
            cwd: "/Users/me/Development/ide-toggler-support-codex/macos",
            status: .waiting)
        let rows = Aggregator.rows(
            windows: [win],
            sessions: [sess],
            mode: .alphabetical,
            now: nil,
            activity: [1: Date(timeIntervalSince1970: 500)])
        XCTAssertEqual(rows[0].state, .needsAttention)
        XCTAssertEqual(rows[0].lastActive, Date(timeIntervalSince1970: 500))
    }

    func test_trailingSlashInCwd_stillMatches() {
        let win = EditorWindow(id: "w1", folder: "ide-toggler")
        let sess = Session(pid: 1, cwd: "/Users/me/ide-toggler/", status: .idle)
        let rows = Aggregator.rows(windows: [win], sessions: [sess], mode: .alphabetical, now: nil)
        XCTAssertEqual(rows[0].state, .idle)
    }
}
