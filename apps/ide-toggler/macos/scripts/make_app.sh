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

# Sign with a STABLE identity so the code signature (and thus the TCC
# Accessibility grant) survives rebuilds. The default adhoc/linker signature's
# hash changes on every build, which makes macOS re-prompt for Accessibility
# each time. Identity resolution, in priority order:
#   1. first CLI argument:   bash scripts/make_app.sh "Apple Development: ..."
#   2. SIGN_IDENTITY env:    SIGN_IDENTITY="..." bash scripts/make_app.sh
#   3. the only valid codesigning identity, if there's exactly one
#   4. an interactive picker, when several exist and a terminal is attached
#   5. otherwise: leave the adhoc signature (with a warning)
SIGN_IDENTITY="${1:-${SIGN_IDENTITY:-}}"

if [ -z "$SIGN_IDENTITY" ]; then
  # Collect valid codesigning identity names (deduped, order-preserving).
  IDENTITIES=()
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    dup=0
    if [ "${#IDENTITIES[@]}" -gt 0 ]; then
      for seen in "${IDENTITIES[@]}"; do [ "$seen" = "$name" ] && { dup=1; break; }; done
    fi
    [ "$dup" -eq 0 ] && IDENTITIES+=("$name")
  done < <(security find-identity -v -p codesigning \
    | sed -nE 's/^[[:space:]]*[0-9]+\)[[:space:]]+[0-9A-Fa-f]+[[:space:]]+"(.*)"$/\1/p')

  if [ "${#IDENTITIES[@]}" -eq 1 ]; then
    SIGN_IDENTITY="${IDENTITIES[0]}"
  elif [ "${#IDENTITIES[@]}" -gt 1 ] && [ -t 0 ]; then
    echo "Multiple signing identities found — choose one:" >&2
    select choice in "${IDENTITIES[@]}"; do
      [ -n "$choice" ] && { SIGN_IDENTITY="$choice"; break; }
    done
  elif [ "${#IDENTITIES[@]}" -gt 1 ]; then
    echo "WARNING: multiple signing identities found but no TTY to choose;" >&2
    echo "         pass one as an argument or via SIGN_IDENTITY=\"...\"." >&2
  fi
fi

if [ -n "$SIGN_IDENTITY" ] && security find-identity -v -p codesigning | grep -qF "$SIGN_IDENTITY"; then
  codesign --force --sign "$SIGN_IDENTITY" "$APP"
  echo "Signed $APP with: $SIGN_IDENTITY"
else
  echo "WARNING: no signing identity selected, leaving adhoc signature." >&2
  echo "         Pass one as an argument or via SIGN_IDENTITY=\"...\" to sign explicitly." >&2
  echo "         Accessibility will re-prompt on each rebuild." >&2
fi

echo "Built $APP"
