import CoreGraphics

/// Pure geometry helpers for keeping the floating panel reachable when the display
/// configuration changes (monitor connect/disconnect). Lives in the core (CGRect only,
/// no AppKit) so the math is unit-testable.
public enum PanelGeometry {
    /// Returns a corrected frame when `frame` is not fully contained in any of the given
    /// screen visible-frames (i.e. it would be off-screen / unreachable); returns nil when
    /// the panel is still fully visible on some screen and should be left untouched.
    public static func reachableFrame(for frame: CGRect, screens: [CGRect]) -> CGRect? {
        guard !screens.isEmpty else { return nil }
        // Still fully visible on at least one screen → preserve the user's position.
        if screens.contains(where: { $0.contains(frame) }) { return nil }
        // Otherwise clamp onto the screen it overlaps most (fallback: the first screen).
        let target = screens.max(by: { intersectionArea($0, frame) < intersectionArea($1, frame) })
            ?? screens[0]
        return clamp(frame, into: target)
    }

    static func intersectionArea(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        return i.isNull ? 0 : i.width * i.height
    }

    /// Shift `rect` minimally so it fits inside `container`. If `rect` is larger than the
    /// container the top-left corner wins, so the popup's top stays reachable: the last guard
    /// on each axis takes precedence, so X keeps the left edge and Y keeps the top edge (in
    /// AppKit's Y-up space the top edge is `maxY`).
    static func clamp(_ rect: CGRect, into container: CGRect) -> CGRect {
        var x = rect.origin.x, y = rect.origin.y
        if x + rect.width  > container.maxX { x = container.maxX - rect.width }
        if x < container.minX { x = container.minX }                       // left wins if wider
        if y < container.minY { y = container.minY }
        if y + rect.height > container.maxY { y = container.maxY - rect.height } // top wins if taller
        return CGRect(x: x, y: y, width: rect.width, height: rect.height)
    }
}
