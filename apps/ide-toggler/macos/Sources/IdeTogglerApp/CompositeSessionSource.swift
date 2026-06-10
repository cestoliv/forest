import Foundation
import IdeTogglerCore

public final class CompositeSessionSource: SessionSource {
    public var onChange: (() -> Void)?

    private let sources: [SessionSource]

    public init(_ sources: [SessionSource]) {
        self.sources = sources
        for source in sources {
            source.onChange = { [weak self] in self?.onChange?() }
        }
    }

    public func currentSessions() -> [Session] {
        sources.flatMap { $0.currentSessions() }
    }

    public func activity() -> [Int32: Date] {
        sources.reduce(into: [:]) { result, source in
            result.merge(source.activity()) { _, new in new }
        }
    }

    public func start() {
        for source in sources {
            source.start()
        }
    }
}
