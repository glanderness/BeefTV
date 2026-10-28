#!/usr/bin/env python3
"""常驻的本地假上游（只回环，零付费）：把一张确定的 PNG 当成本地上游的产物。

用途：让 BeefTV 后端**自己的**取回循环真的去下载一次上游产物，从而走通
「后台取回 → 资源落盘 → 画布文档 revision 前进 → 客户端 4 秒兜底轮询取回新快照并应用」
这条完整交叠路径。第五轮只用手工改 revision 模拟了客户端那一半，服务端那一半没有数据。

    python3 upstream.py --port 19118 --gate /tmp/perf-gate --log upstream.jsonl \
        [--artifact /artifact.png] [--path-per-request]

行为：
- 默认在放行文件 `--gate` 出现之前**不回应**（挂住连接），用来让客户端/后端先超时或先停在
  「等待取回」状态；`touch <gate>` 之后开始正常返回。
- 只实现 GET，且只回应 `--artifact` 指定的那一个路径；其他路径 404。
- POST 一律 405 并记一条 `forbidden_generation`：本夹具不模拟生成，不产生任何费用。
- 每个请求/响应写一行 JSON 到 `--log`（缺省写 stdout），用于事后核对请求次数与放行时间。

来源：`docs/release-evidence/v2.0.5-client-recovery-acceptance/upstream.py`（#87 完整桌面免费
恢复验收用过的那一份），这里只加了 `--port/--log/--artifact` 参数化与放行时间记录，
图片内容与协议行为保持一致。
"""
import argparse
import json
import pathlib
import struct
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GATE: pathlib.Path
LOG = None
ARTIFACT = "/artifact.png"
_LOCK = threading.Lock()


def build_png() -> bytes:
    """320x200 的四色白十字 PNG：和 #87 用过的那张逐字节同构，便于跨任务对照。"""
    colors = [(24, 126, 218), (245, 176, 40), (35, 184, 130), (202, 74, 158)]
    pixels = bytearray()
    for y in range(200):
        pixels.append(0)
        for x in range(320):
            cross = (144 <= x < 176 and 28 <= y < 172) or (88 <= x < 232 and 84 <= y < 116)
            pixels.extend((255, 255, 255) if cross else colors[(y // 100) * 2 + x // 160])

    def chunk(kind: bytes, value: bytes) -> bytes:
        return struct.pack("!I", len(value)) + kind + value + struct.pack("!I", zlib.crc32(kind + value))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack("!2I5B", 320, 200, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels))
        + chunk(b"IEND", b"")
    )


PNG = build_png()


def record(**fields) -> None:
    line = json.dumps(dict(time=time.time(), at=time.strftime("%Y-%m-%dT%H:%M:%S"), **fields), ensure_ascii=False)
    with _LOCK:
        if LOG is None:
            print(line, flush=True)
        else:
            with LOG.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        return

    def handle_error(self, request, client_address):
        # 放行前挂住连接时，客户端超时会先断开；这属于夹具的预期行为，不当异常刷屏。
        record(event="client_disconnected", path=getattr(self, "path", ""))

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        record(event="request", method="GET", path=self.path)
        if path != ARTIFACT:
            self.send_error(404)
            record(event="response", status=404, path=self.path)
            return
        waited = 0.0
        while not GATE.exists():
            time.sleep(0.1)
            waited += 0.1
        try:
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
            record(event="response", status=200, bytes=len(PNG), waitedSeconds=round(waited, 1))
        except (BrokenPipeError, ConnectionResetError):
            record(event="client_disconnected", waitedSeconds=round(waited, 1))

    def do_POST(self):  # noqa: N802
        record(event="forbidden_generation", method="POST", path=self.path)
        self.send_error(405)


def main() -> int:
    global GATE, LOG, ARTIFACT
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=19118)
    parser.add_argument("--gate", required=True, help="放行文件：出现前不回应产物请求")
    parser.add_argument("--log", default="", help="jsonl 落盘路径；缺省写 stdout")
    parser.add_argument("--artifact", default="/artifact.png", help="产物路径（画布/回执里的 URL 要指向它）")
    args = parser.parse_args()
    GATE = pathlib.Path(args.gate)
    LOG = pathlib.Path(args.log) if args.log else None
    ARTIFACT = args.artifact if args.artifact.startswith("/") else "/" + args.artifact
    if GATE.exists():
        GATE.unlink()
    if LOG is not None:
        LOG.parent.mkdir(parents=True, exist_ok=True)
    record(event="listening", address=f"127.0.0.1:{args.port}", artifact=ARTIFACT, gate=str(GATE), pngBytes=len(PNG))
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
