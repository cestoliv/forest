// Supported-editor catalog (SPEC §1) and WM_CLASS lookup.
//
// PURE logic — no gi/St/Clutter imports — so it is unit-testable under plain
// Node (see ../../../tests). Mirrors the macOS EditorApp catalog in
// Sources/IdeTogglerCore/Models.swift.

export const EDITORS = [
    {
        kind: 'zed',
        wmClasses: ['dev.zed.Zed', 'zed'],
        titleStrategy: 'beforeEmDash',
        appNameSuffixes: [],
        nonProjectTitles: ['About Zed', 'empty project'],
        nonProjectTitlePrefixes: [],
        badge: 'ZED',
    },
    {
        kind: 'vscode',
        wmClasses: ['code', 'Code', 'code-insiders', 'code-oss'],
        titleStrategy: 'vscodeRootName',
        appNameSuffixes: ['Visual Studio Code - Insiders', 'Visual Studio Code', 'Code - OSS'],
        nonProjectTitles: ['Welcome', 'Get Started'],
        nonProjectTitlePrefixes: ['Release Notes:'],
        badge: 'VS',
    },
    {
        kind: 'jetBrains',
        wmClasses: ['jetbrains-webstorm'],
        titleStrategy: 'beforeFirstBracketOrHyphen',
        appNameSuffixes: [],
        nonProjectTitles: ['About WebStorm', 'Open File or Project'],
        nonProjectTitlePrefixes: ['Welcome to '],
        badge: 'WS',
    },
];

// Resolve the editor descriptor for a window's WM_CLASS (case-insensitive),
// or null if the window does not belong to a supported editor.
export function editorForWmClass(wmClass) {
    if (!wmClass)
        return null;
    const lc = wmClass.toLowerCase();
    for (const ed of EDITORS) {
        for (const cls of ed.wmClasses) {
            if (cls === wmClass || cls.toLowerCase() === lc)
                return ed;
        }
    }
    return null;
}
