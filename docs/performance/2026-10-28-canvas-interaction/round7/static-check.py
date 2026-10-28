#!/usr/bin/env python3
"""第七轮静态核对：不启动客户端、不编译 Go、不联网。

做三件事，结果写 static-check.json：

1. 补丁可用性：把固定产品提交（before 6a155448 / after e54d4863）里的被测文件取到临时目录，
   用 git apply 逐个套上 round6 / round7 补丁。第六轮补丁套完的结果必须与 #101 复核归档的
   readback 文件逐字节一致（哈希来自 instrumentation-hashes.json）；第七轮补丁套完的结果必须
   含第七轮要求的新字段。
2. 数字可复算：只读 round6/ 里的逐帧导出，重算帧数/fps/p50/p95/p99/max/gt33、落点目标序列、
   松手时目标、完整 down/up 区间内的 rAF 回调数、计数标记帧，并与 #101 复核的
   independent-round6.json 对照。
3. 探针口径：round7 探针必须暴露 __perfLogDropTarget / __perfLogConnectStart，并按每个
   pointerId 手势处理 move。

用法：
    python3 static-check.py --repo <BeefTV 仓库根> [--out static-check.json]
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PERF = HERE.parent
ROUND6_DIR = PERF / "round6"
ROUND7_DIR = HERE

SIDES = {
    "before": {
        "commit": "6a155448096d2425aa07e81cc6016410091ad0be",
        "files": [
            "web/src/components/canvas/canvas-node.tsx",
            "web/src/lib/operation-progress.ts",
            "web/src/main.tsx",
            "web/src/pages/canvas/project.tsx",
            "web/src/pages/canvas/use-canvas-connection-controller.ts",
        ],
    },
    "after": {
        "commit": "e54d4863d52244c5b024464c70e6a1e9e7a4e0c7",
        "files": [
            "web/src/components/canvas/canvas-node.tsx",
            "web/src/lib/canvas/canvas-connection-target.ts",
            "web/src/lib/operation-progress.ts",
            "web/src/main.tsx",
            "web/src/pages/canvas/project.tsx",
            "web/src/pages/canvas/use-canvas-connection-controller.ts",
        ],
    },
}

# 第七轮必须在插桩控制器里出现的新记录点。
ROUND7_REQUIRED_TOKENS = [
    "__perfLogConnectStart",
    "perfConnectStartRecord",
    "perfDropTargetRecord",
    "containerRect",
    "viewportK",
    "targetNodeId",
    "targetHandleId",
    'entry:',
]


def git_show(repo: Path, commit: str, path: str) -> str:
    return subprocess.run(["git", "-C", str(repo), "show", f"{commit}:{path}"], check=True, capture_output=True, text=True).stdout


def apply_patch_check(repo: Path, side: str, patch: Path) -> dict:
    """在临时目录里把固定产品文件取出来，套上补丁，返回套完后的文件内容。"""
    with tempfile.TemporaryDirectory(prefix=f"bfv-static-{side}-") as tmp:
        tmp_path = Path(tmp)
        for path in SIDES[side]["files"]:
            target = tmp_path / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(git_show(repo, SIDES[side]["commit"], path), encoding="utf-8")
        check = subprocess.run(["git", "apply", "--check", "-p1", str(patch)], cwd=tmp_path, capture_output=True, text=True)
        if check.returncode != 0:
            return {"ok": False, "error": check.stderr.strip()}
        subprocess.run(["git", "apply", "-p1", str(patch)], cwd=tmp_path, check=True, capture_output=True, text=True)
        result = {}
        for path in SIDES[side]["files"]:
            result[path] = (tmp_path / path).read_text(encoding="utf-8")
        probe = tmp_path / "web/src/perf-probe.ts"
        result["web/src/perf-probe.ts"] = probe.read_text(encoding="utf-8") if probe.exists() else ""
        return {"ok": True, "files": result}


def sha256_text(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def quantile(sorted_values: list, p: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, int(len(sorted_values) * p))] if sorted_values else 0.0


def recompute_run(dump: dict) -> dict:
    frames = dump.get("frames") or []
    stamps = dump.get("frameTimestamps") or []
    sorted_frames = sorted(frames)
    span = sum(frames)
    stats = {
        "帧": len(frames),
        "fps": round((len(frames) / span) * 1000, 1) if span else "-",
        "p50": round(quantile(sorted_frames, 0.5), 3),
        "p95": round(quantile(sorted_frames, 0.95), 3),
        "p99": round(quantile(sorted_frames, 0.99), 3),
        "max": round(sorted_frames[-1], 3) if sorted_frames else 0,
        "gt33": len([v for v in sorted_frames if v > 33.4]),
    }
    # 落点目标序列：相邻同目标合并成一段。
    sequence = []
    for record in dump.get("dropTargets") or []:
        node_id = record.get("nodeId", "")
        if sequence and sequence[-1]["nodeId"] == node_id:
            sequence[-1]["calls"] += 1
            sequence[-1]["lastAt"] = record["t"]
        else:
            sequence.append({"nodeId": node_id, "calls": 1, "firstAt": record["t"], "lastAt": record["t"]})
    # 完整 down/up 区间内的 rAF 回调：只对 pointerdown→pointerup 匹配的输入。
    gestures = dump.get("gestures")
    if gestures is None:
        # 第六轮没有 gestures 数组：退回用输入序列里同一 pointerId 的 down/up 配对。
        gestures = []
        pending = {}
        for item in dump.get("inputs") or []:
            if item["type"] == "pointerdown":
                pending[item.get("pointerId", 0)] = item
            elif item["type"] in ("pointerup", "pointercancel") and item.get("pointerId", 0) in pending:
                down = pending.pop(item.get("pointerId", 0))
                gestures.append({"pointerId": item.get("pointerId", 0), "downT": down["t"], "endT": item["t"]})
    inside = 0
    for gesture in gestures:
        inside += len([s for s in stamps if gesture["downT"] <= s <= gesture["endT"]])
    marked = len([v for v in (dump.get("frameDropTargets") or []) if v > 0])
    return {
        "runId": dump.get("runId"),
        "startSeq": dump.get("startSeq"),
        "stats": stats,
        "arrayLengths": {key: len(dump.get(key) or []) for key in ("frames", "frameTimestamps", "frameMonotonic", "frameDropTargets", "frameIndexBuilds")},
        "recordingSpanMs": round((dump.get("stoppedAt", 0) or 0) - (dump.get("startedAt", 0) or 0)),
        "targetSequence": sequence,
        "finalDropTarget": (dump.get("dropTargets") or [None])[-1],
        "dropCallCount": len(dump.get("dropTargets") or []),
        "intervals": {
            "整窗帧": len(frames),
            "完整downup区间内rAF": inside,
            "计数标记帧": marked,
            "手势数": len(gestures),
            "connectStarts": len(dump.get("connectStarts") or []),
        },
        "missingFieldsVsRound7": [
            key for key in ("connectStarts", "gestures") if key not in dump
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--out", default=str(HERE / "static-check.json"))
    args = parser.parse_args()

    hashes = json.loads((ROUND7_DIR / "instrumentation-hashes.json").read_text(encoding="utf-8"))
    report = {"scope": "只读固定提交、补丁与已入库逐帧导出；未启动客户端/Go/网络。", "patches": {}, "probe": {}, "runs": [], "compare": {}}

    for side in SIDES:
        side_report = {}
        for round_name, patch_name in (("round6", f"round6-instrumentation-{side}.patch"), ("round7", f"round7-instrumentation-{side}.patch")):
            applied = apply_patch_check(args.repo, side, ROUND7_DIR / patch_name)
            entry = {"ok": applied["ok"]}
            if applied["ok"]:
                files = applied["files"]
                if round_name == "round6":
                    expected = hashes["sides"][side]["round6Readback"]
                    mismatched = {path: {"expected": expected[path], "actual": sha256_text(text)} for path, text in files.items() if expected.get(path) != sha256_text(text)}
                    entry["readbackHashMatch"] = not mismatched
                    entry["mismatched"] = mismatched
                    # 若随本轮入库了 #101 的读回原件，直接逐字节比对，不依赖另一条分支。
                    local = {}
                    for path, text in files.items():
                        local_file = ROUND7_DIR / "readback" / side / path
                        if local_file.exists() and local_file.read_text(encoding="utf-8") != text:
                            local[path] = str(local_file)
                    entry["readbackSourceCompared"] = bool(local) or (ROUND7_DIR / "readback" / side).exists()
                    entry["readbackSourceMismatched"] = local
                else:
                    controller = files["web/src/pages/canvas/use-canvas-connection-controller.ts"]
                    entry["requiredTokens"] = {token: token in controller for token in ROUND7_REQUIRED_TOKENS}
                    entry["allRequiredTokens"] = all(entry["requiredTokens"].values())
                    probe = files["web/src/perf-probe.ts"]
                    entry["probeHash"] = sha256_text(probe)
                    entry["probeHashMatch"] = entry["probeHash"] == hashes["sides"][side]["round7"]["web/src/perf-probe.ts"]
            else:
                entry["error"] = applied.get("error")
            side_report[round_name] = entry
        report["patches"][side] = side_report

    probe7 = (ROUND7_DIR / "perf-probe-round7.ts").read_text(encoding="utf-8")
    report["probe"] = {
        "hooks": {hook: (hook in probe7) for hook in ("__perfLogDropTarget", "__perfLogConnectStart")},
        "perPointerIdGestures": "activeGestures" in probe7 and "gestureLog" in probe7,
        "threeIntervals": "frameCallbacksWithinGestures" in probe7,
        "hoverAggregate": "hoverMoveCount" in probe7,
    }

    for side in SIDES:
        path = ROUND6_DIR / f"perf-{side}.ndjson.dump.jsonl"
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            envelope = json.loads(line)
            # perf-sink.py 落盘的每条是 {at, receivedAt, payload}，payload 才是探针导出的那份。
            payload = envelope.get("payload", envelope)
            report["runs"].append({"side": side, **recompute_run(payload)})

    independent_path = ROUND7_DIR / "independent-round6.json"
    if independent_path.exists():
        independent = json.loads(independent_path.read_text(encoding="utf-8"))
        by_run = {run["runId"]: run for run in independent["runs"]}
        mismatches = []
        for run in report["runs"]:
            reference = by_run.get(run["runId"])
            if not reference:
                continue
            for key in ("帧", "fps", "p50", "p95", "p99", "max", "gt33"):
                recomputed, reviewed = run["stats"][key], reference["stats"][key]
                same = str(recomputed) == str(reviewed)
                if not same:
                    try:
                        same = float(recomputed) == float(reviewed)
                    except (TypeError, ValueError):
                        same = False
                if not same:
                    mismatches.append({"runId": run["runId"], "key": key, "recomputed": recomputed, "review": reviewed})
            if run["intervals"]["计数标记帧"] != reference["markedFrameCount"]:
                mismatches.append({"runId": run["runId"], "key": "markedFrameCount", "recomputed": run["intervals"]["计数标记帧"], "review": reference["markedFrameCount"]})
            if run["intervals"]["完整downup区间内rAF"] != reference["frameCallbacksWithinPointerDownUp"]:
                mismatches.append({"runId": run["runId"], "key": "frameCallbacksWithinPointerDownUp", "recomputed": run["intervals"]["完整downup区间内rAF"], "review": reference["frameCallbacksWithinPointerDownUp"]})
        report["compare"]["independentRound6"] = {"runsCompared": len(by_run), "mismatches": mismatches}

    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = all(report["patches"][side][name].get("ok") for side in SIDES for name in ("round6", "round7"))
    print(json.dumps({
        "patchesOk": ok,
        "round6ReadbackHashMatch": {side: report["patches"][side]["round6"].get("readbackHashMatch") for side in SIDES},
        "round7TokensOk": {side: report["patches"][side]["round7"].get("allRequiredTokens") for side in SIDES},
        "compareMismatches": len(report["compare"].get("independentRound6", {}).get("mismatches", [])),
        "runs": [f"{r['side']}:{r['runId']}" for r in report["runs"]],
        "out": args.out,
    }, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
