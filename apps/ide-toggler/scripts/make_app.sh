#!/usr/bin/env bash
set -euo pipefail

# Builds the release binary and assembles IdeToggler.app around it.
# SAFETY: build/packaging only — touches nothing belonging to Zed or Claude.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/IdeToggler.app"
BIN_NAME="ideToggler"

swift build -c release
BIN_PATH="$ROOT/.build/release/$BIN_NAME"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN_PATH" "$APP/Contents/MacOS/$BIN_NAME"
cp "$ROOT/scripts/Info.plist" "$APP/Contents/Info.plist"

echo "Built $APP"
