#!/usr/bin/env python3
"""复放测量材料：种子端点、探针帧标记与计时口径、边界取样覆盖、旧索引敏感性，以及
两个固定源码各自的同口径插桩材料（双侧钉选、交叉归属、完整应用、类型检查、探针复放）。

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
import re
import shutil
import subprocess
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
CONTROLLER = "web/src/pages/canvas/use-canvas-connection-controller.ts"
PROBE = "web/src/perf-probe.ts"

# 两个固定源码各配一份探针补丁：共享探针模块逐字节相同，只有落点回调的插桩按各自实现写。
SIDES = {
    "before": {"ref": BASELINE, "patch": "native-probe-baseline.patch"},
    "after": {"ref": CANDIDATE, "patch": "native-probe.patch"},
}

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

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=REPO)


def probe_source(patch_text: str) -> str:
    """从补丁里取回探针源码，不依赖任何硬编码的行数。"""
    marker = f"diff --git a/{PROBE} b/{PROBE}"
    body = patch_text.split(marker, 1)[1].splitlines()
    start = next(index for index, line in enumerate(body) if line.startswith("@@"))
    return "\n".join(line[1:] for line in body[start + 1:] if line.startswith("+")) + "\n"


def patch_files(patch_text: str) -> list[str]:
    return re.findall(r"^diff --git a/(\S+) b/\S+$", patch_text, re.M)


def declared_counters(probe_text: str) -> set[str]:
    block = probe_text.split("type PerfCounters = {", 1)[1].split("};", 1)[0]
    return set(re.findall(r"^\s{4}(\w+): number;", block, re.M))


def referenced_counters(source: str) -> set[str]:
    return set(re.findall(r"perf\.(\w+)\s*\+=", source))


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


def extract_snapshot(ref: str, root: Path) -> None:
    """按固定提交取一份完整前端快照（含 vite.config.ts 与它依赖的仓库脚本），用于插桩与类型检查。"""
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(git("archive", ref, "web", "scripts", "backend/internal/providerpreset"))) as archive:
        archive.extractall(root, filter="data")


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True)


def apply_patch(patch_path: Path, target: Path, check: bool, cwd: Path) -> dict:
    """`git apply --directory` 只在仓库根目录作为 cwd 时才真的按目标路径检查：在仓库子目录里
    执行会对任何补丁都返回 0 且不做任何事（空跑）。所以 cwd 固定为仓库根，且调用方必须断言
    输出内容，不能只看退出码。"""
    command = ["git", "apply", "--unsafe-paths", f"--directory={target}"]
    if check:
        command.insert(2, "--check")
    result = subprocess.run([*command, str(patch_path)], cwd=cwd, capture_output=True, text=True)
    return {"exitCode": result.returncode, "output": (result.stdout + result.stderr).strip()}


def probe_material(root: Path, dependencies: Path, summary: dict) -> None:
    """两侧插桩材料：钉选两个固定源码，交叉验证补丁归属，完整应用、类型检查并复放探针。"""
    side_root = root / "sides"
    sides: dict = {}
    for name, spec in SIDES.items():
        snapshot = side_root / name
        extract_snapshot(spec["ref"], snapshot)
        (snapshot / "web/node_modules").symlink_to(dependencies, target_is_directory=True)
        patch_path = HERE / spec["patch"]
        patch_text = patch_path.read_text()
        record = {
            "ref": spec["ref"],
            "patch": spec["patch"],
            "patchSha256": hashlib.sha256(patch_text.encode()).hexdigest(),
            "patchFiles": patch_files(patch_text),
            "applies": {},
        }
        for other_name, other in SIDES.items():
            record["applies"][other["patch"]] = apply_patch(HERE / other["patch"], snapshot, True, REPO) | {"side": other_name}
        own = apply_patch(patch_path, snapshot, False, REPO)
        if own["exitCode"]:
            raise SystemExit(f"{spec['patch']} 不能在 {spec['ref']} 上完整应用: {own['output']}")
        record["ownApply"] = own

        controller = (snapshot / CONTROLLER).read_text()
        probe_text = (snapshot / PROBE).read_text()
        referenced: set[str] = set()
        index_sites = 0
        for relative in record["patchFiles"]:
            path = snapshot / relative
            if path.suffix not in {".ts", ".tsx"} or relative == PROBE:
                continue
            source = path.read_text()
            referenced |= referenced_counters(source)
            # 探针模块自己也会读这些字段，所以索引计数只统计产品侧的写入点。
            index_sites += source.count("perf.index")
        declared = declared_counters(probe_text)
        record["instrumentation"] = {
            "beginSites": controller.count("const begin = perf ? performance.now() : 0;"),
            "dropTargetCallSites": controller.count("perf.dropTargetCalls += 1"),
            "dropTargetMsSites": controller.count("perf.dropTargetMs += performance.now() - begin"),
            "indexCounterSites": index_sites,
            "targetModulePresent": (snapshot / TARGET).exists(),
            "declaredCounters": sorted(declared),
            "referencedCounters": sorted(referenced),
            "undeclaredCounters": sorted(referenced - declared),
        }
        check = run(["bun", "x", "tsc", "--noEmit"], snapshot / "web")
        record["typecheck"] = {"command": "bun x tsc --noEmit", "exitCode": check.returncode, "tail": ANSI.sub("", check.stdout + check.stderr).strip().splitlines()[-4:]}
        summary["commands"].append(f"[{name}] bun x tsc --noEmit")

        runner = snapshot / "web/scripts/verify-probe-runner.ts"
        runner.write_text(PROBE_RUNNER)
        probe_file = snapshot / "web/scripts/verify-probe-source.ts"
        probe_file.write_text(probe_source(patch_text))
        result = run(["bun", "run", "scripts/verify-probe-runner.ts", str(probe_file)], snapshot / "web")
        summary["commands"].append(f"[{name}] bun run scripts/verify-probe-runner.ts <该侧补丁的 perf-probe.ts>")
        if result.returncode:
            raise SystemExit(result.stderr)
        record["probeReplay"] = json.loads(result.stdout)
        sides[name] = record

    summary["probe_material"] = sides
    summary["probe_material_apply_invocation"] = "git apply --check --unsafe-paths --directory=<固定快照> <补丁>（cwd=仓库根）"
    summary["probe_material_shared_probe_sha256"] = hashlib.sha256((side_root / "before" / PROBE).read_bytes()).hexdigest()
    summary["probe_material_shared_probe_identical"] = (side_root / "before" / PROBE).read_bytes() == (side_root / "after" / PROBE).read_bytes()

    # 归档脚本用临时目录当 cwd，那种调用对任何补丁都返回 0（空跑）。把两种 cwd 都记下来，
    # 证明「退出码 0」在那种调用下不构成检查。
    command = ["git", "apply", "--check", "--unsafe-paths", f"--directory={side_root / 'before'}", str(HERE / SIDES["after"]["patch"])]
    vacuous = subprocess.run(command, cwd=root, capture_output=True, text=True)
    strict = subprocess.run(command, cwd=REPO, capture_output=True, text=True)
    summary["probe_material_cwd_hazard"] = {
        "note": "同一份候选补丁对基线快照：cwd=临时目录时空跑并返回 0，cwd=仓库根时返回 1。归档 verify-tools.py 用的是前者。",
        "command": " ".join(command[:3]) + " <补丁>",
        "cwd_temp_dir": {"exitCode": vacuous.returncode, "output": (vacuous.stdout + vacuous.stderr).strip()},
        "cwd_repo_root": {"exitCode": strict.returncode, "output": (strict.stdout + strict.stderr).strip()},
    }


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
    summary["native_probe_baseline_patch_sha256"] = hashlib.sha256((HERE / "native-probe-baseline.patch").read_bytes()).hexdigest()

    scratch = REPO / ".local" / "canvas-tools-verify"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="run-", dir=scratch) as directory:
        root = Path(directory)
        web = copy_worktree_web(root)
        (web / "node_modules").symlink_to(dependencies, target_is_directory=True)

        for name in [TARGET, "web/scripts/canvas-interaction-bench.ts", "web/test/canvas-connection-drop.browser.test.ts", "docs/performance/2026-10-28-canvas-interaction/seed-canvas.py"]:
            summary["source_sha256"][name] = hashlib.sha256((REPO / name).read_bytes()).hexdigest()

        # 2) 两侧插桩材料：before/after 各自钉选固定源码，交叉与完整应用，再类型检查与探针复放。
        probe_material(root, dependencies, summary)

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
    assert summary["boundary_current"]["mismatches"] == 0, summary["boundary_current"]
    assert summary["boundary_first_index"]["mismatches"] > 0, summary["boundary_first_index"]
    assert all(item["ordinaryHit"] > 0 and item["batchHit"] > 0 for item in summary["boundary_current"]["coverage"].values()), summary["boundary_current"]["coverage"]
    assert summary["parity"]["mismatches"] == 0 and summary["parity"]["samples"] == 5400 and summary["parity"]["timingSkipped"], summary["parity"]
    assert summary["browser_current"]["exitCode"] == 0, summary["browser_current"]
    assert summary["browser_first_index"]["exitCode"] != 0, summary["browser_first_index"]

    # 两侧插桩材料：交叉归属必须互斥，各自能完整应用、通过类型检查，并且共用计数与计时口径一致。
    material = summary["probe_material"]
    before, after = material["before"], material["after"]
    assert before["ref"] == BASELINE and after["ref"] == CANDIDATE, material
    assert before["applies"]["native-probe-baseline.patch"]["exitCode"] == 0, before["applies"]
    assert after["applies"]["native-probe.patch"]["exitCode"] == 0, after["applies"]
    cross_before = before["applies"]["native-probe.patch"]
    cross_after = after["applies"]["native-probe-baseline.patch"]
    assert cross_before["exitCode"] != 0, cross_before
    assert "canvas-connection-target.ts: No such file or directory" in cross_before["output"], cross_before
    assert "use-canvas-connection-controller.ts" in cross_before["output"], cross_before
    assert cross_after["exitCode"] != 0, cross_after
    assert "use-canvas-connection-controller.ts" in cross_after["output"], cross_after
    # 同一个命令换成临时目录当 cwd 就变成空跑：这条差异正是归档脚本「通过」的原因。
    hazard = summary["probe_material_cwd_hazard"]
    assert hazard["cwd_temp_dir"]["exitCode"] == 0, hazard
    assert hazard["cwd_temp_dir"]["output"] == "", hazard
    assert hazard["cwd_repo_root"]["exitCode"] != 0, hazard
    assert TARGET in after["patchFiles"] and TARGET not in before["patchFiles"], material
    assert summary["probe_material_shared_probe_identical"], summary["probe_material_shared_probe_sha256"]
    assert before["typecheck"]["exitCode"] == 0, before["typecheck"]
    assert after["typecheck"]["exitCode"] == 0, after["typecheck"]
    for name, side in material.items():
        assert side["instrumentation"]["beginSites"] == 2, (name, side["instrumentation"])
        assert side["instrumentation"]["dropTargetMsSites"] == side["instrumentation"]["dropTargetCallSites"], (name, side["instrumentation"])
        assert not side["instrumentation"]["undeclaredCounters"], (name, side["instrumentation"])
        assert "含落点帧=1" in side["probeReplay"]["output"] and "索引合计耗时=4" in side["probeReplay"]["output"], (name, side["probeReplay"])
    # 基线侧两条出口都要计数（普通 1 + 批量 2），且不得引入索引计数；候选侧只在落点模块里记索引。
    assert before["instrumentation"]["dropTargetCallSites"] == 3, before["instrumentation"]
    assert before["instrumentation"]["indexCounterSites"] == 0, before["instrumentation"]
    assert before["instrumentation"]["targetModulePresent"] is False, before["instrumentation"]
    assert after["instrumentation"]["dropTargetCallSites"] == 2, after["instrumentation"]
    assert after["instrumentation"]["indexCounterSites"] == 5, after["instrumentation"]
    assert after["instrumentation"]["targetModulePresent"] is True, after["instrumentation"]

    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(f"测量材料复放通过；结果写入 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
