import SwiftUI
import AppKit
import IdeTogglerCore

// MARK: - Status grouping
/// The three groups shown in the popup. `idle` and `noAgent` collapse together
/// (a window with no agent is just another quiet window — ball's in your court).
private enum StatusGroup: Int {
    case needs, working, idle

    init(_ state: WindowState) {
        switch state {
        case .needsAttention: self = .needs
        case .working:        self = .working
        case .idle, .noAgent: self = .idle
        }
    }

    var label: String {
        switch self {
        case .needs:   return "Needs you"
        case .working: return "Working"
        case .idle:    return "Idle"
        }
    }
}

public struct PanelView: View {
    @ObservedObject var store: StatusAggregatorStore
    let raiser: WindowRaising
    let settingsStore: SettingsStore

    public init(store: StatusAggregatorStore, raiser: WindowRaising, settingsStore: SettingsStore) {
        self.store = store; self.raiser = raiser; self.settingsStore = settingsStore
    }

    // Group headers only make sense when the list is sorted by status, so they're
    // shown for `.statusPriority` and the list is flat otherwise.
    private var showsGroups: Bool {
        store.settings.orderMode == .statusPriority
    }

    // In status-priority mode rows arrive grouped by status, so walk them once and
    // split into consecutive groups while preserving order. Each StatusGroup appears
    // at most once (same-status rows are adjacent), keeping the ForEach IDs unique.
    private var groups: [(group: StatusGroup, rows: [WindowRow])] {
        var out: [(StatusGroup, [WindowRow])] = []
        for row in store.rows {
            let g = StatusGroup(row.state)
            if var last = out.last, last.0 == g {
                last.1.append(row)
                out[out.count - 1] = last
            } else {
                out.append((g, [row]))
            }
        }
        return out
    }

    // Identity of the ordered list (window ids in sequence), so reorders animate
    // (FLIP-like). State is deliberately excluded: a status change that doesn't move
    // a row (e.g. in alphabetical mode) shouldn't spring the whole list.
    private var orderKey: String {
        store.rows.map(\.window.id).joined(separator: "|")
    }

    // Counts per StatusGroup across all rows, in display order (needs, working,
    // idle), omitting any group with a zero count. Drives the compact header.
    private var statusCounts: [(group: StatusGroup, count: Int)] {
        var tally: [StatusGroup: Int] = [:]
        for row in store.rows { tally[StatusGroup(row.state), default: 0] += 1 }
        let order: [StatusGroup] = [.needs, .working, .idle]
        return order.compactMap { g in
            let c = tally[g] ?? 0
            return c > 0 ? (group: g, count: c) : nil
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.rows.isEmpty {
                Text("No Zed windows")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white.opacity(0.5))
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 22)
            } else if store.settings.compactMode {
                // No orderKey reorder animation here: compact mode shows a single row,
                // so there's nothing to FLIP between — a swap just replaces it outright.
                VStack(alignment: .leading, spacing: 0) {
                    CompactHeader(parts: statusCounts)
                    if let row = store.compactRow {
                        rowView(for: row)
                    }
                }
                .padding(5)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    if showsGroups {
                        ForEach(groups, id: \.group) { entry in
                            GroupHeader(label: entry.group.label, count: entry.rows.count)
                            ForEach(entry.rows, id: \.window.id) { row in
                                rowView(for: row)
                            }
                        }
                    } else {
                        ForEach(store.rows, id: \.window.id) { row in
                            rowView(for: row)
                        }
                    }
                }
                .padding(5)
                .animation(.spring(response: 0.46, dampingFraction: 0.82), value: orderKey)
            }

            Footer(store: store, settingsStore: settingsStore)
        }
        .frame(width: 300)
        .modifier(GlassSurface())
        .preferredColorScheme(.dark)
    }

    private func rowView(for row: WindowRow) -> some View {
        // Animation cleanup is owned by the store (see StatusAggregatorStore.refresh),
        // so it works even in compact mode where only one row is mounted.
        GlassRow(
            row: row,
            pulsing: store.animatingWindowIDs.contains(row.window.id),
            onTap: { raiser.raise(windowID: row.window.id) })
    }
}

// MARK: - Group header (uppercase label + count pill)
private struct GroupHeader: View {
    let label: String
    let count: Int

    var body: some View {
        HStack(spacing: 8) {
            Text(label.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(.white.opacity(0.5))
            Text("\(count)")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
                .padding(.horizontal, 5)
                .frame(minWidth: 17, minHeight: 17)
                .background(Capsule().fill(.white.opacity(0.10)))
            Spacer(minLength: 0)
        }
        .padding(.top, 12)
        .padding(.horizontal, 12)
        .padding(.bottom, 5)
    }
}

// MARK: - Compact header (inline status counts joined by middots)
private struct CompactHeader: View {
    let parts: [(group: StatusGroup, count: Int)]

    var body: some View {
        // `parts` is always non-empty here: CompactHeader only renders for a non-empty
        // row list, and every row maps to one StatusGroup, so statusCounts has an entry.
        HStack(spacing: 6) {
            ForEach(parts, id: \.group) { part in
                if part.group != parts.first?.group {
                    Text("·").foregroundStyle(.white.opacity(0.3))
                }
                Text("\(part.group.label) \(part.count)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.6))
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
        .padding(.horizontal, 12)
        .padding(.bottom, 5)
    }
}

// MARK: - Row
private struct GlassRow: View {
    let row: WindowRow
    let pulsing: Bool
    let onTap: () -> Void
    @State private var hovering = false

    /// Display-only dash→space. `row.window.folder` keeps dashes (used for
    /// session matching), so we transform only what the user reads.
    private var displayName: String {
        row.window.folder.replacingOccurrences(of: "-", with: " ")
    }

    private var isQuiet: Bool {
        row.state == .idle || row.state == .noAgent
    }

    private var nameColor: Color {
        if isQuiet { return .white.opacity(hovering ? 0.95 : 0.6) }
        return .white.opacity(0.95)
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 11) {
                statusIcon(for: row.state, size: 14)
                    .frame(width: 14, height: 14)
                    .scaleEffect(pulsing ? 1.25 : 1.0)
                    .animation(
                        .easeInOut(duration: 0.25).repeatCount(3, autoreverses: true),
                        value: pulsing)

                Text(displayName)
                    .font(.system(size: 13))
                    .foregroundStyle(nameColor)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 4)

                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
                    .opacity(hovering ? 1 : 0)
                    .offset(x: hovering ? 0 : -4)
            }
            .padding(.vertical, 7)
            .padding(.horizontal, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableRowStyle(hovering: hovering, needs: row.state == .needsAttention))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.18), value: hovering)
    }
}

/// Hover glow + press feedback (scale 0.975, terracotta tint), matching the
/// Native-Tahoe direction's row interactions.
private struct PressableRowStyle: ButtonStyle {
    let hovering: Bool
    let needs: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(fill(pressed: configuration.isPressed)))
            .scaleEffect(configuration.isPressed ? 0.975 : 1.0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }

    private func fill(pressed: Bool) -> Color {
        if pressed { return Palette.terracotta.opacity(0.26) }
        if hovering { return needs ? Palette.terracotta.opacity(0.13) : .white.opacity(0.09) }
        return .clear
    }
}

// MARK: - Footer (single rotating settings gear)
private struct Footer: View {
    @ObservedObject var store: StatusAggregatorStore
    let settingsStore: SettingsStore
    @State private var hovering = false
    @State private var compactHovering = false
    @State private var showingSettings = false

    private var isCompact: Bool { store.settings.compactMode }

    var body: some View {
        HStack {
            Spacer()
            Button {
                store.settings.compactMode.toggle()
                settingsStore.save(store.settings)
            } label: {
                Image(systemName: isCompact
                      ? "arrow.up.left.and.arrow.down.right"
                      : "arrow.down.right.and.arrow.up.left")
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(compactHovering ? 0.95 : 0.6))
                    .frame(width: 30, height: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(.white.opacity(compactHovering ? 0.10 : 0.0)))
            }
            .buttonStyle(.plain)
            .onHover { compactHovering = $0 }
            .animation(.easeOut(duration: 0.18), value: compactHovering)
            .help(isCompact ? "Expand" : "Compact")

            Button { showingSettings.toggle() } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 15))
                    .foregroundStyle(.white.opacity(hovering ? 0.95 : 0.6))
                    .frame(width: 30, height: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(.white.opacity(hovering ? 0.10 : 0.0)))
                    .rotationEffect(.degrees(hovering ? 45 : 0))
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .animation(.spring(response: 0.4, dampingFraction: 0.6), value: hovering)
            .popover(isPresented: $showingSettings, arrowEdge: .bottom) {
                SettingsView(store: store, settingsStore: settingsStore).padding()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .overlay(alignment: .top) {
            Rectangle().fill(.white.opacity(0.07)).frame(height: 1)
        }
    }
}

// MARK: - Glass surface
/// Native Liquid Glass on macOS 26 (`.glassEffect`); on earlier systems an
/// `NSVisualEffectView` dark-vibrancy backdrop renders the same Native-Tahoe look.
private struct GlassSurface: ViewModifier {
    private let radius: CGFloat = 16

    func body(content: Content) -> some View {
        Group {
            // `.glassEffect` only exists in the macOS 26 SDK (Swift 6.2 / Xcode 26).
            // Guard it at compile time so older toolchains (e.g. CI) still build;
            // `#available` alone is a runtime check and can't hide the missing symbol.
            #if compiler(>=6.2)
            if #available(macOS 26.0, *) {
                content
                    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            } else {
                content
                    .background(VisualEffectBackground())
                    .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            }
            #else
            content
                .background(VisualEffectBackground())
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            #endif
        }
        .overlay {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(.white.opacity(0.14), lineWidth: 0.5)
        }
        .overlay(alignment: .top) {
            // Top specular sheen.
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [.white.opacity(0.07), .clear],
                        startPoint: .top, endPoint: .center))
                .allowsHitTesting(false)
        }
    }
}

/// macOS 13–15 backdrop: dark `behindWindow` vibrancy (the Native-Tahoe glass).
private struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        v.appearance = NSAppearance(named: .darkAqua)
        return v
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
