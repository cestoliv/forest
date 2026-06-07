import Foundation

public enum StatusMapping {
    /// Decode a raw session status string into a known AgentStatus, or nil.
    public static func agentStatus(fromRaw raw: String) -> AgentStatus? {
        AgentStatus(rawValue: raw)
    }

    /// The WindowState a single session of this status implies (before priority collapse).
    public static func windowState(forSingle status: AgentStatus) -> WindowState {
        switch status {
        case .waiting:        return .needsAttention
        case .busy, .shell:   return .working
        case .idle:           return .idle
        }
    }
}
