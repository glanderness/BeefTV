#!/usr/bin/env python3
"""定点复放测量工具；只在临时副本应用补丁，不构建或启动原生客户端。"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
REVISION = "a57664ed48ca07512b773d3bd637a9af2b068297"
BASE = "6a155448096d2425aa07e81cc6016410091ad0be"
AFTER = "e54d4863d52244c5b024464c70e6a1e9e7a4e0c7"
MATERIALS = "docs/performance/2026-10-28-canvas-interaction"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO)


def extract(ref, directory, paths):
    directory.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(git("archive", ref, *paths))) as archive:
        archive.extractall(directory, filter="data")


def added_file(patch, path):
    """按 diff 文件段提取新增文件，不依赖 @@ 中的任何行数。"""
    marker = f"a/{path} b/{path}"
    block = next(block for block in patch.split("diff --git ") if block.startswith(marker + "\n"))
    return "\n".join(line[1:] for line in block.splitlines() if line.startswith("+") and not line.startswith("+++")) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dependencies", required=True, type=Path)
    args = parser.parse_args()
    output = HERE / "a57664ed"
    output.mkdir(exist_ok=True)
    unchanged = git("diff", "--name-only", AFTER, REVISION, "web/src", "backend", "agent-host").decode().strip()
    assert unchanged == "", unchanged
    summary = {"revision": REVISION, "before": BASE, "after": AFTER, "product_changes_since_after": [], "checks": {}}
    scratch = REPO / ".local/canvas-tools-review"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as directory:
        root = Path(directory)
        subject = root / "subject"
        extract(REVISION, subject, ["web/src", "web/test", "web/scripts", "web/package.json", "web/tsconfig.json", "backend/internal/providerpreset", MATERIALS])
        materials = subject / MATERIALS
        web = subject / "web"
        (web / "node_modules").symlink_to(args.dependencies.resolve(), target_is_directory=True)
        command = ["python3", str(materials / "verify-tools.py"), "--dependencies", str(args.dependencies.resolve()), "--output", str(output.resolve() / "author-verify-tools.json")]
        # 归档快照没有自己的 .git；只读复用本会话对象库，避免 git archive 把 .local 前缀当源码路径。
        snapshot_env = dict(os.environ, GIT_DIR=git("rev-parse", "--absolute-git-dir").decode().strip(), GIT_WORK_TREE=str(subject))
        result = subprocess.run(command, cwd=subject, env=snapshot_env, capture_output=True, text=True)
        (output / "author-verify-tools.txt").write_text("$ python3 <固定快照>/verify-tools.py --dependencies <已有依赖> --output author-verify-tools.json\n" + result.stdout + result.stderr)
        assert result.returncode == 0, result.stdout + result.stderr
        summary["author_verify_exit_code"] = result.returncode
        patch_path = materials / "native-probe.patch"
        patch = patch_path.read_text()
        summary["patch_sha256"] = hashlib.sha256(patch_path.read_bytes()).hexdigest()
        checks = summary["checks"]
        for name, ref in [("before", BASE), ("after", AFTER)]:
            destination = root / name
            extract(ref, destination, ["web/src"])
            command = ["git", "apply", "--check", "--unsafe-paths", "--directory=" + str(destination), str(patch_path)]
            result = subprocess.run(command, cwd="/tmp", capture_output=True, text=True)
            checks[name + "_same_patch"] = {"ref": ref, "exitCode": result.returncode, "output": (result.stdout + result.stderr).replace(str(destination), "<固定快照>")}
        assert checks["after_same_patch"]["exitCode"] == 0
        # 只给临时候选副本加计时，然后测试真正被插入的代码，而非给计时字段直接赋值。
        result = subprocess.run(["git", "apply", "--unsafe-paths", "--directory=" + str(subject), str(patch_path)], cwd="/tmp", capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        timing_source = r'''import {mock} from "bun:test";
let clock = 0;
const counters:any = {indexBuilds:0,indexBuildMs:0,indexQueries:0,indexQueryMs:0,indexCandidates:0};
(globalThis as any).__perf = counters;
Object.defineProperty(globalThis,"performance",{configurable:true,value:{now:()=>clock}});
mock.module("@/lib/canvas/canvas-spatial-index",()=>({
  canvasNodeBounds:(n:any)=>({left:n.position.x,top:n.position.y,right:n.position.x+n.width,bottom:n.position.y+n.height}),
  buildCanvasSpatialIndex:()=>{clock+=3;return {query:()=>{clock+=1;return []}}}
}));
const {resolveConnectionDropTarget}=await import("@/lib/canvas/canvas-connection-target");
const nodes:any[]=[{id:"source",type:"image",title:"源",position:{x:0,y:0},width:320,height:180}];
const options:any={nodes,connections:[],config:{},world:{x:5000,y:5000},handleRadius:56,current:{nodeId:"source",handleType:"source"},scriptScrollTopById:{}};
resolveConnectionDropTarget(options);const cold={...counters};
resolveConnectionDropTarget(options);const hot={...counters};
if(cold.indexBuildMs!==3||cold.indexQueryMs!==1||hot.indexBuildMs!==3||hot.indexQueryMs!==2||hot.indexBuilds!==1)throw Error(JSON.stringify({cold,hot}));
console.log(JSON.stringify({scope:"真实插桩落点模块，索引建立/查询用3/1毫秒假时钟；不是实机耗时",cold,afterHotQuery:hot}));
'''
        (web / "scripts/review-timing.ts").write_text(timing_source)
        result = subprocess.run(["bun", "run", "scripts/review-timing.ts"], cwd=web, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        checks["actual_instrumented_timing"] = json.loads(result.stdout)

        probe = added_file(patch, "web/src/perf-probe.ts")
        (web / "scripts/review-probe.ts").write_text(probe)
        probe_runner = r'''import vm from "node:vm";
import {readFileSync} from "node:fs";
const buttons:any[]=[], frames:Function[]=[];
const create=()=>({style:{},setAttribute(){},append(...xs:any[]){buttons.push(...xs);}});
const window:any={};
const context={window,document:{title:"",body:create(),createElement:create,querySelectorAll:()=>[]},performance:{now:()=>0},requestAnimationFrame:(f:Function)=>frames.push(f),fetch:()=>Promise.resolve(),setTimeout(){},location:{hash:""}};
vm.runInNewContext(new Bun.Transpiler({loader:"ts"}).transformSync(readFileSync("scripts/review-probe.ts","utf8")),context);
const click=(name:string)=>buttons.find(b=>b.textContent===name).onclick({stopPropagation(){}});
click("perf-rec-start");window.__perf.dropTargetCalls++;window.__perf.indexBuilds++;frames.shift()!(16.67);
frames.shift()!(33.34);window.__perf.dropTargetCalls+=2;frames.shift()!(50.01);click("perf-rec-stop");
const first=window.__perfLast;
click("perf-rec-start");frames.shift()!(66.68);click("perf-rec-stop");const reset=window.__perfLast;
if(!first.includes("含落点帧=2 含重建帧=1 落点调用=3")||!reset.includes("含落点帧=0 含重建帧=0 落点调用=0"))throw Error(JSON.stringify({first,reset}));
console.log(JSON.stringify({scope:"隔离探针三帧及重新开始；没有客户端或系统鼠标",first,reset}));
'''
        (web / "scripts/review-frame-counters.ts").write_text(probe_runner)
        result = subprocess.run(["bun", "run", "scripts/review-frame-counters.ts"], cwd=web, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        checks["independent_frame_counter_replay"] = json.loads(result.stdout)
        seed = types.ModuleType("independent_seed")
        exec(compile((materials / "seed-canvas.py").read_text(), "fixed-seed-canvas.py", "exec"), seed.__dict__)
        checks["independent_seed"] = []
        for grouped in [False, True]:
            payload = seed.build_payload("review", "免费假数据", 300, grouped)
            ids = {node["id"] for node in payload["nodes"]}
            invalid = [edge for edge in payload["connections"] if edge["fromNodeId"] not in ids or edge["toNodeId"] not in ids]
            assert len(payload["connections"]) == 150 and len(invalid) == 0
            checks["independent_seed"].append({"grouped": grouped, "nodes": len(ids), "edges": 150, "invalidEndpoints": len(invalid), "firstEdge": payload["connections"][0]})
        summary["source_sha256"] = {name: hashlib.sha256((materials / name).read_bytes()).hexdigest() for name in ["verify-tools.py", "native-probe.patch", "seed-canvas.py"]}
        (output / "independent-tools.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        print("作者工具复放及独立端点/计数/计时检查通过；同一补丁应用结果：", {k:v["exitCode"] for k,v in checks.items() if k.endswith("same_patch")})


if __name__ == "__main__":
    main()
