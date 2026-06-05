import SwiftUI
import IdeTogglerCore

// MARK: - Palette
// Terracotta accent + warm cream, dark-only. Mirrors the design tokens in the
// handoff `styles.css` (--it-accent / --it-accent-hi / --it-cream). `idleRing` is
// a local-only slate used dimmed for quiet states; it has no styles.css token.
enum Palette {
    static let terracotta   = Color(red: 224/255, green: 135/255, blue:  99/255) // #E08763
    static let terracottaHi = Color(red: 240/255, green: 164/255, blue: 136/255) // #F0A488
    static let cream        = Color(red: 245/255, green: 238/255, blue: 230/255) // rgba(245,238,230,...)
    static let idleRing     = Color(red: 225/255, green: 230/255, blue: 240/255) // slate, used dimmed
}

// MARK: - Status icon factory
/// The visual mark for a window's collapsed agent state. No green checks:
/// `needs` is the only saturated mark, `working` shows motion, `idle`/`noAgent`
/// recede to a dim ring.
@ViewBuilder
func statusIcon(for state: WindowState, size: CGFloat) -> some View {
    switch state {
    case .needsAttention: NeedsIcon(size: size)
    case .working:        WorkingIcon(size: size)
    case .idle, .noAgent: IdleIcon(size: size)
    }
}

// MARK: - Needs you — solid terracotta dot + two breathing ping rings
struct NeedsIcon: View {
    let size: CGFloat
    @State private var animate = false

    var body: some View {
        ZStack {
            ping(delay: 0)
            ping(delay: 1.05)
            Circle()
                .fill(
                    RadialGradient(
                        colors: [Palette.terracottaHi, Palette.terracotta],
                        center: UnitPoint(x: 0.35, y: 0.30),
                        startRadius: 0, endRadius: size * 0.30)
                )
                .frame(width: size * 0.56, height: size * 0.56)
                .shadow(color: Palette.terracotta.opacity(0.85), radius: 3.5)
                .shadow(color: Palette.terracottaHi.opacity(0.9), radius: 1)
        }
        .frame(width: size, height: size)
        .onAppear { animate = true }
    }

    private func ping(delay: Double) -> some View {
        Circle()
            .strokeBorder(Palette.terracotta, lineWidth: 1.5)
            .frame(width: size, height: size)
            .scaleEffect(animate ? 1.25 : 0.5)
            .opacity(animate ? 0 : 0.85)
            .animation(
                .easeOut(duration: 2.1).repeatForever(autoreverses: false).delay(delay),
                value: animate)
    }
}

// MARK: - Working — warm-cream conic arc spinner (gradient masked to a ring)
struct WorkingIcon: View {
    let size: CGFloat
    @State private var spin = false

    var body: some View {
        Circle()
            .fill(
                AngularGradient(
                    gradient: Gradient(stops: [
                        .init(color: Palette.cream.opacity(0.0),  location: 0.00),
                        .init(color: Palette.cream.opacity(0.15), location: 0.25),
                        .init(color: Palette.cream.opacity(0.55), location: 0.69),
                        .init(color: Palette.cream.opacity(0.92), location: 1.00),
                    ]),
                    center: .center)
            )
            .mask(Circle().strokeBorder(Color.black, lineWidth: max(2, size * 0.16)))
            .frame(width: size * 0.92, height: size * 0.92)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(.linear(duration: 0.95).repeatForever(autoreverses: false), value: spin)
            .onAppear { spin = true }
    }
}

// MARK: - Idle / no agent — thin dim slate ring that recedes
struct IdleIcon: View {
    let size: CGFloat

    var body: some View {
        Circle()
            .strokeBorder(Palette.idleRing.opacity(0.34), lineWidth: 1.5)
            .frame(width: size * 0.76, height: size * 0.76)
            .frame(width: size, height: size)
    }
}
