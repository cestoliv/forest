import Foundation
import CoreServices
import IdeTogglerCore

/// Watches ~/.claude/sessions via FSEvents (~200ms coalescing) and re-decodes on change.
/// SAFETY: read-only. It reads session JSON; it never writes, deletes, or signals.
public final class FSEventSessionSource: SessionSource {
    public var onChange: (() -> Void)?

    private let directory: URL
    private let decoder: SessionFileDecoder
    private var stream: FSEventStreamRef?
    private let queue = DispatchQueue(label: "ide-toggler.fsevents")

    private var cachedSessions: [Session] = []
    private var cachedActivity: [Int32: Date] = [:]

    public init(
        directory: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/sessions"),
        decoder: SessionFileDecoder = SessionFileDecoder()
    ) {
        self.directory = directory
        self.decoder = decoder
    }

    // Thread-safety: cachedSessions/cachedActivity are only written inside `queue`
    // (via reload(), which is always dispatched onto or called from the serial queue).
    // Reads use queue.sync so callers on any thread (including main) are safe.
    public func currentSessions() -> [Session] { queue.sync { cachedSessions } }
    public func activity() -> [Int32: Date] { queue.sync { cachedActivity } }

    public func start() {
        // Dispatch the initial reload onto the serial queue so it shares the same
        // mutual-exclusion domain as the FSEvents callback's reload() calls.
        queue.sync { reload() }
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info = info else { return }
            let me = Unmanaged<FSEventSessionSource>.fromOpaque(info).takeUnretainedValue()
            me.reload()
            DispatchQueue.main.async { me.onChange?() }
        }
        let paths = [directory.path] as CFArray
        stream = FSEventStreamCreate(
            kCFAllocatorDefault, callback, &context, paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.2,  // 200ms coalescing
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents))
        if let stream = stream {
            FSEventStreamSetDispatchQueue(stream, queue)
            FSEventStreamStart(stream)
        }
    }

    private func reload() {
        let result = decoder.loadSessions(fromDirectory: directory)
        cachedSessions = result.sessions
        cachedActivity = result.activity
    }

    deinit {
        if let stream = stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }
}
