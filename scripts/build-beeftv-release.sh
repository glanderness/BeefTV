#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/backend/cmd/desktop"
GO_DIR="${BEEFTV_GO_DIR:-/tmp/beeftv-go.rpIfVN/go}"

if [[ ! -f "$ROOT_DIR/VERSION" ]]; then
  echo "VERSION file is required" >&2
  exit 1
fi

VERSION_VALUE="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")"
if [[ ! "$VERSION_VALUE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid VERSION: $VERSION_VALUE" >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1 && [[ -x "$GO_DIR/bin/go" ]]; then
  export PATH="$GO_DIR/bin:$PATH"
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Go is required (set BEEFTV_GO_DIR when using a bundled toolchain)" >&2
  exit 1
fi

# Use the shared size gate default; an explicit BEEFTV_WEB_BUDGET_MIB override
# applies consistently to local and CI builds.

if [[ "${BEEFTV_SKIP_LOCAL_VERIFY:-}" != "1" ]]; then
  "$ROOT_DIR/scripts/verify-beeftv-local-release.sh"
fi

COMMIT_VALUE="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME_VALUE="${CANVAS_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export CANVAS_BUILD_VERSION="$VERSION_VALUE"
export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"

LDFLAGS="-X infinite-canvas/backend/internal/buildinfo.Version=$VERSION_VALUE -X infinite-canvas/backend/internal/buildinfo.Commit=$COMMIT_VALUE -X infinite-canvas/backend/internal/buildinfo.BuildTime=$BUILD_TIME_VALUE"
if [[ -n "${BEEFTV_UPDATER_PUBLIC_KEY:-}" ]]; then
  UPDATER_LDFLAGS="$(
    cd "$ROOT_DIR/backend"
    go run ./cmd/update-release print-ldflags
  )"
  LDFLAGS="$LDFLAGS $UPDATER_LDFLAGS"
fi
if [[ -n "${BEEFTV_EXTRA_LDFLAGS:-}" ]]; then
  LDFLAGS="$LDFLAGS $BEEFTV_EXTRA_LDFLAGS"
fi

if [[ -n "${BEEFTV_WAILS_PLATFORM:-}" ]]; then
  host_arch="$(uname -m)"
  case "$BEEFTV_WAILS_PLATFORM" in
    darwin/amd64)
      if [[ "$host_arch" == "arm64" ]]; then
        export CGO_ENABLED=1
        export CGO_CFLAGS="${CGO_CFLAGS:+$CGO_CFLAGS }-arch x86_64"
        export CGO_LDFLAGS="${CGO_LDFLAGS:+$CGO_LDFLAGS }-arch x86_64"
      fi
      ;;
    darwin/arm64)
      if [[ "$host_arch" == "x86_64" ]]; then
        export CGO_ENABLED=1
        export CGO_CFLAGS="${CGO_CFLAGS:+$CGO_CFLAGS }-arch arm64"
        export CGO_LDFLAGS="${CGO_LDFLAGS:+$CGO_LDFLAGS }-arch arm64"
      fi
      ;;
  esac
fi

echo "Building BeefTV $VERSION_VALUE ($COMMIT_VALUE)"

(
  cd "$DESKTOP_DIR"
  if [[ -n "${BEEFTV_WAILS_PLATFORM:-}" ]]; then
    go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 build \
      -clean \
      -trimpath \
      -platform "$BEEFTV_WAILS_PLATFORM" \
      -ldflags "$LDFLAGS"
  else
    go run github.com/wailsapp/wails/v2/cmd/wails@v2.16.0 build \
      -clean \
      -trimpath \
      -ldflags "$LDFLAGS"
  fi
)

# Official protocol packages are runtime dependencies. Finder launches use the
# bundle Resources directory and must never depend on the caller's cwd.
APP_BUNDLE="$DESKTOP_DIR/build/bin/BeefTV.app"
PLUGIN_RESOURCE_DIR="$APP_BUNDLE/Contents/Resources/plugin-packages"
mkdir -p "$PLUGIN_RESOURCE_DIR"
cp "$ROOT_DIR/plugin-packages/"*.beeftv-plugin "$PLUGIN_RESOURCE_DIR/"

# 内置创作助手宿主随包发布：主程序是纯 Go，助手宿主是 Node 进程，因此把宿主与
# （可选的）Node 运行时一起放进 Resources，避免发行形态依赖用户机器上的全局 Node
# 或开发目录里的绝对路径。BEEFTV_NODE_RUNTIME 指向含 bin/node 的目录时才会随包。
AGENT_HOST_RESOURCE_DIR="$APP_BUNDLE/Contents/Resources/agent-host"
mkdir -p "$AGENT_HOST_RESOURCE_DIR"
cp "$ROOT_DIR/agent-host/server.mjs" "$AGENT_HOST_RESOURCE_DIR/"
cp "$ROOT_DIR/agent-host/session-identity.mjs" "$AGENT_HOST_RESOURCE_DIR/"
cp "$ROOT_DIR/agent-host/package.json" "$AGENT_HOST_RESOURCE_DIR/"
cp "$ROOT_DIR/agent-host/run-agent-host.sh" "$AGENT_HOST_RESOURCE_DIR/"
chmod 0755 "$AGENT_HOST_RESOURCE_DIR/run-agent-host.sh"
if [[ -d "$ROOT_DIR/agent-host/node_modules" ]]; then
  cp -R "$ROOT_DIR/agent-host/node_modules" "$AGENT_HOST_RESOURCE_DIR/"
else
  echo "warning: agent-host/node_modules 缺失，内置助手宿主将无法启动（请先在该目录安装依赖）" >&2
fi
if [[ -n "${BEEFTV_NODE_RUNTIME:-}" ]]; then
  if [[ ! -x "$BEEFTV_NODE_RUNTIME/bin/node" ]]; then
    echo "BEEFTV_NODE_RUNTIME 必须指向含 bin/node 的目录" >&2
    exit 1
  fi
  mkdir -p "$AGENT_HOST_RESOURCE_DIR/runtime/bin"
  # 只复制 node 二进制本身：宿主运行时不需要 npm/npx，复制符号链接反而会留下坏链。
  cp "$BEEFTV_NODE_RUNTIME/bin/node" "$AGENT_HOST_RESOURCE_DIR/runtime/bin/node"
  chmod 0755 "$AGENT_HOST_RESOURCE_DIR/runtime/bin/node"

  BUNDLED_NODE="$AGENT_HOST_RESOURCE_DIR/runtime/bin/node"
  # 架构必须与本次构建目标一致，否则目标机器上根本起不来。
  case "${BEEFTV_WAILS_PLATFORM:-darwin/$(uname -m)}" in
    darwin/arm64) EXPECTED_ARCH="arm64" ;;
    darwin/amd64) EXPECTED_ARCH="x86_64" ;;
    *) EXPECTED_ARCH="" ;;
  esac
  if [[ -n "$EXPECTED_ARCH" ]]; then
    ACTUAL_ARCH="$(lipo -archs "$BUNDLED_NODE" 2>/dev/null || echo unknown)"
    if [[ "$ACTUAL_ARCH" != *"$EXPECTED_ARCH"* ]]; then
      echo "随包 Node 架构不匹配：期望 $EXPECTED_ARCH，实际 $ACTUAL_ARCH" >&2
      exit 1
    fi
    echo "Bundled Node arch: $ACTUAL_ARCH (expected $EXPECTED_ARCH)"
  fi
  # 动态库依赖必须只剩系统库：带 Homebrew 依赖的 node 在目标机器上会 dyld 失败。
  if command -v otool >/dev/null 2>&1; then
    NON_SYSTEM="$(otool -L "$BUNDLED_NODE" | tail -n +2 | awk '{print $1}' | grep -vE '^/usr/lib/|^/System/' || true)"
    if [[ -n "$NON_SYSTEM" ]]; then
      echo "随包 Node 依赖非系统动态库，无法在未安装这些库的机器上运行：" >&2
      echo "$NON_SYSTEM" >&2
      exit 1
    fi
    echo "Bundled Node links only system libraries"
  fi
  # 最后做一次真跑，避免把一个起不来的二进制打进发行包。
  if ! "$BUNDLED_NODE" -e 'process.exit(0)'; then
    echo "随包 Node 无法执行" >&2
    exit 1
  fi
  echo "Bundled Node runtime from $BEEFTV_NODE_RUNTIME (verified: arch, dylibs, smoke run)"
else
  echo "note: 未提供 BEEFTV_NODE_RUNTIME，宿主将回退到 PATH 上的 node（发行包请提供随包运行时）" >&2
fi

# Keep the generated macOS bundle metadata aligned with the repository version.
APP_PLIST="$APP_BUNDLE/Contents/Info.plist"
if [[ -f "$APP_PLIST" ]] && command -v plutil >/dev/null 2>&1; then
  MACOS_VERSION="${VERSION_VALUE#v}"
  plutil -replace CFBundleShortVersionString -string "$MACOS_VERSION" "$APP_PLIST"
  plutil -replace CFBundleVersion -string "$MACOS_VERSION" "$APP_PLIST"
  # The plist edit invalidates Wails' ad-hoc signature; sign the final bundle.
  codesign --force --deep --sign - "$APP_BUNDLE"
fi

echo "Release bundle: $APP_BUNDLE"
