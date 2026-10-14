#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_DIR="${GO_DIR:-/tmp/beeftv-go.rpIfVN}"
BACKEND_ADDR="${CANVAS_DESKTOP_BACKEND_ADDR:-127.0.0.1:8080}"
LAUNCH_TOKEN="${CANVAS_DESKTOP_LAUNCH_TOKEN:-$(openssl rand -hex 32)}"

export CANVAS_DESKTOP_BACKEND_ADDR="$BACKEND_ADDR"
export CANVAS_DESKTOP_LAUNCH_TOKEN="$LAUNCH_TOKEN"
export VITE_API_PROXY_TARGET="http://${BACKEND_ADDR}"
export VITE_DESKTOP_LAUNCH_TOKEN="$LAUNCH_TOKEN"
export CANVAS_DESKTOP_DATA_DIR="${CANVAS_DESKTOP_DATA_DIR:-$ROOT_DIR/.local/project-workbench-debug}"
if ! command -v go >/dev/null 2>&1 && [ -x "$GO_DIR/go/bin/go" ]; then
  export PATH="$GO_DIR/go/bin:$PATH"
fi
export GOTOOLCHAIN=local

for port in 3000 "${BACKEND_ADDR##*:}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "开发端口 $port 已被占用，请先停止对应的开发服务。" >&2
    exit 1
  fi
done

mkdir -p "$CANVAS_DESKTOP_DATA_DIR"
cd "$ROOT_DIR/web"
# Wails installs dependencies after the external watcher has already started.
# Install first so a fresh checkout cannot open a window without Vite.
bun install --frozen-lockfile
bun run dev -- --host 127.0.0.1 --port 3000 --strictPort &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

VITE_READY=false
for ((attempt = 0; attempt < 120; attempt++)); do
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "前端开发服务启动失败，未打开桌面窗口。" >&2
    exit 1
  fi
  if curl --fail --silent --max-time 1 http://127.0.0.1:3000/ >/dev/null; then
    VITE_READY=true
    break
  fi
  sleep 0.5
done
if [ "$VITE_READY" != true ]; then
  echo "等待前端开发服务超时，未打开桌面窗口。" >&2
  exit 1
fi

cd "$ROOT_DIR/backend/cmd/desktop"
go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 dev
