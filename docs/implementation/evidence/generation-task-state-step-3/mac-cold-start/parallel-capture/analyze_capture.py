#!/usr/bin/env python3
"""只读已解码 trace，定位冷启动主 goroutine；不运行 Go、测试或客户端。"""
import argparse
import collections
import gzip
import json
from pathlib import Path
import re

PHASES = ("database_and_schema", "service_and_plugins", "builtin_initializers", "composition_and_routes")
EVENT = re.compile(rb"^M=(-?\d+) P=(-?\d+) G=(-?\d+) (\w+) Time=(\d+)(.*)$")


def field(details, name):
    match = re.search(rb"\b" + name.encode() + rb'=("(?:\\.|[^"\\])*"|\S+)', details)
    if not match:
        return None
    return json.loads(match[1]) if match[1].startswith(b'"') else match[1].decode()


def analyze(decoded, output):
    target = None
    matches = []
    regions = {name: {} for name in PHASES}
    transitions = []
    phase_logs = []
    state = "Running"
    state_since = None
    segments = []
    mismatches = []
    selected = False
    output.mkdir(exist_ok=True)
    with gzip.open(decoded, "rb") as stream, (output / "cold-selected-events.txt").open("xb") as selected_file:
        for line in stream:
            match = EVENT.match(line)
            if not match:
                if selected:
                    selected_file.write(line)
                continue
            selected = False
            goroutine, kind, at, details = int(match[3]), match[4].decode(), int(match[5]), match[6]
            if kind == "Log" and b'Category="data_dir"' in details and b"TestDesktopColdOpenBudgetAndNoIdleOutbound" in details:
                found = {"task": int(field(details, "Task")), "goroutine": goroutine,
                         "data_dir": field(details, "Message"), "data_log_time_ns": at}
                matches.append(found)
                if target is None:
                    target = found
                    state_since = at
            if target is None:
                continue
            task = field(details, "Task") if b"Task=" in details else None
            is_target_transition = kind == "StateTransition" and field(details, "GoID") == str(target["goroutine"])
            selected = goroutine == target["goroutine"] or task == str(target["task"]) or is_target_transition
            if selected:
                selected_file.write(line)
            if task == str(target["task"]) and kind in ("RegionBegin", "RegionEnd"):
                name = field(details, "Type") or field(details, "Name")
                if name in regions:
                    key = "start_ns" if kind == "RegionBegin" else "end_ns"
                    if key in regions[name]:
                        raise ValueError("目标阶段重复：" + name)
                    regions[name][key] = at
            if task == str(target["task"]) and kind == "Log" and field(details, "Category") == "STEP3_COLD_PHASE":
                phase_logs.append({"time_ns": at, "message": field(details, "Message")})
            if is_target_transition:
                change = re.search(rb"\b(\w+)->(\w+)\b", details)
                if not change:
                    raise ValueError("无法读取状态转换")
                before, after = change[1].decode(), change[2].decode()
                if before != state:
                    mismatches.append({"time_ns": at, "expected": state, "actual": before})
                if at < state_since:
                    raise ValueError("状态时间倒退")
                segments.append((state_since, at, state))
                transitions.append({"time_ns": at, "before": before, "after": after, "reason": field(details, "Reason")})
                state, state_since = after, at
    if len(matches) != 1:
        raise ValueError("冷启动Open不是唯一实例：" + str(len(matches)))
    if any(set(value) != {"start_ns", "end_ns"} for value in regions.values()):
        raise ValueError("四阶段不完整：" + str(regions))
    end = max(value["end_ns"] for value in regions.values())
    if state_since < end:
        segments.append((state_since, end, state))
    rows = []
    for name in PHASES:
        window = regions[name]
        counts = collections.Counter()
        for start, stop, status in segments:
            duration = min(stop, window["end_ns"]) - max(start, window["start_ns"])
            if duration > 0:
                counts[status] += duration
        wall = window["end_ns"] - window["start_ns"]
        if sum(counts.values()) != wall:
            raise ValueError("阶段状态时间未覆盖整个窗口：" + name)
        rows.append({"phase": name, **window, "region_wall_ns": wall, "main_goroutine_state_ns": dict(counts)})
    result = {
        "target": target, "matching_open_count": len(matches), "phases": rows,
        "phase_timing_logs": phase_logs, "state_transition_count": len(transitions),
        "state_mismatches": mismatches,
        "scope": "只计Open主goroutine的region墙钟；Runnable是Go调度等待，Running不是精确CPU时间，Syscall也不是已知磁盘原因",
        "selected_events": "cold-selected-events.txt是完整解码输出的原字节子集，原始二进制trace另行保留",
    }
    (output / "cold-state-analysis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    (output / "cold-state-transitions.json").write_text(json.dumps(transitions, ensure_ascii=False, indent=2) + "\n")
    if mismatches:
        raise ValueError("存在状态不一致，不据此报告调度总量")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--decoded", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(analyze(args.decoded, args.output), ensure_ascii=False, indent=2))
