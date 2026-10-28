#!/usr/bin/env python3
"""只复放双侧补丁与真实插桩回调，不构建客户端、不重跑无变化研究。"""
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
REPO = HERE.parents[2]
REVISION = "caf2c1cefbf76eb2afcbca7cdf0dae1ea4a2b05c"
SIDES = {"before": ("6a155448096d2425aa07e81cc6016410091ad0be", "native-probe-baseline.patch"), "after": ("e54d4863d52244c5b024464c70e6a1e9e7a4e0c7", "native-probe.patch")}
MATERIALS = "docs/performance/2026-10-28-canvas-interaction/"
CONTROLLER = "web/src/pages/canvas/use-canvas-connection-controller.ts"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO)


def callback_module(source, after):
    """逐字提取实际应用后的两个回调，只提供其宿主变量；没有重写动作分支。"""
    blocks = []
    for name in ["getConnectionDropTarget", "getBatchConnectionDropTarget"]:
        begin = source.index("    const " + name + " = useCallback(")
        end = source.index("\n    }, [", begin)
        end = source.index("\n", end + 1)
        blocks.append(source[begin:end])
    imports = '''import { batchReferenceHandleAtY } from "@/lib/canvas/canvas-batch-table";
import { batchSourceRestriction, hasBatchConnectionCandidate } from "@/lib/canvas/canvas-batch-connection";
import { canvasConnectionError } from "@/lib/canvas/canvas-connection-policy";
import { isFrameNode, isNodeHiddenByCollapsedFrame } from "@/lib/canvas/canvas-frame";
import { getConnectionTargetAnchor, isHiddenBatchChild, normalizeConnection, storyboardHandleAtY } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";
import { defaultConfig } from "@/stores/use-config-store";
type CanvasConnectionDropTarget = any; type ConnectionDropTarget = any; type BatchConnectionDropTarget = any;
'''
    if after:
        imports += 'import { resolveConnectionDropTarget, resolveBatchConnectionDropTarget } from "@/lib/canvas/canvas-connection-target";\n'
    return imports + '''export function makeCallbacks(nodes: CanvasNodeData[], advance: (ms:number)=>void) {
    const nodesRef={current:nodes}, connectionsRef={current:[]}, viewportRef={current:{k:1}};
    const config=defaultConfig, scriptScrollTopById={}, CONNECTION_SNAP_RADIUS=56;
    const screenToCanvas=(x:number,y:number)=>{advance(7);return {x,y};};
    const useCallback=(fn:any,_dependencies:any[])=>fn;
''' + "\n".join(blocks) + '''
    return { ordinary:getConnectionDropTarget, batch:getBatchConnectionDropTarget };
}
'''


RUNNER = r'''import {mock} from "bun:test";
import {strict as assert} from "node:assert";
let clock=0;
const real=await import("@/lib/canvas/canvas-spatial-index");
const build=real.buildCanvasSpatialIndex, bounds=real.canvasNodeBounds;
mock.module("@/lib/canvas/canvas-spatial-index",()=>({canvasNodeBounds:bounds,buildCanvasSpatialIndex:(entries:any[])=>{
    clock+=3;const index=build(entries);return {query:(...args:any[])=>{clock+=1;return index.query(...args)}};
}}));
Object.defineProperty(globalThis,"performance",{configurable:true,value:{now:()=>clock}});
const {makeCallbacks}=await import("./actual-callbacks");
const after=process.argv[2]==="after";
const freshNodes=()=>[
    {id:"source",type:"image",title:"源",position:{x:0,y:0},width:320,height:180},
    {id:"target",type:"image",title:"目标",position:{x:1000,y:0},width:320,height:180}
];
const reset=()=>{const p:any={dropTargetCalls:0,dropTargetMs:0,indexBuilds:0,indexBuildMs:0,indexQueries:0,indexQueryMs:0,indexCandidates:0};(globalThis as any).__perf=p;return p;};
const cases:any[]=[];
for(const kind of ["ordinary","batch"] as const){
    const nodes=freshNodes(), callbacks=makeCallbacks(nodes,(ms:number)=>clock+=ms), p=reset();
    for(const phase of ["cold","hot"]){
        const begin={...p};
        const result=kind==="ordinary"?callbacks.ordinary(944,90,{nodeId:"source",handleType:"source"}):callbacks.batch(944,90,["source"]);
        assert.equal(result.nodeId,"target"); assert.equal(result.isNearNode,true);
        const delta=Object.fromEntries(Object.keys(p).map(k=>[k,p[k]-begin[k]]));
        const expected=after?(phase==="cold"?11:8):7;
        assert.equal(delta.dropTargetCalls,1);assert.equal(delta.dropTargetMs,expected);
        assert.equal(delta.indexBuildMs,after&&phase==="cold"?3:0);assert.equal(delta.indexQueryMs,after?1:0);
        cases.push({kind,phase,result,delta,accumulated:{...p},incorrectDropPlusBuild:delta.dropTargetMs+delta.indexBuildMs});
    }
}
const callbacks=makeCallbacks(freshNodes(),(ms:number)=>clock+=ms), p=reset();
const invalid=callbacks.batch(944,90,[]);
assert.equal(invalid.nodeId,null);assert.equal(invalid.isNearNode,false);
assert.equal(p.dropTargetCalls,1);assert.equal(p.dropTargetMs,after?7:0);
cases.push({kind:"batch",phase:"no-source",result:invalid,delta:{...p}});
console.log(JSON.stringify({scope:"从实际插桩文件逐字提取回调并调用；真实几何/策略/索引，假坐标成本7、建立3、query1毫秒；非实机耗时",side:process.argv[2],cases}));
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dependencies", required=True, type=Path)
    args = parser.parse_args()
    output = HERE / "caf2c1ce"
    output.mkdir(exist_ok=True)
    assert not git("diff", "--name-only", SIDES["after"][0], REVISION, "web/src", "backend", "agent-host").strip()
    summary = {"reviewed_commit": REVISION, "product_changes_since_e54": [], "sides": {}}
    scratch = REPO / ".local/canvas-baseline-review"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as directory:
        root = Path(directory)
        for name, (ref, patch_name) in SIDES.items():
            snapshot = root / name
            snapshot.mkdir()
            with tarfile.open(fileobj=io.BytesIO(git("archive", ref, "web/src", "web/tsconfig.json", "web/package.json", "backend/internal/providerpreset"))) as archive:
                archive.extractall(snapshot, filter="data")
            (snapshot / "web/node_modules").symlink_to(args.dependencies.resolve(), target_is_directory=True)
            record = {"ref": ref, "checks": {}}
            for other_name, (_, other_patch) in SIDES.items():
                patch_path = root / other_patch
                patch_path.write_bytes(git("show", REVISION + ":" + MATERIALS + other_patch))
                result = subprocess.run(["git", "apply", "--check", "--unsafe-paths", "--directory=" + str(snapshot), str(patch_path)], cwd=REPO, capture_output=True, text=True)
                record["checks"][other_patch] = {"exitCode": result.returncode, "output": (result.stdout + result.stderr).replace(str(snapshot), "<固定快照>")}
                assert (result.returncode == 0) == (name == other_name), record
            patch_path = root / patch_name
            result = subprocess.run(["git", "apply", "--unsafe-paths", "--directory=" + str(snapshot), str(patch_path)], cwd=REPO, capture_output=True, text=True)
            assert result.returncode == 0, result.stderr
            source = (snapshot / CONTROLLER).read_text()
            probe = snapshot / "web/src/perf-probe.ts"
            target_present = (snapshot / "web/src/lib/canvas/canvas-connection-target.ts").exists()
            assert target_present == (name == "after")
            assert "perf.dropTargetCalls += 1" in source and probe.exists()
            record.update({"patch_sha256": hashlib.sha256(patch_path.read_bytes()).hexdigest(), "patched_controller_sha256": hashlib.sha256(source.encode()).hexdigest(), "probe_sha256": hashlib.sha256(probe.read_bytes()).hexdigest(), "index_module_present": target_present, "call_counter_sites": source.count("perf.dropTargetCalls += 1")})
            script_dir = snapshot / "web/scripts"
            script_dir.mkdir()
            (script_dir / "actual-callbacks.ts").write_text(callback_module(source, name == "after"))
            (script_dir / "actual-callback-runner.ts").write_text(RUNNER)
            result = subprocess.run(["bun", "run", "scripts/actual-callback-runner.ts", name], cwd=snapshot / "web", capture_output=True, text=True)
            (output / (name + "-callbacks.txt")).write_text("$ bun run <逐字提取的插桩回调> " + name + "\n" + result.stdout + result.stderr)
            assert result.returncode == 0, result.stderr
            record["actual_callbacks"] = json.loads(result.stdout)
            summary["sides"][name] = record
        assert summary["sides"]["before"]["probe_sha256"] == summary["sides"]["after"]["probe_sha256"]
        summary["formula"] = {"correct": "before.dropTargetMs 对比 after.dropTargetMs", "index_breakdown": "after.indexBuildMs + after.indexQueryMs 是dropTargetMs内部子项，不再加到dropTargetMs", "rebuild_required_for_formula_correction": False}
        (output / "independent-baseline.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        print("双侧补丁完整应用与实际回调通过；候选cold总耗时11已包含build3，再加会错误变14。")


if __name__ == "__main__":
    main()
