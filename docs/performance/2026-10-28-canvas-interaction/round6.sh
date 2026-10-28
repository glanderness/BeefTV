#!/usr/bin/env bash
# 第六轮：恢复同条件初始画布并启动该侧隔离客户端（每轮开始前调用）。
#   round6.sh <before|after> [额外 seed-canvas.py 参数]
#   RECOVER=1 round6.sh after      额外写一条可后台取回的假任务（需 upstream.py 已在跑）
#
# 与第五轮 round.sh 的差别：
#   1) 种子默认用 --media resource：节点引用真实 resource 行，payload 不再内嵌 data:image，
#      保存不再撞 ValidateSyncedPayload 的 400（第五轮 6 条 400 的夹具原因）。
#   2) 额外清理这一侧 perf-sink 的汇总行与完整导出行，避免跨轮混读。
#   3) 两侧客户端放同一块 Yomado 虚拟屏的同一坐标：只跑一侧时另一侧必须退出，
#      否则前台像素拖拽会落到另一个窗口上。
set -euo pipefail

side="${1:?usage: round6.sh <before|after> [seed args]}"; shift || true
PREP="/Volumes/ExternalWork/todos/workspaces/01a18157-690d-78de-9208-0b4516f6f843/docs/performance/2026-10-28-canvas-interaction"
WT="/Volumes/Workspaces/Worktrees/BeefTV/canvas-interaction-perf-20261028"
EVID="/private/tmp/beef-perf/round6"
app="/private/tmp/beef-perf/apps/BeefTV2-$side.app"
data="/private/tmp/beef-perf/data/$side"

[[ -d "$app" ]] || { echo "隔离客户端不存在: $app" >&2; exit 1; }

pkill -f "/private/tmp/beef-perf/apps/BeefTV2-" >/dev/null 2>&1 || true
sleep 1
# 画布缓存在 WKWebsiteDataStore（按 bundle id 分区，不在 --data-dir 里）。只写数据库不会
# 改变界面：缓存里 revision 相同就忽略远端快照。挪走这一侧的缓存（只动 perfcanvas2-<side>，
# 绝不碰正式应用的 com.wails.beeftv），让客户端启动后按种子重新加载。
store="$HOME/Library/WebKit/com.wails.beeftv.perfcanvas2-$side"
archive="/private/tmp/beef-perf/webkit-store-archive/$side"
rm -rf "$archive"
mkdir -p "$(dirname "$archive")"
if [ -d "$store" ]; then mv "$store" "$archive"; fi
rm -f "$data/runtime.json"

python3 "$PREP/seed-canvas.py" "$data" --nodes 300 --title perf300 --canvas-id perf300 "$@"
if [ "${RECOVER:-0}" = "1" ]; then
  python3 "$PREP/seed-recovery-task.py" "$data" --upstream "${UPSTREAM:-http://127.0.0.1:19118}"
fi

mkdir -p "$EVID"
rm -f "$EVID/perf-$side.ndjson" "$EVID/perf-$side.ndjson.dump.jsonl"

# 用 python 起会话（start_new_session）而不是 `open -n`：需要把后端的访问日志留在本轮目录里，
# 直接重定向 stdout 又必须脱离当前进程组，否则父 shell 退出时会把客户端一起收掉。
python3 - "$app" "$data" "$EVID/app-$side.log" <<'PY'
import subprocess, sys
app, data, log = sys.argv[1], sys.argv[2], sys.argv[3]
out = open(log, "ab")
p = subprocess.Popen(
    [f"{app}/Contents/MacOS/BeefTV", f"--data-dir={data}"],
    stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True,
)
print(f"launched pid={p.pid} log={log}")
PY
for _ in $(seq 1 60); do [ -f "$data/runtime.json" ] && break; sleep 1; done
cat "$data/runtime.json"; echo
echo "side=$side head=$(git -C "$WT/$side" rev-parse HEAD)"
echo "probe=$(shasum -a 256 "$WT/$side/web/src/perf-probe.ts" | cut -d' ' -f1)"
pgrep -f "$app/Contents/MacOS/BeefTV" | head -1
