import Foundation
import AppKit
import ApplicationServices
import IdeTogglerCore

/// Raises/focuses a window. SAFETY: the ONLY mutating system call in the whole app is
/// AXUIElementPerformAction(_, kAXRaiseAction) + NSRunningApplication.activate.
/// Never call any other AX action, and never test this against a real Zed window.
public final class AXWindowRaiser: WindowRaising {
    private weak var source: AXWindowSource?
    public init(source: AXWindowSource) { self.source = source }

    public func raise(windowID: String) {
        guard let source = source else { return }
        guard let element = source.elementsByID[windowID] else { return }
        AXUIElementPerformAction(element, kAXRaiseAction as CFString)

        // Bring the owning app forward. Resolve the owning pid from the AX element itself,
        // since the window id is now CGWindowID-based and no longer encodes the pid.
        var pid: pid_t = 0
        if AXUIElementGetPid(element, &pid) == .success,
           let app = NSRunningApplication(processIdentifier: pid) {
            app.activate(options: [])
        }
    }
}
