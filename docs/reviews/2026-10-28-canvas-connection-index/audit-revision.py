#!/usr/bin/env python3
"""复放修正版作者差分、旧代码敏感性和原生准备；不启动客户端或写数据库。"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
REVISION = "e54d4863d52244c5b024464c70e6a1e9e7a4e0c7"
ORIGINAL = "f7b82b710e593e959573d6594aeada6048b6d3a9"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dependencies", required=True, type=Path)
    args = parser.parse_args()
    output = HERE / "e54d4863"
    output.mkdir(exist_ok=True)
    scratch = REPO / ".local/canvas-index-revision"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as directory:
        root = Path(directory)
        with tarfile.open(fileobj=io.BytesIO(git("archive", REVISION, "web/src", "web/test", "web/scripts", "web/package.json", "web/tsconfig.json", "backend/internal/providerpreset"))) as archive:
            archive.extractall(root, filter="data")
        web = root / "web"
        (web / "node_modules").symlink_to(args.dependencies.resolve(), target_is_directory=True)
        source = (web / "scripts/canvas-interaction-bench.ts").read_text()
        # 保留作者原函数、5400随机循环和2880定向循环，只去掉与本轮无关的性能取样。
        begin = source.index("const connectionResults:")
        end = source.index("// 行为等价性：", begin)
        extracted = source[:begin] + "const connectionResults = {}, indexCost = {}, progressResults = {};\n" + source[end:]
        extracted = extracted.replace("let boundarySamples = 0;", "const reviewCoverage: Record<string, any> = {};\nlet boundarySamples = 0;")
        extracted = extracted.replace("boundarySamples += 1;", '''boundarySamples += 1;
                    const c = reviewCoverage[fixture] ||= { positions: 0, ordinaryHit: 0, ordinaryNear: 0, batchHit: 0, batchNear: 0, types: {} };
                    c.positions++; c.ordinaryHit += Number(legacy.nodeId !== null); c.ordinaryNear += Number(legacy.isNearNode);
                    c.batchHit += Number(legacyBatch.nodeId !== null); c.batchNear += Number(legacyBatch.isNearNode);
                    c.types[probeNode.type] = (c.types[probeNode.type] || 0) + 1;''')
        extracted = extracted.replace("    boundaryParity:", "    reviewCoverage,\n    boundaryParity:")
        (web / "scripts/review-author-parity.ts").write_text(extracted)
        (web / "scripts/review-author-full.ts").write_text(source)
        target = web / "src/lib/canvas/canvas-connection-target.ts"
        revised_target = target.read_bytes()
        summary = {"candidate": REVISION, "previous_candidate": ORIGINAL, "author_script_sha256": hashlib.sha256(source.encode()).hexdigest(), "extraction": "原函数与差分循环未改，只省略计时循环并计数实际命中"}
        for label, content in [("revised", revised_target), ("original-index", git("show", ORIGINAL + ":web/src/lib/canvas/canvas-connection-target.ts"))]:
            target.write_bytes(content)
            command = ["bun", "run", "scripts/review-author-parity.ts"]
            result = subprocess.run(command, cwd=web, capture_output=True, text=True)
            (output / ("author-parity-" + label + ".txt")).write_text("$ " + " ".join(command) + "\n" + result.stderr)
            if result.returncode:
                raise RuntimeError(result.stderr)
            data = json.loads(result.stdout)
            (output / ("author-parity-" + label + ".json")).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            summary[label] = {"random": data["parity"], "boundary": data["boundaryParity"], "coverage": data["reviewCoverage"]}
            command = ["bun", "run", "scripts/review-author-full.ts", "--nodes", "100", "--entries", "1", "--repeats", "1", "--boundary"]
            result = subprocess.run(command, cwd=web, capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(result.stderr)
            full = json.loads(result.stdout)
            (output / ("author-full-" + label + ".json")).write_text(json.dumps(full, ensure_ascii=False, indent=2) + "\n")
            summary[label]["unmodified_full_boundary"] = full["boundaryParity"]
            (output / ("author-full-" + label + ".txt")).write_text("$ " + " ".join(command) + "\n" + result.stderr)
            if label == "original-index":
                command = ["bun", "test", "test/canvas-connection-target.test.ts"]
                result = subprocess.run(command, cwd=web, capture_output=True, text=True)
                (output / "revised-tests-on-original-index.txt").write_text("$ " + " ".join(command) + "\n" + result.stdout + result.stderr)
                summary["new_tests_on_old_index_exit_code"] = result.returncode
                assert result.returncode != 0
        assert summary["original-index"]["boundary"]["samples"] == 2880
        assert summary["original-index"]["boundary"]["mismatches"] > 0
        assert summary["revised"]["boundary"]["mismatches"] == 0
        target.write_bytes(revised_target)

        seed_source = git("show", REVISION + ":docs/performance/2026-10-28-canvas-interaction/seed-canvas.py").decode()
        seed = types.ModuleType("review_seed")
        exec(compile(seed_source, "fixed-seed-canvas.py", "exec"), seed.__dict__)
        seed_results = []
        for grouped in [False, True]:
            payload = seed.build_payload("review300", "免费假数据", 300, grouped)
            ids = {node["id"] for node in payload["nodes"]}
            invalid = [edge for edge in payload["connections"] if edge["fromNodeId"] not in ids or edge["toNodeId"] not in ids]
            seed_results.append({"grouped": grouped, "nodes": len(ids), "connections": len(payload["connections"]), "invalidEndpoints": len(invalid), "example": invalid[:1]})
        summary["seed"] = seed_results

        patch = git("show", REVISION + ":docs/performance/2026-10-28-canvas-interaction/native-probe.patch")
        patch_path = root / "native-probe.patch"
        patch_path.write_bytes(patch)
        result = subprocess.run(["git", "apply", "--check", "--unsafe-paths", "--directory=" + str(root), str(patch_path)], cwd="/tmp", capture_output=True, text=True)
        summary["native_patch_check"] = {"exitCode": result.returncode, "output": result.stdout + result.stderr}
        # 单独执行补丁里的原始探针；只替换DOM、时钟与网络，不编译或启动应用。
        probe_diff = patch.decode().split("diff --git a/web/src/perf-probe.ts", 1)[1].split("@@ -0,0 +1,202 @@\n", 1)[1]
        probe = "\n".join(line[1:] for line in probe_diff.splitlines() if line.startswith("+"))
        (web / "scripts/review-native-probe.ts").write_text('''import vm from "node:vm";
import {readFileSync} from "node:fs";
const buttons:any[] = [], frames:Function[] = [];
const create = () => ({style:{}, children:[] as any[], setAttribute(){}, append(...args:any[]){this.children.push(...args);buttons.push(...args);}});
const window:any = {};
const context = {window,document:{title:"",body:create(),createElement:create,querySelectorAll:()=>[]},performance:{now:()=>0},requestAnimationFrame:(f:Function)=>{frames.push(f);},fetch:()=>Promise.resolve(),setTimeout(){},location:{hash:""}};
const code = new Bun.Transpiler({loader:"ts"}).transformSync(readFileSync(process.argv[2],"utf8"));
vm.runInNewContext(code,context);
const click=(name:string)=>buttons.find(b=>b.textContent===name).onclick({stopPropagation(){}});
click("perf-rec-start");
window.__perf.dropTargetCalls += 1;
window.__perf.indexBuilds += 1;
frames.shift()!(16.67);
click("perf-rec-stop");
console.log(JSON.stringify({scope:"隔离JS探针，一帧内发生一次落点和一次建立；未启动客户端",output:window.__perfLast}));
''')
        probe_path = web / "scripts/review-probe-source.ts"
        probe_path.write_text(probe)
        result = subprocess.run(["bun", "run", "scripts/review-native-probe.ts", str(probe_path)], cwd=web, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)
        summary["probe_frame_counter_replay"] = json.loads(result.stdout)
        (output / "revision-audit.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        print("作者2880差分已复放：", summary["original-index"]["boundary"]["mismatches"], "→0；原生夹具与探针检查已写入 revision-audit.json。")


if __name__ == "__main__":
    main()
