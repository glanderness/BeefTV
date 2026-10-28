#!/usr/bin/env bash
# 第七轮：恢复同条件初始画布并启动该侧隔离客户端（每轮开始前调用）。
#   round7.sh <before|after> [额外 seed-canvas.py 参数]
#   RECOVER=1 round7.sh after      额外写一条可后台取回的假任务（需 upstream.py 已在跑）
#
# 与第六轮 round6.sh 的差别：
#   1) 路径全部改到本会话的 ExternalWork 工作树（第六轮写死的 /Volumes/Workspaces 是另一个卷，
#      不是 ExternalWork 的别名；事实见 round7-prep.md 第 6.1 节）。
#   2) 客户端换名 BeefTV7-<side>.app / perfcanvas7-<side> / data7，避免与第六轮缓存串味。
#   3) 启动后打印二进制完整 sha256 与探针哈希，供 native-builds-round7.json 登记。
#   4) 窗口位置与虚拟屏身份不在这里设：由 cua-driver set_window_frame 放置，再用探针 perf-env 记录。
set -euo pipefail

side="${1:?usage: round7.sh <before|after> [seed args]}"; shift || true
PREP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="/Volumes/ExternalWork/todos/perf-canvas-20261028/$side"
EVID="/private/tmp/beef-perf/round7"
app="/private/tmp/beef-perf/apps7/BeefTV7-$side.app"
data="/private/tmp/beef-perf/data7/$side"

[[ -d "$app" ]] || { echo "隔离客户端不存在: $app" >&2; exit 1; }
[[ -d "$WT" ]] || { echo "工作树不存在: $WT" >&2; exit 1; }

# 只杀这一轮的隔离客户端；绝不碰正式客户端 /Applications/BeefTV.app 或 com.wails.beeftv。
pkill -f "/private/tmp/beef-perf/apps7/BeefTV7-" >/dev/null 2>&1 || true
sleep 1
# 画布缓存在 WKWebsiteDataStore（按 bundle id 分区，不在 --data-dir 里）。只写数据库不会改变界面。
store="$HOME/Library/WebKit/com.wails.beeftv.perfcanvas7-$side"
archive="/private/tmp/beef-perf/webkit-store-archive7/$side"
rm -rf "$archive"
mkdir -p "$(dirname "$archive")"
if [ -d "$store" ]; then mv "$store" "$archive"; fi
mkdir -p "$data"
rm -f "$data/runtime.json"

python3 "$PREP/seed-canvas.py" "$data" --nodes 300 --title perf300 --canvas-id perf300 "$@"
if [ "${RECOVER:-0}" = "1" ]; then
  python3 "$PREP/seed-recovery-task.py" "$data" --upstream "${UPSTREAM:-http://127.0.0.1:19118}"
fi

mkdir -p "$EVID"
rm -f "$EVID/perf-$side.ndjson" "$EVID/perf-$side.ndjson.dump.jsonl"

# 用 python 起会话（start_new_session）：需要把后端访问日志留在本轮目录里，又必须脱离当前进程组。
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
echo "side=$side head=$(git -C "$WT" rev-parse HEAD)"
echo "probe=$(shasum -a 256 "$WT/web/src/perf-probe.ts" | cut -d' ' -f1)"
echo "binary=$(shasum -a 256 "$app/Contents/MacOS/BeefTV" | cut -d' ' -f1)"
echo "app=$app data=$data"
pgrep -f "$app/Contents/MacOS/BeefTV" | head -1
