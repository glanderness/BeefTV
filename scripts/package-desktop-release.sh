#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT/backend"

: "${VERSION:?VERSION is required}"
: "${PLATFORM:?PLATFORM is required}"

if command -v python >/dev/null 2>&1 && python -c 'import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; then
  PYTHON_BIN=python
else
  PYTHON_BIN=python3
fi

mkdir -p ../dist
work_temp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/beeftv-delta.XXXXXX")"
installer_pid=""
cleanup() {
  if [[ -n "$installer_pid" ]]; then
    kill "$installer_pid" 2>/dev/null || true
  fi
  rm -rf "$work_temp"
}
trap cleanup EXIT

"$PYTHON_BIN" ../scripts/package-desktop-installer.py --platform "$PLATFORM" &
installer_pid=$!

case "$PLATFORM" in
  darwin-arm64|darwin-amd64)
    input="cmd/desktop/build/bin/BeefTV.app"
    ;;
  linux-amd64)
    input="cmd/desktop/build/bin/BeefTV-linux"
    ;;
  windows-amd64)
    input="cmd/desktop/build/bin"
    ;;
  *)
    echo "::error::Unsupported desktop release platform: $PLATFORM"
    exit 1
    ;;
esac

go run ./cmd/update-release package \
  --platform "$PLATFORM" \
  --input "$input" \
  --output "../dist/BeefTV-${VERSION}-${PLATFORM}.zip"

if [[ -n "${PREVIOUS_VERSION:-}" ]] && "$PYTHON_BIN" -c 'import os, re, sys; m = re.match(r"^v(\d+)\.(\d+)\.(\d+)$", os.environ["VERSION"]); sys.exit(0 if m and (int(m[1]), int(m[2]), int(m[3])) >= (2, 1, 0) else 1)'; then
  : "${UPDATER_DOWNLOAD_BASE:?UPDATER_DOWNLOAD_BASE is required when PREVIOUS_VERSION is set}"
  : "${BEEFTV_UPDATER_PUBLIC_KEY:?BEEFTV_UPDATER_PUBLIC_KEY is required when PREVIOUS_VERSION is set}"
  if curl --fail --silent --show-error --location --retry 3 --max-time 60 \
    "${UPDATER_DOWNLOAD_BASE}/${PREVIOUS_VERSION}/desktop-update.json" \
    -o "$work_temp/prev-desktop-update.json" && \
    go run ./cmd/update-release verify \
      --envelope "$work_temp/prev-desktop-update.json" \
      --public-key-text "$BEEFTV_UPDATER_PUBLIC_KEY" && \
    curl --fail --silent --show-error --location --retry 3 --max-time 600 \
      "${UPDATER_DOWNLOAD_BASE}/${PREVIOUS_VERSION}/BeefTV-${PREVIOUS_VERSION}-${PLATFORM}.zip" \
      -o "$work_temp/BeefTV-${PREVIOUS_VERSION}-${PLATFORM}.zip"; then
    go run ./cmd/update-release build-delta \
      --platform "$PLATFORM" \
      --from-version "$PREVIOUS_VERSION" \
      --to-version "$VERSION" \
      --from-zip "$work_temp/BeefTV-${PREVIOUS_VERSION}-${PLATFORM}.zip" \
      --to-zip "../dist/BeefTV-${VERSION}-${PLATFORM}.zip" \
      --output "../dist/BeefTV-${VERSION}-${PLATFORM}-from-${PREVIOUS_VERSION}.delta.zip"
  else
    echo "::warning::Previous release ${PREVIOUS_VERSION} ${PLATFORM} zip unavailable; skipping delta archive."
  fi
fi

if ! wait "$installer_pid"; then
  installer_pid=""
  echo "::error::Native installer packaging failed"
  exit 1
fi
installer_pid=""

"$PYTHON_BIN" ../scripts/smoke-packaged-cli_test.py
"$PYTHON_BIN" ../scripts/smoke-packaged-cli.py --archive "../dist/BeefTV-${VERSION}-${PLATFORM}.zip" --platform "$PLATFORM"
