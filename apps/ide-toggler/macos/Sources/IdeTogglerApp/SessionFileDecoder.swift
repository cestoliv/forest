import Foundation
import IdeTogglerCore

/// SAFETY: the only process interaction here is kill(pid, 0) (signal 0 = probe,
/// no signal delivered). Never pass a non-zero signal.
public struct PosixLivenessChecker: LivenessChecker {
    public init() {}
    public func isAlive(pid: Int32) -> Bool {
        // kill with signal 0 performs error checking but sends nothing.
        // returns 0 if the process exists and we can signal it; ESRCH if not.
        return kill(pid, 0) == 0 || errno == EPERM  // EPERM => exists but not ours
    }
}

public struct SessionFileDecoder {
    public struct Result {
        public let sessions: [Session]
        public let activity: [Int32: Date]
    }

    private struct Raw: Decodable {
        let pid: Int32
        let cwd: String
        let status: String
        let updatedAt: Date
    }

    private let liveness: LivenessChecker

    public init(liveness: LivenessChecker = PosixLivenessChecker()) {
        self.liveness = liveness
    }

    public func loadSessions(fromDirectory dir: URL) -> Result {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil) else {
            return Result(sessions: [], activity: [:])
        }

        let decoder = JSONDecoder()
        // Real ~/.claude/sessions/{pid}.json store timestamps as integer epoch-millis,
        // not ISO8601 strings. Decode them as milliseconds since 1970.
        decoder.dateDecodingStrategy = .millisecondsSince1970

        var sessions: [Session] = []
        var activity: [Int32: Date] = [:]

        for url in entries where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let raw = try? decoder.decode(Raw.self, from: data) else { continue }
            guard liveness.isAlive(pid: raw.pid) else { continue }            // drop stale
            guard let status = StatusMapping.agentStatus(fromRaw: raw.status) else { continue }
            sessions.append(Session(pid: raw.pid, cwd: raw.cwd, status: status))
            activity[raw.pid] = raw.updatedAt
        }
        return Result(sessions: sessions, activity: activity)
    }
}
