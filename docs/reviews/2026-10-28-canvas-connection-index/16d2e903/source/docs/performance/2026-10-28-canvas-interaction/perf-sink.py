#!/usr/bin/env python3
"""本地测量结果接收端：把探针发来的计数落到一个文本文件。

原生客户端（WKWebView）里没法把测量结果写文件，也没法从无障碍树可靠读回一长串
数字，所以探针用 `fetch(..., {mode: "no-cors"})` 把结果发到本机回环端口，这里按行
追加到文件。只监听 127.0.0.1，不落任何用户数据。

    python3 perf-sink.py --port 8799 --out /path/to/perf-native.ndjson
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

OUT = None


class Handler(BaseHTTPRequestHandler):
    # 探针用 fetch(..., {keepalive: true}) 回传。BaseHTTPRequestHandler 默认回 HTTP/1.0
    # 并关连接，WKWebView 会把这种响应当成失败并重发同一个请求：一次 perf-rec-start
    # 曾落成三条 start 记录，后两条正好在拖拽中途把计数器清零（2026-10-28 实测
    # perf-after-grouped1000-r1）。这里回 HTTP/1.1 并显式带 Content-Length。
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/perf":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        query = parse_qs(parsed.query)
        record = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "kind": (query.get("kind") or [""])[0],
            "data": (query.get("d") or [""])[0],
        }
        with OUT.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args):
        return


def main() -> int:
    global OUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    OUT = Path(args.out)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"perf sink listening on 127.0.0.1:{args.port} -> {OUT}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
