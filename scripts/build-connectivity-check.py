"""Build an unsigned customer kit without credentials or live capabilities."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cos-host", required=True)
    args = parser.parse_args()
    args.output = args.output.resolve()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*-[0-9]+\.cos\.ap-[a-z-]+\.myqcloud\.com", args.cos_host):
        parser.error("cos-host must be an official COS bucket hostname")
    kit = args.output / "BeefTV-network-check-windows-x64"
    kit.mkdir(parents=True, exist_ok=False)
    env = {**os.environ, "CGO_ENABLED": "0", "GOOS": "windows", "GOARCH": "amd64"}
    subprocess.run(["go", "build", "-trimpath", "-o", str(kit / "BeefTV-network-check.exe"), "./cmd/connectivity-check"], cwd=ROOT / "backend", env=env, check=True)
    targets = {"targets": [
        {"name": "企业 API", "url": "https://enterprise.beefapi.com/api/status"},
        {"name": "国内 API", "url": "https://beefapi.com/api/status"},
        {"name": "广州 COS", "url": f"https://{args.cos_host}/"},
    ]}
    (kit / "targets.json").write_text(json.dumps(targets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (kit / "启动网络检测.cmd").write_bytes(b'@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n"BeefTV-network-check.exe"\r\n')
    instructions = """BeefTV 企业网络检测

1. 完整解压到可写文件夹，保持与报错时相同的代理和网络设置。
2. 双击“启动网络检测.cmd”，按提示填写支持编号、办公网点、网络和 BeefTV 版本，可以留空。
3. 公网 IP 采集默认关闭；输入 Y 才同意。报告不会自动发送。
4. 有客服提供的有效 session.json 才会上传约 197 KB / 3.15 MB 合成图片并完整回读；没有会话只做基础检测。
5. 最多约 3 分钟。完成后打开报告 HTML 检查，再将同名报告 ZIP 发给客服。
6. Ctrl+C 会停止并尝试清理；强制关闭时回传已留下的 JSON，不要把未测当通过。

不读取 API Key、客户素材、电脑名或项目，不提交生成，不扣生成费用，不修改系统代理。
深度测试有少量 COS 流量。工具不自动上传报告。
HTTP 401/403 可能表示 HTTPS 已连通，不代表业务成功；无法保证之后始终连通。
客户端测试不能证明供应商可以读取 COS，也不验证 API 服务器转存或生成。
不要回传 session.json，它含短期操作链接。通用包没有会话，客服按事件签发。
可用 SHA256.txt 核对文件；这是独立未签名工具，不是 BeefTV 安装包或更新。
"""
    (kit / "使用说明.txt").write_text(instructions.replace("\n", "\r\n"), encoding="utf-8-sig")
    hashes = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}" for p in sorted(kit.iterdir()) if p.is_file()]
    (kit / "SHA256.txt").write_text("\n".join(hashes) + "\n", encoding="utf-8")
    archive = args.output / (kit.name + ".zip")
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(kit.iterdir()):
            z.write(p, kit.name + "/" + p.name)
    print(json.dumps({"zip": str(archive), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "contains_session": False}))


if __name__ == "__main__":
    main()
