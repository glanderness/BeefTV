#!/usr/bin/env python3
"""解析第六轮原件；可选执行留存回调的窄复放，不启动页面、客户端或 Go。"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
OUT = HERE / "6654c90a"
SOURCE = OUT / "source/docs/performance/2026-10-28-canvas-interaction"
CONTROLLER = "web/src/pages/canvas/use-canvas-connection-controller.ts"
REFS = {"before": "6a155448096d2425aa07e81cc6016410091ad0be", "after": "e54d4863d52244c5b024464c70e6a1e9e7a4e0c7"}


def fields(summary):
    return dict(re.findall(r"([^\s=]+)=([^\s]+)", summary))


def frame_stats(frames):
    ordered = sorted(frames)
    quantile = lambda p: ordered[min(len(ordered) - 1, int(len(ordered) * p))] if ordered else 0
    return {"帧": len(frames), "fps": f"{len(frames) / sum(frames) * 1000:.1f}" if sum(frames) else "-",
            "p50": quantile(.5), "p95": quantile(.95), "p99": quantile(.99),
            "max": max(frames, default=0), "gt33": sum(v > 33.4 for v in frames),
            "gt50": sum(v > 50 for v in frames), "gt100": sum(v > 100 for v in frames)}


def analyze():
    result = {"authorCommit": "6654c90afa98534f8d3fc155d53d5b3e91494bae", "runs": [], "commits": {}}
    for side in REFS:
        path = SOURCE / f"round6/perf-{side}.ndjson.dump.jsonl"
        for line, raw in enumerate(path.read_text().splitlines(), 1):
            p = json.loads(raw)["payload"]
            stats = frame_stats(p["frames"])
            expected = fields(p["summary"])
            assert all(str(v) == expected[k] for k, v in stats.items()), (side, line, stats, expected)
            sizes = {k: len(p[k]) for k in ["frames", "frameTimestamps", "frameMonotonic", "frameDropTargets", "frameIndexBuilds"]}
            assert len(set(sizes.values())) == 1, sizes
            calls = p["counters"]["dropTargetCalls"]
            assert calls == len(p["dropTargets"]) == sum(p["frameDropTargets"])
            assert sum(p["frameIndexBuilds"]) == p["counters"]["indexBuilds"]
            marked = [v for v, count in zip(p["frames"], p["frameDropTargets"]) if count]
            sequence = []
            for drop in p["dropTargets"]:
                node = drop["nodeId"]
                if sequence and sequence[-1]["nodeId"] == node:
                    sequence[-1]["calls"] += 1
                    sequence[-1]["lastAt"] = drop["t"]
                else:
                    sequence.append({"nodeId": node, "calls": 1, "firstAt": drop["t"], "lastAt": drop["t"]})
            down = next((v for v in p["inputs"] if v["type"] == "pointerdown"), None)
            up = next((v for v in p["inputs"] if v["type"] == "pointerup"), None)
            inside = [i for i, t in enumerate(p["frameTimestamps"]) if down and up and down["t"] <= t <= up["t"]]
            marked_indices = [i for i, count in enumerate(p["frameDropTargets"]) if count]
            marked_stats = frame_stats(marked)
            # 不连续的计数标记帧不能组成一段实际 FPS。
            marked_stats.pop("fps")
            result["runs"].append({"side": side, "line": line, "runId": p["runId"], "stats": stats,
                "arrayLengths": sizes, "frameSpanMs": sum(p["frames"]),
                "recordingSpanMs": p["stoppedAt"] - p["startedAt"],
                "startRecord": p["startLog"][-1], "inputs": p["inputs"],
                "pointerDurationMs": up["t"] - down["t"] if down and up else None,
                "targetSequence": sequence, "finalDropTarget": p["dropTargets"][-1] if calls else None,
                "dropCallCount": calls, "dropCounterMs": p["counters"]["dropTargetMs"],
                "dropLogMs": sum(v["ms"] for v in p["dropTargets"]),
                "markedFrameStats": marked_stats, "markedFrameCount": len(marked),
                "frameCallbacksWithinPointerDownUp": len(inside),
                "markedFramesOutsidePointerDownUp": [{"index": i, "msAfterPointerUp": p["frameTimestamps"][i] - up["t"], "frameIntervalMs": p["frames"][i]} for i in marked_indices if up and i not in inside],
                "markedFramePercent": len(marked) / len(p["frames"]) * 100 if p["frames"] else None,
                "missingInputFields": ["pointerId", "buttons", "handleType", "current", "world", "viewport", "containerRect", "screen/display identity"]})
        log = (SOURCE / f"round6/app-{side}.log").read_text()
        result["commits"][side] = [{"line": n, "text": text} for n, text in enumerate(log.splitlines(), 1)
                                    if '"POST /api/ops/canvas.document.commit"' in text]
    manifest = json.loads((OUT / "manifest.json").read_text())
    old_log = (SOURCE / "round5/isolated-client-access.log").read_text()
    old_timestamps = re.findall(r"\[(2026-10-28T[^]]+)\]", old_log)
    result["recoveredRound5Log"] = {
        "sha256": hashlib.sha256((SOURCE / "round5/isolated-client-access.log").read_bytes()).hexdigest(),
        "firstAccessAt": min(old_timestamps), "lastAccessAt": max(old_timestamps),
        "commits": [{"line": n, "text": text} for n, text in enumerate(old_log.splitlines(), 1) if '"POST /api/ops/canvas.document.commit"' in text],
        "sameRecordingWindow": [{"commitAt": "14:56:47", "recording": "remote-revision 第3段 14:56:33–14:56:53"}, {"commitAt": "14:57:43", "recording": "remote-revision 第4段 14:57:31–14:57:51"}],
        "limitation": "仅秒级同窗关系，未证明具体失败分支、主线程因果或早期连接窗口请求。",
    }
    repo = HERE.parents[2]
    for item in manifest["originals"] + manifest["worktreeSourceReadbacks"]:
        data = (repo / item["archivePath"]).read_bytes()
        assert len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"], item
    prior = (HERE.parent / "2026-10-28-canvas-connection-index.md").read_bytes()[:manifest["priorReportBytes"]]
    assert hashlib.sha256(prior).hexdigest() == manifest["priorReportSha256"]
    result["verifiedFixedOriginals"] = len(manifest["originals"])
    result["verifiedSourceReadbacks"] = len(manifest["worktreeSourceReadbacks"])
    result["scope"] = "独立重算数组与核对原件；标记帧仅指计数有增量的帧，不自动等于完整手势活动区间或屏幕呈现帧。"
    (OUT / "independent-round6.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"runs": len(result["runs"]), "summaryRecalculation": "通过", "fixedOriginals": len(manifest["originals"]), "sourceReadbacks": len(manifest["worktreeSourceReadbacks"])}, ensure_ascii=False))


def callbacks(source, after):
    blocks = []
    for name in ["getConnectionDropTarget", "getBatchConnectionDropTarget"]:
        start = source.index("    const " + name + " = useCallback(")
        end = source.index("\n    }, [", start)
        end = source.index("\n", end + 1)
        blocks.append(source[start:end])
    imports = '''import { batchReferenceHandleAtY } from "@/lib/canvas/canvas-batch-table";
import { batchSourceRestriction, hasBatchConnectionCandidate } from "@/lib/canvas/canvas-batch-connection";
import { canvasConnectionError } from "@/lib/canvas/canvas-connection-policy";
import { isFrameNode, isNodeHiddenByCollapsedFrame } from "@/lib/canvas/canvas-frame";
import { getConnectionTargetAnchor, isHiddenBatchChild, normalizeConnection, storyboardHandleAtY } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";
import { defaultConfig } from "@/stores/use-config-store";
type CanvasConnectionDropTarget=any; type ConnectionDropTarget=any; type BatchConnectionDropTarget=any;
'''
    if after:
        imports += 'import { resolveConnectionDropTarget, resolveBatchConnectionDropTarget } from "@/lib/canvas/canvas-connection-target";\n'
    return imports + '''export function make(nodes:any[],connections:any[]) {
const nodesRef={current:nodes},connectionsRef={current:connections},viewportRef={current:{k:1}};
const config=defaultConfig,scriptScrollTopById={},CONNECTION_SNAP_RADIUS=56;
const screenToCanvas=(x:number,y:number)=>({x,y}); const useCallback=(f:any,_deps:any)=>f;
''' + "\n".join(blocks) + '\nreturn {ordinary:getConnectionDropTarget,batch:getBatchConnectionDropTarget};\n}\n'


def replay(source_repo, dependencies):
    runner = r'''import {strict as assert} from "node:assert";
import {make as original} from "./original"; import {make as recorded} from "./recorded";
import rows from "./nodes.json";
const probeLogs:any[]=[];
const normalize=(r:any)=>({nodeId:r.nodeId??null,handleId:r.handleId??null,anchorRatio:r.anchorRatio??null,isNearNode:r.isNearNode});
const cases:any[]=[
 {name:"19-output-before-zone",kind:"ordinary",x:908,y:450,current:{nodeId:"perf-node-19",handleType:"source"}},
 {name:"19-output-near20",kind:"ordinary",x:980,y:450,current:{nodeId:"perf-node-19",handleType:"source"}},
 {name:"20-input-near19",kind:"ordinary",x:930,y:450,current:{nodeId:"perf-node-20",handleType:"target"}},
 {name:"20-input-away19",kind:"ordinary",x:980,y:450,current:{nodeId:"perf-node-20",handleType:"target"}},
 {name:"batch-source19",kind:"batch",x:980,y:450,sources:["perf-node-19"]},
 {name:"batch-no-source",kind:"batch",x:980,y:450,sources:[]}
];
const results=[];
for(const item of cases){
 const a=original(structuredClone(rows),[]), b=recorded(structuredClone(rows),[]);
 const perf:any={dropTargetCalls:0,dropTargetMs:0,indexBuilds:0,indexBuildMs:0,indexQueries:0,indexQueryMs:0,indexCandidates:0};
 (globalThis as any).__perf=perf;
 (globalThis as any).__perfLogDropTarget=(target:any,ms:number)=>probeLogs.push({target,ms});
 const call=(c:any)=>item.kind==="ordinary"?c.ordinary(item.x,item.y,item.current):c.batch(item.x,item.y,item.sources);
 const before=normalize(call(a));probeLogs.length=0;const after=normalize(call(b));
 assert.deepEqual(after,before);assert.equal(probeLogs.length,1);assert.equal(perf.dropTargetCalls,1);
 assert.equal(probeLogs[0].target.nodeId??null,after.nodeId);
 assert.equal(probeLogs[0].target.handleId??null,after.handleId);
 results.push({input:item,original:before,recorded:after,loggedTarget:probeLogs[0].target,calls:perf.dropTargetCalls});
}
console.log(JSON.stringify({scope:"实际留存回调与各自未插桩回调的同输入比较；identity坐标、指定源/handle；不是原生手势或历史现场复现",results}));
'''
    results = {}
    scratch = HERE.parents[2] / ".local"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="canvas-round6-", dir=scratch) as temp:
        for side, ref in REFS.items():
            snapshot = Path(temp) / side
            snapshot.mkdir()
            data = subprocess.check_output(["git", "-C", str(source_repo), "archive", ref, "web/src", "web/tsconfig.json", "web/package.json", "backend/internal/providerpreset"])
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                archive.extractall(snapshot, filter="data")
            (snapshot / "web/node_modules").symlink_to(dependencies.resolve(), target_is_directory=True)
            directory = snapshot / "web/scripts"
            directory.mkdir(exist_ok=True)
            old = subprocess.check_output(["git", "-C", str(source_repo), "show", ref + ":" + CONTROLLER]).decode()
            actual = (OUT / "readback" / side / CONTROLLER).read_text()
            (directory / "original.ts").write_text(callbacks(old, side == "after"))
            (directory / "recorded.ts").write_text(callbacks(actual, side == "after"))
            db = json.loads((OUT / "database-readback.json").read_text())
            (directory / "nodes.json").write_text(json.dumps(db[0]["nodes18to20"]))
            (directory / "runner.ts").write_text(runner)
            run = subprocess.run(["bun", "run", "scripts/runner.ts"], cwd=snapshot / "web", capture_output=True, text=True)
            (OUT / f"{side}-callback-replay.txt").write_text(run.stdout + run.stderr)
            if run.returncode:
                raise RuntimeError(run.stderr)
            results[side] = json.loads(run.stdout)
    assert [x["recorded"] for x in results["before"]["results"]] == [x["recorded"] for x in results["after"]["results"]]
    (OUT / "callback-replay.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print("两侧各6项：记录钩子目标/返回值/单次计数一致；同输入两侧一致。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-repo", type=Path)
    parser.add_argument("--dependencies", type=Path)
    args = parser.parse_args()
    analyze()
    if args.source_repo and args.dependencies:
        replay(args.source_repo, args.dependencies)
