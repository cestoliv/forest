import AppKit
import IdeTogglerCore

/// Plays the macOS system "Glass" sound as a chime.
/// SAFETY: audio output only; no process interaction.
public final class AVAudioChimePlayer: ChimePlayer {
    public init() {}

    public func playChime() {
        NSSound(named: "Glass")?.play()
    }
}
