import Foundation
import Darwin
import IdeTogglerCore

public protocol CodexLiveWorkspaceProviding {
    func liveWorkspaces() -> Set<String>
}

public struct DarwinCodexProcessScanner: CodexLiveWorkspaceProviding {
    public init() {}

    public func liveWorkspaces() -> Set<String> {
        let initialBytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
        guard initialBytes > 0 else { return [] }

        let initialCount = Int(initialBytes) / MemoryLayout<pid_t>.stride
        var pids = [pid_t](repeating: 0, count: initialCount + 256)
        let actualBytes = pids.withUnsafeMutableBytes {
            proc_listpids(UInt32(PROC_ALL_PIDS), 0, $0.baseAddress, Int32($0.count))
        }
        guard actualBytes > 0 else { return [] }

        var workspaces = Set<String>()
        let count = min(pids.count, Int(actualBytes) / MemoryLayout<pid_t>.stride)
        for pid in pids.prefix(count) where pid > 0 {
            guard processName(pid: pid) == "codex",
                  let cwd = cwdPath(pid: pid) else { continue }
            workspaces.insert(Self.normalizedPath(cwd))
        }
        return workspaces
    }

    private func processName(pid: pid_t) -> String? {
        var name = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        let len = proc_name(pid, &name, UInt32(name.count))
        guard len > 0 else { return nil }
        return String(cString: name)
    }

    private func cwdPath(pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = MemoryLayout<proc_vnodepathinfo>.stride
        let result = withUnsafeMutablePointer(to: &info) { ptr in
            ptr.withMemoryRebound(to: UInt8.self, capacity: size) { raw in
                proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, raw, Int32(size))
            }
        }
        guard result == Int32(size) else { return nil }

        return withUnsafeBytes(of: info.pvi_cdir.vip_path) { rawBuffer -> String? in
            guard let base = rawBuffer.bindMemory(to: CChar.self).baseAddress else { return nil }
            let path = String(cString: base)
            return path.isEmpty ? nil : path
        }
    }

    static func normalizedPath(_ path: String) -> String {
        var trimmed = path
        while trimmed.count > 1 && trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        return trimmed
    }
}

public struct CodexSessionDecoder {
    public struct Result {
        public let sessions: [Session]
        public let activity: [Int32: Date]
    }

    public init() {}

    public func loadSessions(fromDirectory dir: URL, liveWorkspaces: Set<String>) -> Result {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: dir, includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]) else {
            return Result(sessions: [], activity: [:])
        }

        var latestByCwd: [String: Rollout] = [:]
        let normalizedLive = Set(liveWorkspaces.map(DarwinCodexProcessScanner.normalizedPath))

        for case let url as URL in enumerator where url.pathExtension == "jsonl" {
            guard let rollout = parseRollout(at: url, liveWorkspaces: normalizedLive) else {
                continue
            }
            let key = DarwinCodexProcessScanner.normalizedPath(rollout.session.cwd)
            if let existing = latestByCwd[key],
               Self.sortDate(existing.updatedAt) >= Self.sortDate(rollout.updatedAt) {
                continue
            }
            latestByCwd[key] = rollout
        }

        let rollouts = latestByCwd.values
        let sessions = rollouts.map(\.session)
        let activity = rollouts.reduce(into: [Int32: Date]()) { result, rollout in
            if let updatedAt = rollout.updatedAt {
                result[rollout.session.pid] = updatedAt
            }
        }
        return Result(sessions: sessions, activity: activity)
    }

    private static func sortDate(_ date: Date?) -> Date {
        date ?? Date.distantPast
    }

    fileprivate struct Rollout {
        let session: Session
        let updatedAt: Date?
    }

    private func parseRollout(at url: URL, liveWorkspaces: Set<String>) -> Rollout? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return parseRollout(text, liveWorkspaces: liveWorkspaces)
    }

    fileprivate func parseRollout(_ text: String, liveWorkspaces: Set<String>) -> Rollout? {
        let parser = CodexRolloutParser()
        return parser.parse(text, liveWorkspaces: liveWorkspaces)
    }
}

private final class CodexRolloutParser {
    private let isoWithFractional: ISO8601DateFormatter
    private let isoPlain: ISO8601DateFormatter

    init() {
        isoWithFractional = ISO8601DateFormatter()
        isoWithFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        isoPlain = ISO8601DateFormatter()
        isoPlain.formatOptions = [.withInternetDateTime]
    }

    func parse(_ text: String, liveWorkspaces: Set<String>) -> CodexSessionDecoder.Rollout? {
        var threadID: String?
        var cwd: String?
        var latestTimestamp: Date?
        var lastTaskStarted: Date?
        var lastTaskComplete: Date?
        var pendingUserCalls: [String: Date] = [:]

        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = String(line).data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }

            let timestamp = (obj["timestamp"] as? String).flatMap(parseTimestamp)
            if let timestamp {
                latestTimestamp = max(latestTimestamp ?? timestamp, timestamp)
            }

            guard let type = obj["type"] as? String,
                  let payload = obj["payload"] as? [String: Any] else { continue }

            switch type {
            case "session_meta":
                threadID = payload["id"] as? String
                cwd = payload["cwd"] as? String
            case "event_msg":
                switch payload["type"] as? String {
                case "task_started":
                    lastTaskStarted = timestamp ?? latestTimestamp
                case "task_complete":
                    lastTaskComplete = timestamp ?? latestTimestamp
                    pendingUserCalls.removeAll()
                default:
                    break
                }
            case "response_item":
                switch payload["type"] as? String {
                case "function_call":
                    if isUserBlockingCall(payload),
                       let callID = payload["call_id"] as? String,
                       let callTime = timestamp ?? latestTimestamp {
                        pendingUserCalls[callID] = callTime
                    }
                case "function_call_output":
                    if let callID = payload["call_id"] as? String {
                        pendingUserCalls.removeValue(forKey: callID)
                    }
                default:
                    break
                }
            default:
                break
            }
        }

        guard let threadID, let cwd, !cwd.isEmpty else { return nil }
        let normalizedCwd = DarwinCodexProcessScanner.normalizedPath(cwd)
        guard liveWorkspaces.contains(normalizedCwd) else { return nil }

        let unresolvedUserCall = pendingUserCalls.values.contains { callTime in
            guard let lastTaskComplete else { return true }
            return callTime > lastTaskComplete
        }

        let status: AgentStatus
        if unresolvedUserCall {
            status = .waiting
        } else if let lastTaskStarted, (lastTaskComplete == nil || lastTaskStarted > lastTaskComplete!) {
            status = .busy
        } else {
            status = .idle
        }

        let session = Session(pid: Self.pseudoPid(for: threadID), cwd: cwd, status: status)
        return CodexSessionDecoder.Rollout(session: session, updatedAt: latestTimestamp)
    }

    private func parseTimestamp(_ text: String) -> Date? {
        isoWithFractional.date(from: text) ?? isoPlain.date(from: text)
    }

    private func isUserBlockingCall(_ payload: [String: Any]) -> Bool {
        guard let name = payload["name"] as? String else { return false }
        if name == "request_user_input" { return true }
        if name.lowercased().contains("approval") { return true }
        guard name == "exec_command",
              let arguments = payload["arguments"] as? String else { return false }
        return arguments.contains("require_escalated")
    }

    private static func pseudoPid(for threadID: String) -> Int32 {
        var hash: UInt32 = 2_166_136_261
        for byte in threadID.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        let positive = hash & 0x7fff_ffff
        return Int32(positive == 0 ? 1 : positive)
    }
}
