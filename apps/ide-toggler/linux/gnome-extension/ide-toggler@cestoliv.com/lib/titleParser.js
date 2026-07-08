// Title -> project folder parsing (SPEC §3) and non-project filtering (SPEC §2.1
// title blocklist). PURE logic — unit-testable under Node. Mirrors the macOS
// TitleParser in Sources/IdeTogglerCore/TitleParser.swift.

function nonEmptyTrim(s) {
    const t = (s || '').trim();
    return t.length ? t : null;
}

// Zed: "<folder> — <detail>" (em-dash U+2014), folder on the LEFT.
export function beforeEmDash(title) {
    const sep = ' — ';
    const idx = title.indexOf(sep);
    const candidate = idx >= 0 ? title.slice(0, idx) : title;
    return nonEmptyTrim(candidate);
}

// WebStorm/JetBrains: "<project> [<path>] - <file>", project on the LEFT.
export function beforeFirstBracketOrHyphen(title) {
    const bracket = title.indexOf(' [');
    const hyphen = title.indexOf(' - ');
    const candidates = [bracket, hyphen].filter(i => i >= 0);
    const cut = candidates.length ? Math.min(...candidates) : -1;
    const candidate = cut >= 0 ? title.slice(0, cut) : title;
    return nonEmptyTrim(candidate);
}

// VSCode: "${dirty}${activeEditorShort}${sep}${rootName}${sep}${appName}".
// The separator and the rootName's position differ by platform:
//   - macOS native AX title: em-dash " — ", NO app-name suffix, rootName LAST
//     (e.g. ".env — mobile").
//   - Linux window title: hyphen " - ", app-name suffix PRESENT, rootName is the
//     segment just before it (e.g. "Welcome - Musique - Visual Studio Code").
// Strategy that covers both: strip a trailing " — <appName>" / " - <appName>"
// (longest suffix first), then split on EITHER separator and take the LAST
// non-empty segment — which is rootName once the app name is gone, and drops the
// leading active-editor/file part. Folder names with internal hyphens survive
// because " - " requires surrounding spaces ("mobile-eslint-rules" is one token).
export function vscodeRootName(title, appNameSuffixes) {
    let working = title;
    const suffixes = [...appNameSuffixes].sort((a, b) => b.length - a.length);
    outer: for (const suffix of suffixes) {
        if (working === suffix) {
            working = '';
            break;
        }
        for (const sep of [' — ', ' - ']) {
            const tail = sep + suffix;
            if (working.endsWith(tail)) {
                working = working.slice(0, working.length - tail.length);
                break outer;
            }
        }
    }
    const segments = working.split(/ — | - /);
    return nonEmptyTrim(segments.length ? segments[segments.length - 1] : working);
}

// Exact-match or prefix-match against the editor's non-project blocklist.
function isNonProjectTitle(s, editor) {
    return editor.nonProjectTitles.includes(s) ||
        editor.nonProjectTitlePrefixes.some(p => s.startsWith(p));
}

// Dispatch on the editor's title strategy, after applying its non-project title
// blocklist (exact + prefix). Returns the folder name, or null to drop the window.
export function folderFromTitle(title, editor) {
    const trimmed = (title || '').trim();
    if (isNonProjectTitle(trimmed, editor))
        return null;

    let folder;
    switch (editor.titleStrategy) {
    case 'beforeEmDash':
        folder = beforeEmDash(title);
        break;
    case 'beforeFirstBracketOrHyphen':
        folder = beforeFirstBracketOrHyphen(title);
        break;
    case 'vscodeRootName':
        folder = vscodeRootName(title, editor.appNameSuffixes);
        break;
    default:
        return null;
    }

    // Re-check the parsed folder against the blocklist. On Linux a chrome window
    // carries the app-name suffix (e.g. "Welcome - Visual Studio Code"), so the raw
    // title above doesn't match, but the parsed rootName ("Welcome") does. macOS
    // chrome titles have no suffix so they're already caught above; this makes the
    // two platforms behave identically.
    if (folder !== null && isNonProjectTitle(folder, editor))
        return null;
    return folder;
}
