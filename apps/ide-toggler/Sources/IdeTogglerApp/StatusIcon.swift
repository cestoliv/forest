import SwiftUI
import IdeTogglerCore

public enum StatusIcon {
    /// Distinct SF Symbol + color per state.
    public static func symbol(for state: WindowState) -> String {
        switch state {
        case .needsAttention: return "exclamationmark.triangle.fill"
        case .working:        return "gearshape.2.fill"
        case .idle:           return "checkmark.circle.fill"
        case .noAgent:        return "circle.dashed"
        }
    }
    public static func color(for state: WindowState) -> Color {
        switch state {
        case .needsAttention: return .orange
        case .working:        return .blue
        case .idle:           return .green
        case .noAgent:        return .secondary
        }
    }
}
