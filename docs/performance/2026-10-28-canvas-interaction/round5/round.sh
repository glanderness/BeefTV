#!/usr/bin/env bash
# 恢复同条件初始画布并启动该侧隔离客户端（每轮开始前调用）。
#   round.sh <before|after> [额外 seed-canvas.py 参数]
set -euo pipefail

side="${1:?usage: round.sh <before|after> [seed args]}"; shift || true
app="/private/tmp/beef-perf/apps/BeefTV2-$side.app"
data="/private/tmp/beef-perf/data/$side"
seed="/Volumes/ExternalWork/todos/workspaces/01a180f8-dc69-711d-abaf-2072dd28520d/docs/performance/2026-10-28-canvas-interaction/seed-canvas.py"

# 两侧客户端放在同一块 Yomado 虚拟屏的同一坐标：只跑一侧时另一侧必须退出，
# 否则 foreground 像素拖拽会落到前台那一个窗口上，另一侧记到 0 次落点调用。
pkill -f "/private/tmp/beef-perf/apps/BeefTV2-" >/dev/null 2>&1 || true
pkill -f "$app/Contents/MacOS/BeefTV" >/dev/null 2>&1 || true
sleep 1
# 客户端把画布缓存在 WKWebsiteDataStore（按 bundle id 分区，不在 --data-dir 里）。
# 只写数据库不会改变界面：缓存里 revision 相同就忽略远端快照。这里把这一侧的缓存
# 挪走归档（只动 perfcanvas2-<side>，绝不碰正式应用的 com.wails.beeftv），让客户端
# 启动后按种子重新从本地后端加载。
store="$HOME/Library/WebKit/com.wails.beeftv.perfcanvas2-$side"
archive="/private/tmp/beef-perf/webkit-store-archive/$side"
rm -rf "$archive"
mkdir -p "$(dirname "$archive")"
if [ -d "$store" ]; then mv "$store" "$archive"; fi
rm -f "$data/runtime.json"
python3 "$seed" "$data" --nodes 300 --title perf300 --canvas-id perf300 "$@"
open -n "$app" --args --data-dir="$data"
for _ in $(seq 1 60); do [ -f "$data/runtime.json" ] && break; sleep 1; done
cat "$data/runtime.json"
echo
pgrep -f "$app/Contents/MacOS/BeefTV" | head -1
