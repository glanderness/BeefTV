#!/usr/bin/env bash
# 把 wails 构建出来的 BeefTV.app 复制成一份隔离的测量客户端：
# 独立 bundle id（WKWebView 存储按 bundle id 分区，不能和用户正式客户端共用）、
# 独立数据目录由启动参数 --data-dir 指定，ad-hoc 重签名。
#
#   prepare-native-app.sh <源 app> <目标 app> <bundle id> <版本串>
set -euo pipefail

SOURCE_APP="$1"
TARGET_APP="$2"
BUNDLE_ID="$3"
VERSION_STRING="$4"

[[ -x "$SOURCE_APP/Contents/MacOS/BeefTV" ]] || { echo "源 app 不完整: $SOURCE_APP" >&2; exit 1; }
[[ ! -e "$TARGET_APP" ]] || { echo "目标已存在，先删掉再跑: $TARGET_APP" >&2; exit 1; }

mkdir -p "$(dirname "$TARGET_APP")"
rsync -a "$SOURCE_APP/" "$TARGET_APP/"

PLIST="$TARGET_APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleName -string "BeefTVPerf" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION_STRING" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION_STRING" "$PLIST"

codesign --force --deep --sign - "$TARGET_APP"
codesign --verify --deep --strict "$TARGET_APP"
echo "隔离客户端: $TARGET_APP ($BUNDLE_ID)"
