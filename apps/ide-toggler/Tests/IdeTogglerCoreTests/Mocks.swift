import Foundation
@testable import IdeTogglerCore

final class MockWindowSource: WindowSource {
    var windows: [ZedWindow]
    var onChange: (() -> Void)?
    init(_ windows: [ZedWindow] = []) { self.windows = windows }
    func currentWindows() -> [ZedWindow] { windows }
    func start() {}
    func emitChange(_ newWindows: [ZedWindow]) { windows = newWindows; onChange?() }
}

final class MockSessionSource: SessionSource {
    var sessions: [Session]
    var activityMap: [Int32: Date]
    var onChange: (() -> Void)?
    init(_ sessions: [Session] = [], activity: [Int32: Date] = [:]) {
        self.sessions = sessions; self.activityMap = activity
    }
    func currentSessions() -> [Session] { sessions }
    func activity() -> [Int32: Date] { activityMap }
    func start() {}
    func emitChange(_ newSessions: [Session], activity: [Int32: Date] = [:]) {
        sessions = newSessions; activityMap = activity; onChange?()
    }
}

/// Records raise calls. NEVER touches a real window.
final class SpyWindowRaiser: WindowRaising {
    private(set) var raised: [String] = []
    func raise(windowID: String) { raised.append(windowID) }
}

final class SpyChimePlayer: ChimePlayer {
    private(set) var playCount = 0
    func playChime() { playCount += 1 }
}

final class InMemorySettingsStore: SettingsStore {
    var settings: Settings
    init(_ settings: Settings = Settings()) { self.settings = settings }
    func load() -> Settings { settings }
    func save(_ s: Settings) { settings = s }
}

/// Deterministic liveness for tests — no real kill() call.
struct StubLiveness: LivenessChecker {
    let alivePids: Set<Int32>
    func isAlive(pid: Int32) -> Bool { alivePids.contains(pid) }
}
