"""仅回环的免费上游：放行前等待客户端超时，放行后提供确定的 PNG。"""
import json
import pathlib
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

gate = pathlib.Path(sys.argv[1])
port = int(sys.argv[2])
colors = [(24,126,218),(245,176,40),(35,184,130),(202,74,158)]
pixels = bytearray()
for y in range(200):
    pixels.append(0)
    for x in range(320):
        cross = (144 <= x < 176 and 28 <= y < 172) or (88 <= x < 232 and 84 <= y < 116)
        pixels.extend((255,255,255) if cross else colors[(y//100)*2+x//160])
def chunk(kind, value):
    return struct.pack('!I',len(value))+kind+value+struct.pack('!I',zlib.crc32(kind+value))
png = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',320,200,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
def record(**fields):
    print(json.dumps(dict(time=time.time(),**fields)),flush=True)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        record(event='request',method='GET',path=self.path)
        if self.path != '/original.png':
            self.send_error(404)
            return
        while not gate.exists(): time.sleep(.1)
        try:
            self.send_response(200)
            self.send_header('Content-Type','image/png')
            self.send_header('Content-Length',str(len(png)))
            self.end_headers()
            self.wfile.write(png)
            record(event='response',status=200,bytes=len(png))
        except (BrokenPipeError,ConnectionResetError):
            record(event='client_disconnected')
    def do_POST(self):
        record(event='forbidden_generation',method='POST',path=self.path)
        self.send_error(405)
record(event='listening',address=f'127.0.0.1:{port}')
ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
