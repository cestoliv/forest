import Foundation

/// Supplies the current set of Zed windows (AX adapter in app target).
public protocol WindowSource: AnyObject {
    func currentWindows() -> [ZedWindow]
    /// Called by the source when the window set may have changed.
    var onChange: (() -> Void)? { get set }
    func start()
}

/// Supplies the current set of live sessions + their last-update times.
public protocol SessionSource: AnyObject {
    /// Live, liveness-filtered sessions.
    func currentSessions() -> [Session]
    /// pid -> last updatedAt, for recently-active ordering.
    func activity() -> [Int32: Date]
    var onChange: (() -> Void)? { get set }
    func start()
}

/// Raises/focuses a window by its ZedWindow.id. Only mutating system op allowed.
public protocol WindowRaising: AnyObject {
    func raise(windowID: String)
}

/// Plays the idle chime. No-op when muted is decided by caller.
public protocol ChimePlayer: AnyObject {
    func playChime()
}

/// Persists settings.
public protocol SettingsStore: AnyObject {
    func load() -> Settings
    func save(_ settings: Settings)
}

/// Liveness probe — MUST be implemented with kill(pid, 0) (signal 0, no signal sent).
public protocol LivenessChecker {
    func isAlive(pid: Int32) -> Bool
}
