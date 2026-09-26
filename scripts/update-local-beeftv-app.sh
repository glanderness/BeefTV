#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGED_APP="$ROOT_DIR/backend/cmd/desktop/build/bin/BeefTV.app"
INSTALLED_APP="/Applications/BeefTV.app"

cleanup_staged_app() {
  if [[ -d "$STAGED_APP" && ! -L "$STAGED_APP" ]]; then
    find "$STAGED_APP" -depth -delete
  fi
}
trap cleanup_staged_app EXIT

"$ROOT_DIR/scripts/build-beeftv-release.sh"

if [[ ! -x "$STAGED_APP/Contents/MacOS/BeefTV" ]]; then
  echo "Built BeefTV.app is incomplete: $STAGED_APP" >&2
  exit 1
fi
codesign --verify --deep --strict "$STAGED_APP"
if [[ -e "$INSTALLED_APP" && ( ! -d "$INSTALLED_APP" || -L "$INSTALLED_APP" ) ]]; then
  echo "Refusing to replace unexpected target: $INSTALLED_APP" >&2
  exit 1
fi

osascript -e 'tell application id "com.wails.beeftv" to quit' 2>/dev/null || true
for _ in 1 2 3 4 5; do
  pgrep -f '^/Applications/BeefTV.app/Contents/MacOS/BeefTV$' >/dev/null || break
  sleep 1
done
if pgrep -f '^/Applications/BeefTV.app/Contents/MacOS/BeefTV$' >/dev/null; then
  echo "BeefTV is still running. Save your work and quit before updating." >&2
  exit 1
fi

mkdir -p "$INSTALLED_APP"
rsync -a --delete "$STAGED_APP/" "$INSTALLED_APP/"
codesign --verify --deep --strict "$INSTALLED_APP"

echo "Updated the canonical local app: $INSTALLED_APP"
