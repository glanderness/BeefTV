#!/usr/bin/env python3
"""本地测量结果接收端：把探针发来的计数落到文本文件。

原生客户端（WKWebView）里没法把测量结果写文件，也没法从无障碍树可靠读回一长串
数字，所以探针用 `fetch(..., {mode: "no-cors"})` 把结果发到本机回环端口，这里按行
追加到文件。只监听 127.0.0.1，不落任何用户数据。

    python3 perf-sink.py --port 8799 --out /path/to/perf-native.ndjson

两个入口：

- `GET /perf?kind=…&d=…`：第五轮用的汇总行（`start` / `stop` / `ports` / `centers`）。
  仍然支持，旧探针构建可以直接跑。
- `POST /perf`（body 是 JSON）：第六轮新增的完整导出。逐帧间隔、每次落点调用的实际目标、
  每次真实输入的起止都是**数组**，塞进 query string 会被长度限制截断，所以走 POST，落到
  `<--out>.dump.jsonl`（每行一次录制的完整 JSON）。只有拿到这些原始数组，事后才能复算
  FPS / p95 并把拖线与空闲分开——第五轮只存了汇总，`round5/*.ndjson` 里的 `stop` 行没有
  逐帧数据，无法复算（#101 复核）。
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

OUT = None
DUMP_OUT = None
MAX_BODY = 64 << 20


class Handler(BaseHTTPRequestHandler):
    # 探针用 fetch(..., {keepalive: true}) 回传。BaseHTTPRequestHandler 默认回 HTTP/1.0
    # 并关连接，WKWebView 会把这种响应当成失败并重发同一个请求，接收端因此可能收到重复
    # 请求。这里回 HTTP/1.1 并显式带 Content-Length，减少无谓重发。
    # 注意：接收端只记录请求，**重发与「真的又点了一次开始」在这里分不开**，也不能由重复
    # 请求推断前端重置过计数器——重复 start 只说明那段录制窗口不完整。要判定是否真的重启，
    # 看第六轮探针在页面侧留的 runId / 单调 startSeq 与真实输入起止（perf-probe-round6.ts）。
    protocol_version = "HTTP/1.1"

    def _respond(self, status: int, body: bytes = b"") -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/perf":
            self._respond(404, b"{}")
            return
        query = parse_qs(parsed.query)
        record = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "kind": (query.get("kind") or [""])[0],
            "data": (query.get("d") or [""])[0],
        }
        with OUT.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._respond(204)

    def do_OPTIONS(self):  # noqa: N802
        self._respond(204)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/perf":
            self._respond(404, b"{}")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._respond(413, b"{}")
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            # 保留原始字节，便于事后确认是探针发错还是解析问题。
            payload = {"unparsed": raw.decode("utf-8", "replace")}
        record = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "receivedAt": time.time(), "payload": payload}
        with DUMP_OUT.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._respond(204)

    def log_message(self, *_args):
        return


def main() -> int:
    global OUT, DUMP_OUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--out", required=True, help="汇总行 ndjson（GET /perf）")
    parser.add_argument("--dump-out", default="", help="完整导出行 jsonl（POST /perf）；缺省为 <--out>.dump.jsonl")
    args = parser.parse_args()
    OUT = Path(args.out)
    DUMP_OUT = Path(args.dump_out) if args.dump_out else Path(str(OUT) + ".dump.jsonl")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"perf sink listening on 127.0.0.1:{args.port} -> {OUT} (dumps -> {DUMP_OUT})", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
