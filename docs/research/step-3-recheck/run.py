#!/usr/bin/env python3
"""研究用复现器：导出只读提交，在临时目录运行真实 Go 入口，结束后删除副本。"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", required=True, help="已有 BeefTV 仓库的绝对路径，只读")
parser.add_argument("--ref", default="e08b6bea", help="要核对的源码提交")
parser.add_argument("--billing-probe", action="store_true", help="只在临时副本应用扣费投影实验补丁")
parser.add_argument("--run", default="^TestStep3", help="Go 测试筛选表达式")
parser.add_argument("--output", required=True, help="简要 JSON 证据文件")
args = parser.parse_args()
ref = subprocess.check_output(["git", "-C", args.repo, "rev-parse", args.ref], text=True).strip()
archive = subprocess.check_output(["git", "-C", args.repo, "archive", ref, "backend", "plugins"])
scratch = HERE.parents[2] / ".local" / "cache"
scratch.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="step3-", dir=scratch) as directory:
    root = Path(directory)
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        bundle.extractall(root, filter="data")
    shutil.copyfile(HERE / "app_probe_test.go.txt", root / "backend/internal/app/step3_research_test.go")
    shutil.copyfile(HERE / "repository_probe_test.go.txt", root / "backend/internal/repository/step3_research_test.go")
    if args.billing_probe:
        subprocess.run(["patch", "-p1", "-i", str(HERE / "billing-probe.patch")], cwd=root, check=True)
    command = ["go", "test", "./internal/app", "./internal/repository", "-run", args.run, "-count=1", "-timeout=90s", "-json"]
    # 不向测试进程传团队凭据；生成调用只由夹具提供本地地址和假 Key。
    env = {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "TMPDIR", "GOCACHE", "GOMODCACHE", "GOTOOLCHAIN", "CGO_ENABLED", "SDKROOT", "DEVELOPER_DIR"}}
    proc = subprocess.run(command, cwd=root / "backend", env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    results, messages, package_results = {}, {}, {}
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        name = event.get("Test")
        action = event.get("Action")
        if name and action in {"pass", "fail", "skip"}:
            results[name] = action
        if name and action == "output":
            output = event.get("Output", "").strip()
            # 证据只保留夹具断言，不带 SQL 调试日志、临时目录或机器路径。
            if output.startswith("step3_research_test.go:"):
                messages.setdefault(name, []).append(output)
        if not name and action in {"pass", "fail"}:
            package_results[event["Package"]] = action
    receipt = {"source_commit": ref, "variant": "billing-probe" if args.billing_probe else "baseline", "command": command, "exit_code": proc.returncode, "tests": results, "messages": messages, "packages": package_results, "stderr": proc.stderr}
    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    raise SystemExit(proc.returncode)
