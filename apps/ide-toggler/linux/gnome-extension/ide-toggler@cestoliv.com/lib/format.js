// Compact two-unit elapsed-time label for the per-row state timer (e.g. `45s`,
// `5m 12s`, `2h 30m`, `3d 4h`). PURE — unit-testable under Node. Mirrors
// `formatStuckDuration` in the macOS build (same buckets).
//   ms: elapsed milliseconds (negative clamped to 0)
export function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
