import XCTest
@testable import IdeTogglerCore

final class StatusMappingTests: XCTestCase {
    func test_busy_mapsToBusy() {
        XCTAssertEqual(StatusMapping.agentStatus(fromRaw: "busy"), .busy)
    }
    func test_shell_mapsToShell() {
        XCTAssertEqual(StatusMapping.agentStatus(fromRaw: "shell"), .shell)
    }
    func test_waiting_mapsToWaiting() {
        XCTAssertEqual(StatusMapping.agentStatus(fromRaw: "waiting"), .waiting)
    }
    func test_idle_mapsToIdle() {
        XCTAssertEqual(StatusMapping.agentStatus(fromRaw: "idle"), .idle)
    }
    func test_unknown_returnsNil() {
        XCTAssertNil(StatusMapping.agentStatus(fromRaw: "garbage"))
    }
    func test_isCaseSensitiveToClaudeContract() {
        // Claude writes lowercase; uppercase is not a known value.
        XCTAssertNil(StatusMapping.agentStatus(fromRaw: "BUSY"))
    }

    // Collapse AgentStatus -> contribution toward WindowState
    func test_busyContributesWorking() {
        XCTAssertEqual(StatusMapping.windowState(forSingle: .busy), .working)
    }
    func test_shellContributesWorking() {
        XCTAssertEqual(StatusMapping.windowState(forSingle: .shell), .working)
    }
    func test_waitingContributesNeedsAttention() {
        XCTAssertEqual(StatusMapping.windowState(forSingle: .waiting), .needsAttention)
    }
    func test_idleContributesIdle() {
        XCTAssertEqual(StatusMapping.windowState(forSingle: .idle), .idle)
    }
}
