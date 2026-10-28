#!/usr/bin/env python3
"""只解析已归档的固定材料，不启动客户端、连接数据库或重跑产品测试。"""
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT / "16d2e903"
SOURCE = EVIDENCE / "source/docs/performance/2026-10-28-canvas-interaction"


def main():
    samples = []
    duplicates = []
    inventory = []
    totals = {"files": 0, "starts": 0, "stops": 0}
    for path in sorted((SOURCE / "round5").glob("*.ndjson")):
        records = [json.loads(line) for line in path.read_text().splitlines()]
        starts = []
        stop_number = 0
        totals["files"] += 1
        for line, record in enumerate(records, 1):
            if record["kind"] == "start":
                totals["starts"] += 1
                starts.append({"line": line, "at": record["at"]})
            if record["kind"] != "stop":
                continue
            totals["stops"] += 1
            stop_number += 1
            fields = dict(re.findall(r"([^\s=]+)=([^\s]+)", record["data"]))
            numbers = {k: float(v) for k, v in fields.items() if re.fullmatch(r"-?\d+(?:\.\d+)?", v)}
            frames = int(numbers["帧"])
            fps = numbers["fps"]
            calls = int(numbers["落点调用"])
            spans = [
                (datetime.fromisoformat(record["at"]) - datetime.fromisoformat(start["at"])).total_seconds()
                for start in starts
            ]
            sample = {
                "file": path.name,
                "stopNumber": stop_number,
                "stopLine": line,
                "sinkStopAt": record["at"],
                "startsSincePreviousStop": starts,
                "sinkElapsedSecondsFromEachStart": spans,
                "fields": fields,
                "meanDropTargetMs": numbers["落点总耗时"] / calls if calls else None,
                "framesWithDropTargetPercent": numbers["含落点帧"] / frames * 100,
                "gt33_4Percent": numbers["gt33"] / frames * 100,
                "gt50Percent": numbers["gt50"] / frames * 100,
                "spanSecondsInferredFromRoundedFps": frames / fps,
                "spanSecondsRangeFromFpsRounding": [frames / (fps + 0.05), frames / (fps - 0.05)],
                "rawFrameIntervalsAvailable": False,
                "rawCallbackDurationsAvailable": False,
            }
            samples.append(sample)
            if len(starts) != 1:
                duplicates.append({"file": path.name, "stopNumber": stop_number, "starts": starts,
                                   "note": "接收端记录不能区分重复传输与前端再次开始；不据此断言实际 reset。"})
            starts = []
        inventory.append({"file": path.name, "records": len(records), "stops": stop_number,
                          "unmatchedStarts": starts})

    manifest = json.loads((EVIDENCE / "manifest.json").read_text())
    # 原报告已经追加第五轮，旧报告应作为逐字节前缀保存；其余原件完全相同。
    verification = []
    repo_root = ROOT.parents[2]
    for source in manifest["sources"]:
        data = (repo_root / source["archivePath"]).read_bytes()
        if source["archivePath"].endswith("2026-10-28-canvas-connection-index.md"):
            data = data[:source["bytes"]]
        actual = hashlib.sha256(data).hexdigest()
        if len(data) != source["bytes"] or actual != source["sha256"]:
            raise ValueError("原件字节不一致: " + source["archivePath"])
        verification.append({"path": source["archivePath"], "bytes": len(data), "sha256": actual})

    builds = json.loads((SOURCE / "native-builds.json").read_text())
    patches = []
    for side in builds["sides"]:
        patch = SOURCE / side["patch"]["file"]
        actual = hashlib.sha256(patch.read_bytes()).hexdigest()
        patches.append({"side": side["side"], "sha256": actual,
                        "matchesAuthorBuildRecord": actual == side["patch"]["sha256"]})
    if not all(item["matchesAuthorBuildRecord"] for item in patches):
        raise ValueError("补丁与作者构建记录哈希不一致")

    result = {
        "authorCommit": manifest["authorCommit"],
        "totals": totals,
        "inventory": inventory,
        "multipleOrMissingStarts": duplicates,
        "samples": samples,
        "patchHashes": patches,
        "preservedOriginalsVerified": verification,
        "limitations": [
            "帧率、分位数、阈值帧数只在作者汇总中存在，未从逐帧数据独立复算。",
            "由四舍五入后的 fps 推导的时长只是估算，不是原始窗口时长或拖线活动时长。",
            "落点均值是累计毫秒除以调用数，不是单次分布、p95 或完整手势耗时。",
            "sink 的本地时间精确到秒，记录接收时间，不是输入或前端事件时间。",
        ],
    }
    (EVIDENCE / "independent-native-data.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"totals": totals, "ambiguousStartWindows": len(duplicates),
                      "originalFilesVerified": len(verification), "patchHashesMatch": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
