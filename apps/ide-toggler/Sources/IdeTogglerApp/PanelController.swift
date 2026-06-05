import AppKit
import SwiftUI
import IdeTogglerCore

/// Hosts PanelView in a floating, chromeless NSPanel that never steals focus and
/// joins all spaces. No title bar (close/expand removed) — the glass surface and
/// rounded corners come from PanelView itself; the window is clear and shadowed.
/// The panel is anchored to the top-right under the menu bar (matching the design)
/// and pinned by its top-right so it grows downward as the window list changes.
public final class PanelController: NSObject {
    private var panel: NSPanel?
    /// Screen point where the popup's top-RIGHT corner should stay. We pin by the
    /// right edge (recomputing the left from the live width) because the window's
    /// width isn't settled until SwiftUI has laid out its content.
    private var topRightAnchor: NSPoint?

    public override init() { super.init() }

    public func show(store: StatusAggregatorStore, raiser: WindowRaising, settingsStore: SettingsStore) {
        let hosting = NSHostingController(
            rootView: PanelView(store: store, raiser: raiser, settingsStore: settingsStore))
        // Track SwiftUI's content size so the borderless panel hugs the popup.
        hosting.sizingOptions = [.preferredContentSize]

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 360),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true   // never steal focus from Zed
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear        // let the glass show the desktop through
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.contentViewController = hosting
        panel.delegate = self

        anchorTopRight(panel)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    /// Place the popup's top-right corner just under the menu bar, near the right edge.
    /// Anchor to the menu-bar screen (`NSScreen.main`); `panel.screen` would resolve
    /// to whichever display contains the not-yet-positioned window origin, which on a
    /// multi-monitor setup may not be the screen the user is looking at.
    private func anchorTopRight(_ panel: NSPanel) {
        guard let visible = (NSScreen.main ?? panel.screen)?.visibleFrame else { return }
        let margin: CGFloat = 12
        topRightAnchor = NSPoint(x: visible.maxX - margin, y: visible.maxY - margin)
        reposition(panel)
    }

    /// Re-pin the window so its top-right corner sits at the anchor, using the
    /// window's current width (which only settles after content layout).
    private func reposition(_ window: NSWindow) {
        guard let anchor = topRightAnchor else { return }
        window.setFrameTopLeftPoint(NSPoint(x: anchor.x - window.frame.width, y: anchor.y))
    }
}

extension PanelController: NSWindowDelegate {
    public func windowDidResize(_ notification: Notification) {
        // Auto-sizing changes size keeping the bottom-left fixed; re-pin to the
        // top-right so the popup stays anchored under the menu bar and grows down.
        guard let window = notification.object as? NSWindow else { return }
        reposition(window)
    }
}
