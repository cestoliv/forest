import Foundation
import CoreServices
import IdeTogglerCore

/// Watches ~/.codex/sessions and decodes live Codex rollouts.
/// SAFETY: read-only. It reads Codex JSONL files and process cwd metadata; it never
/// writes to Codex state and never signals any process.
public final class FSEventCodexSessionSource: SessionSource {
    public var onChange: (() -> Void)?

    private let directory: URL
    private let decoder: CodexSessionDecoder
    private let liveWorkspaces: CodexLiveWorkspaceProviding
    private var stream: FSEventStreamRef?
    private var timer: Timer?
    private let queue = DispatchQueue(label: "ide-toggler.codex-fsevents")

    private var cachedSessions: [Session] = []
    private var cachedActivity: [Int32: Date] = [:]

    public init(
        directory: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/sessions"),
        decoder: CodexSessionDecoder = CodexSessionDecoder(),
        liveWorkspaces: CodexLiveWorkspaceProviding = DarwinCodexProcessScanner()
    ) {
        self.directory = directory
        self.decoder = decoder
        self.liveWorkspaces = liveWorkspaces
    }

    public func currentSessions() -> [Session] { queue.sync { cachedSessions } }
    public func activity() -> [Int32: Date] { queue.sync { cachedActivity } }

    public func start() {
        queue.sync { reload() }
        setupStream()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.reloadAndNotify()
        }
    }

    private func setupStream() {
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info = info else { return }
            let me = Unmanaged<FSEventCodexSessionSource>.fromOpaque(info).takeUnretainedValue()
            me.reload()
            DispatchQueue.main.async { me.onChange?() }
        }
        let paths = [directory.path] as CFArray
        stream = FSEventStreamCreate(
            kCFAllocatorDefault, callback, &context, paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.2,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents))
        if let stream = stream {
            FSEventStreamSetDispatchQueue(stream, queue)
            FSEventStreamStart(stream)
        }
    }

    private func reloadAndNotify() {
        queue.async { [weak self] in
            guard let self else { return }
            let oldSessions = self.cachedSessions
            let oldActivity = self.cachedActivity
            self.reload()
            guard self.cachedSessions != oldSessions || self.cachedActivity != oldActivity else {
                return
            }
            DispatchQueue.main.async { self.onChange?() }
        }
    }

    private func reload() {
        let result = decoder.loadSessions(
            fromDirectory: directory,
            liveWorkspaces: liveWorkspaces.liveWorkspaces())
        cachedSessions = result.sessions
        cachedActivity = result.activity
    }

    deinit {
        timer?.invalidate()
        if let stream = stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }
}
