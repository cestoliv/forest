import Foundation

public enum TitleParser {
    /// Zed window titles look like "<folder> — <detail>" using an em-dash
    /// surrounded by spaces. Returns the folder portion, or the whole title
    /// (trimmed) if there is no separator, or nil if nothing usable remains.
    public static func folder(fromTitle title: String) -> String? {
        let separator = " — "  // space, U+2014 em-dash, space
        let candidate: String
        if let range = title.range(of: separator) {
            candidate = String(title[..<range.lowerBound])
        } else {
            candidate = title
        }
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
