#!/usr/bin/env python3
"""复放第三轮的测量材料修正：种子端点、探针帧标记与计时口径、边界取样覆盖与旧索引敏感性。

只用已有前端依赖，不安装、不联网、不启动开发服务器、不启动原生客户端、不接触数据库或
正式数据。所有临时副本都在 `.local/` 忽略目录里，用完清理。

    python3 verify-tools.py --dependencies /path/to/web/node_modules \
        --output docs/performance/2026-10-28-canvas-interaction/verify-tools.json

需要本机已有 Playwright Chromium 或 `CHROME_PATH`（只有真实控制器入口用例需要浏览器）。
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BASELINE = "6a155448096d2425aa07e81cc6016410091ad0be"
FIRST_INDEX = "f7b82b710e593e959573d6594aeada6048b6d3a9"
CANDIDATE = "e54d4863d52244c5b024464c70e6a1e9e7a4e0c7"
TARGET = "web/src/lib/canvas/canvas-connection-target.ts"
TARGET_IN_WEB = "src/lib/canvas/canvas-connection-target.ts"

PROBE_RUNNER = r'''import vm from "node:vm";
import { readFileSync } from "node:fs";
const buttons: any[] = [], frames: Function[] = [];
const create = () => ({ style: {}, children: [] as any[], setAttribute() {}, append(...args: any[]) { this.children.push(...args); buttons.push(...args); } });
const window: any = {};
const context = { window, document: { title: "", body: create(), createElement: create, querySelectorAll: () => [] }, performance: { now: () => 0 }, requestAnimationFrame: (f: Function) => { frames.push(f); }, fetch: () => Promise.resolve(), setTimeout() {}, location: { hash: "" } };
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(process.argv[2], "utf8"));
vm.runInNewContext(code, context);
const click = (name: string) => buttons.find(b => b.textContent === name).onclick({ stopPropagation() {} });
click("perf-rec-start");
// 一帧内各发生一次落点查询与一次索引建立，另给两个计时字段固定值以便核对不再重复相加。
window.__perf.dropTargetCalls += 1;
window.__perf.indexBuilds += 1;
window.__perf.indexBuildMs = 3;
window.__perf.indexQueryMs = 1;
frames.shift()!(16.67);
click("perf-rec-stop");
console.log(JSON.stringify({ scope: "隔离 JS 探针：一帧内一次落点、一次建立；未启动客户端", output: window.__perfLast }));
'''


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=REPO)


def probe_source(patch_text: str) -> str:
    """从补丁里取回探针源码，不依赖任何硬编码的行数。"""
    marker = "diff --git a/web/src/perf-probe.ts b/web/src/perf-probe.ts"
    body = patch_text.split(marker, 1)[1].splitlines()
    start = next(index for index, line in enumerate(body) if line.startswith("@@"))
    return "\n".join(line[1:] for line in body[start + 1:] if line.startswith("+")) + "\n"


def copy_worktree_web(root: Path) -> Path:
    """把当前工作树的 web 源码复制进临时目录，保证验证的是待提交的那份。"""
    web = root / "web"
    web.mkdir(parents=True)
    for name in ["src", "scripts", "test"]:
        shutil.copytree(REPO / "web" / name, web / name, ignore=shutil.ignore_patterns("node_modules", ".local*"))
    for name in ["tsconfig.json", "package.json"]:
        shutil.copyfile(REPO / "web" / name, web / name)
    preset = root / "backend" / "internal" / "providerpreset"
    preset.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(REPO / "backend" / "internal" / "providerpreset", preset)
    return web


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dependencies", required=True, type=Path, help="已有 web/node_modules，只读复用")
    parser.add_argument("--output", type=Path, default=HERE / "verify-tools.json")
    args = parser.parse_args()
    dependencies = args.dependencies.resolve()
    if not (dependencies / "nanoid").exists():
        raise SystemExit("请指定已有 web/node_modules；脚本不会联网安装依赖")

    summary: dict = {
        "baseline": BASELINE,
        "first_index_candidate": FIRST_INDEX,
        "tangent_fix_candidate": CANDIDATE,
        "source_sha256": {},
        "commands": [],
    }

    # 1) 种子：普通与分组两种形态的连线端点都必须存在。
    seed = types.ModuleType("verify_seed")
    exec(compile((HERE / "seed-canvas.py").read_text(), "seed-canvas.py", "exec"), seed.__dict__)
    summary["seed"] = []
    for grouped in (False, True):
        payload = seed.build_payload("verify300", "免费假数据", 300, grouped)
        check = seed.verify_payload(payload)
        check["grouped"] = grouped
        summary["seed"].append(check)
    if any(item["invalidEndpoints"] for item in summary["seed"]):
        raise SystemExit("种子仍有失效连线端点")

    patch = (HERE / "native-probe.patch").read_text()
    summary["native_probe_patch_sha256"] = hashlib.sha256(patch.encode()).hexdigest()

    scratch = REPO / ".local" / "canvas-tools-verify"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="run-", dir=scratch) as directory:
        root = Path(directory)
        web = copy_worktree_web(root)
        (web / "node_modules").symlink_to(dependencies, target_is_directory=True)

        for name in [TARGET, "web/scripts/canvas-interaction-bench.ts", "web/test/canvas-connection-drop.browser.test.ts", "docs/performance/2026-10-28-canvas-interaction/seed-canvas.py"]:
            summary["source_sha256"][name] = hashlib.sha256((REPO / name).read_bytes()).hexdigest()

        # 2) 补丁能在候选快照上干净应用（基线控制器不参与，这里只查候选侧）。
        candidate_root = root / "candidate"
        candidate_root.mkdir()
        with tarfile.open(fileobj=io.BytesIO(git("archive", CANDIDATE, "web/src", "web/test", "web/scripts", "web/package.json", "web/tsconfig.json", "backend/internal/providerpreset"))) as archive:
            archive.extractall(candidate_root, filter="data")
        patch_path = root / "native-probe.patch"
        patch_path.write_text(patch)
        check = subprocess.run(["git", "apply", "--check", "--unsafe-paths", f"--directory={candidate_root}", str(patch_path)], cwd=root, capture_output=True, text=True)
        summary["native_patch_applies_on_candidate"] = {"exitCode": check.returncode, "output": (check.stdout + check.stderr).strip()}

        # 3) 探针：帧级标记要随计数增加，查询耗时不能把建立算进去。
        (web / "scripts/verify-probe-runner.ts").write_text(PROBE_RUNNER)
        probe_path = web / "scripts/verify-probe-source.ts"
        probe_path.write_text(probe_source(patch))
        command = ["bun", "run", "scripts/verify-probe-runner.ts", str(probe_path)]
        result = run(command, web)
        summary["commands"].append(" ".join(command))
        if result.returncode:
            raise SystemExit(result.stderr)
        summary["probe"] = json.loads(result.stdout)

        # 4) 边界取样：当前实现 0 差异，且真的命中合法目标；换回首轮索引必须出现差异。
        command = ["bun", "run", "scripts/canvas-interaction-bench.ts", "--boundary"]
        result = run(command, web)
        summary["commands"].append(" ".join(command))
        if result.returncode:
            raise SystemExit(result.stderr)
        boundary = json.loads(result.stdout)["boundaryParity"]
        summary["boundary_current"] = {"samples": boundary["samples"], "mismatches": boundary["mismatches"], "byFixture": boundary["byFixture"], "coverage": boundary["coverage"]}
        (web / TARGET_IN_WEB).write_bytes(git("show", f"{FIRST_INDEX}:{TARGET}"))
        result = run(command, web)
        if result.returncode:
            raise SystemExit(result.stderr)
        boundary = json.loads(result.stdout)["boundaryParity"]
        summary["boundary_first_index"] = {"samples": boundary["samples"], "mismatches": boundary["mismatches"], "byFixture": boundary["byFixture"]}
        (web / TARGET_IN_WEB).write_bytes((REPO / TARGET).read_bytes())

        # 5) 随机取样：两个 resolver、规模可控、不跑计时。
        command = ["bun", "run", "scripts/canvas-interaction-bench.ts", "--parity"]
        result = run(command, web)
        summary["commands"].append(" ".join(command))
        if result.returncode:
            raise SystemExit(result.stderr)
        parity = json.loads(result.stdout)
        summary["parity"] = {"counts": parity["parityCounts"], **{key: value for key, value in parity["parity"].items() if key != "examples"}, "timingSkipped": parity["connectionDropTarget"] == {} and parity["indexCost"] == {} and parity["nodeOperationLookup"] == {}}

        # 6) 真实控制器入口：当前实现通过，换回首轮索引必须失败。
        command = ["bun", "test", "test/canvas-connection-drop.browser.test.ts"]
        result = run(command, web)
        summary["commands"].append(" ".join(command))
        summary["browser_current"] = {"exitCode": result.returncode, "tail": (result.stdout + result.stderr).strip().splitlines()[-5:]}
        (web / TARGET_IN_WEB).write_bytes(git("show", f"{FIRST_INDEX}:{TARGET}"))
        result = run(command, web)
        summary["browser_first_index"] = {"exitCode": result.returncode, "tail": (result.stdout + result.stderr).strip().splitlines()[-5:]}
        (web / TARGET_IN_WEB).write_bytes((REPO / TARGET).read_bytes())

    assert all(item["invalidEndpoints"] == 0 for item in summary["seed"]), summary["seed"]
    assert "含落点帧=1" in summary["probe"]["output"] and "含重建帧=1" in summary["probe"]["output"], summary["probe"]
    assert "索引建立耗时=3" in summary["probe"]["output"] and "索引查询耗时=1" in summary["probe"]["output"] and "索引合计耗时=4" in summary["probe"]["output"], summary["probe"]
    assert summary["native_patch_applies_on_candidate"]["exitCode"] == 0, summary["native_patch_applies_on_candidate"]
    assert summary["boundary_current"]["mismatches"] == 0, summary["boundary_current"]
    assert summary["boundary_first_index"]["mismatches"] > 0, summary["boundary_first_index"]
    assert all(item["ordinaryHit"] > 0 and item["batchHit"] > 0 for item in summary["boundary_current"]["coverage"].values()), summary["boundary_current"]["coverage"]
    assert summary["parity"]["mismatches"] == 0 and summary["parity"]["samples"] == 5400 and summary["parity"]["timingSkipped"], summary["parity"]
    assert summary["browser_current"]["exitCode"] == 0, summary["browser_current"]
    assert summary["browser_first_index"]["exitCode"] != 0, summary["browser_first_index"]

    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(f"测量材料复放通过；结果写入 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
