import Foundation

/// How a given editor's window title encodes the project folder.
public enum TitleStrategy: Equatable, Sendable {
    /// Zed: "<folder> — <detail>" (em-dash), folder on the left.
    case beforeEmDash
    /// JetBrains: "<project> [<path>] - <file>", project on the left.
    case beforeFirstBracketOrHyphen
    /// VSCode: "${dirty}${activeEditorShort}${sep}${rootName}${sep}${appName}". The
    /// separator and rootName position differ by platform (em-dash/last on macOS,
    /// " - "/before-appName on Linux); the folder is the last segment after stripping
    /// any app-name suffix. See `vscodeRootName(_:appNameSuffixes:)`.
    case vscodeRootName
}

public enum TitleParser {
    /// Extract the project folder from a window title using the editor's strategy.
    /// Returns the folder, or nil if the title is known chrome (About/Welcome/etc.) or
    /// nothing usable remains.
    public static func folder(fromTitle title: String, using app: EditorApp) -> String? {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if isNonProjectTitle(trimmedTitle, app) { return nil }

        let folder: String?
        switch app.titleStrategy {
        case .beforeEmDash:
            folder = beforeEmDash(title)
        case .beforeFirstBracketOrHyphen:
            folder = beforeFirstBracketOrHyphen(title)
        case .vscodeRootName:
            folder = vscodeRootName(title, appNameSuffixes: app.appNameSuffixes)
        }

        // Re-check the parsed folder against the blocklist. On Linux a chrome window
        // carries the app-name suffix (e.g. "Welcome - Visual Studio Code"), so the raw
        // title above doesn't match, but the parsed rootName ("Welcome") does. macOS
        // chrome titles have no suffix so they're already caught above; this keeps the
        // two platforms identical.
        if let folder, isNonProjectTitle(folder, app) { return nil }
        return folder
    }

    /// Exact-match or prefix-match against the editor's non-project blocklist.
    static func isNonProjectTitle(_ s: String, _ app: EditorApp) -> Bool {
        if app.nonProjectTitles.contains(s) { return true }
        if app.nonProjectTitlePrefixes.contains(where: { s.hasPrefix($0) }) { return true }
        return false
    }

    /// Zed: take the substring before the first " — " (em-dash, U+2014), or the
    /// whole title if there's no separator.
    static func beforeEmDash(_ title: String) -> String? {
        let separator = " — "  // space, U+2014 em-dash, space
        let candidate: String
        if let range = title.range(of: separator) {
            candidate = String(title[..<range.lowerBound])
        } else {
            candidate = title
        }
        return nonEmptyTrim(candidate)
    }

    /// JetBrains: project name is on the left, before either the bracketed path
    /// (" [") or the file separator (" - "), whichever comes first.
    static func beforeFirstBracketOrHyphen(_ title: String) -> String? {
        let bracket = title.range(of: " [")?.lowerBound
        let hyphen = title.range(of: " - ")?.lowerBound
        let cut = [bracket, hyphen].compactMap { $0 }.min()
        let candidate = cut.map { String(title[..<$0]) } ?? title
        return nonEmptyTrim(candidate)
    }

    /// VSCode: "${dirty}${activeEditorShort}${sep}${rootName}${sep}${appName}".
    /// The separator and the rootName's position differ by platform:
    ///   - macOS native AX title: em-dash " — ", NO app-name suffix, rootName LAST
    ///     (e.g. ".env — mobile").
    ///   - Linux window title: hyphen " - ", app-name suffix PRESENT, rootName is the
    ///     segment just before it (e.g. "Welcome - Musique - Visual Studio Code").
    /// Strategy that covers both: strip a trailing " — <appName>" / " - <appName>"
    /// (longest suffix first, since some app names contain a separator, e.g.
    /// "Visual Studio Code - Insiders"), then split on EITHER separator and take the
    /// LAST non-empty segment — which is rootName once the app name is gone, and drops
    /// the leading active-editor/file part. Folder names with internal hyphens survive
    /// because " - " requires surrounding spaces ("mobile-eslint-rules" is one token).
    static func vscodeRootName(_ title: String, appNameSuffixes: [String]) -> String? {
        var working = title
        outer: for suffix in appNameSuffixes.sorted(by: { $0.count > $1.count }) {
            if working == suffix { working = ""; break }
            for separator in [" — ", " - "] {
                let tail = separator + suffix
                if working.hasSuffix(tail) {
                    working = String(working.dropLast(tail.count))
                    break outer
                }
            }
        }
        // Normalize the em-dash separator to the hyphen one so a single split handles
        // both platforms' titles.
        let normalized = working.replacingOccurrences(of: " — ", with: " - ")
        let segments = normalized.components(separatedBy: " - ")
        return nonEmptyTrim(segments.last ?? working)
    }

    private static func nonEmptyTrim(_ s: String) -> String? {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
