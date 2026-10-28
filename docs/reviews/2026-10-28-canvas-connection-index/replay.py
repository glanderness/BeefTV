#!/usr/bin/env python3
"""只读提取固定候选，在忽略目录复放；不改产品、不安装依赖。"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone

BASE = "6a155448096d2425aa07e81cc6016410091ad0be"
HEAD = "f7b82b710e593e959573d6594aeada6048b6d3a9"
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO)


def baseline_module(candidate=HEAD):
    """直接提取旧回调，只把 ref 解引用和坐标换算改成参数。"""
    source = git("show", BASE + ":web/src/pages/canvas/use-canvas-connection-controller.ts").decode()
    ordinary = source.split("    const getConnectionDropTarget = useCallback(", 1)[1]
    ordinary = ordinary[ordinary.index("        let isNearNode = false;"):].split("    }, [", 1)[0]
    batch = source.split("    const getBatchConnectionDropTarget = useCallback(", 1)[1]
    batch = batch[batch.index("        const source = sourceNodeIds"):].split("    }, [", 1)[0]
    for line in ["        const world = screenToCanvas(clientX, clientY);\n", "        const scale = Math.max(viewportRef.current.k, 0.05);\n", "        const handleRadius = CONNECTION_SNAP_RADIUS / scale;\n"]:
        batch = batch.replace(line, "")
    prelude = '''import { batchReferenceHandleAtY } from "@/lib/canvas/canvas-batch-table";
import { batchSourceRestriction, hasBatchConnectionCandidate } from "@/lib/canvas/canvas-batch-connection";
import { canvasConnectionError } from "@/lib/canvas/canvas-connection-policy";
import { isFrameNode, isNodeHiddenByCollapsedFrame } from "@/lib/canvas/canvas-frame";
import { getConnectionTargetAnchor, isHiddenBatchChild, normalizeConnection, storyboardHandleAtY } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { FRAME_HEADER_HEIGHT } from "@/lib/canvas/canvas-frame";
'''
    for name, body, extra in [("baselineConnection", ordinary, "current"), ("baselineBatch", batch, "sourceNodeIds")]:
        body = body.replace("nodesRef.current", "nodes").replace("connectionsRef.current", "connections")
        prelude += f"export function {name}({{ nodes, connections, config, world, handleRadius, scriptScrollTopById, {extra} }}: any) {{\n{body}}}\n"
    operations = git("show", candidate + ":web/src/pages/canvas/use-canvas-node-operations.ts").decode()
    body = operations.split("    const createStoryboardGroup = useCallback(() => {\n", 1)[1].split("    }, [", 1)[0]
    prelude += '''export function reachableStoryboardGroup(nodes: CanvasNodeData[]) {
    let result = nodes;
    const nodesRef = { current: nodes };
    const selectedNodeIdsRef = { current: new Set(nodes.filter(n => n.id !== "source").map(n => n.id)) };
    const commitNodes = (next: CanvasNodeData[]) => { result = next; };
    const selectNodes = (_ids: Set<string>) => {};
    const message = { warning(_s: string) {}, success(_s: string) {} };
''' + body + "    return result;\n}\n"
    return prelude


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dependencies", required=True, type=Path, help="已有 web/node_modules，只读复用")
    parser.add_argument("--mode", choices=["all", "differential", "bench", "tests", "browser", "author"], default="all")
    parser.add_argument("--output", type=Path, default=HERE)
    parser.add_argument("--candidate", default=HEAD, help="固定完整提交；默认保留首轮复放")
    parser.add_argument("--expect-parity", action="store_true", help="修正版应与原基线一致，而非复现首轮失败")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    dependencies = args.dependencies.resolve()
    if not (dependencies / "nanoid").exists():
        raise SystemExit("请指定已有 web/node_modules；脚本不会联网安装依赖")
    scratch = REPO / ".local" / "canvas-index-review-replay"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fixed-", dir=scratch) as directory:
        root = Path(directory)
        data = git("archive", args.candidate, "web/src", "web/test", "web/scripts", "web/tsconfig.json", "web/package.json", "backend/internal/providerpreset")
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            archive.extractall(root, filter="data")
        web = root / "web"
        (web / "node_modules").symlink_to(dependencies, target_is_directory=True)
        (web / "scripts/review-baseline.ts").write_text(baseline_module(args.candidate))
        (web / "src/pages/canvas/review-baseline-controller.ts").write_bytes(git("show", BASE + ":web/src/pages/canvas/use-canvas-connection-controller.ts"))
        shutil.copyfile(HERE / "review.ts", web / "scripts/review.ts")
        env = dict(os.environ, REVIEW_OUTPUT=str(output), REVIEW_EXPECT_PARITY="1" if args.expect_parity else "0")
        metadata = {"base": BASE, "candidate": args.candidate, "candidate_tree": git("rev-parse", args.candidate + "^{tree}").decode().strip(), "bun": subprocess.check_output(["bun", "--version"]).decode().strip(), "platform": subprocess.check_output(["uname", "-sm"]).decode().strip(), "started_at": datetime.now(timezone.utc).isoformat(), "load_average": os.getloadavg(), "cpu_count": os.cpu_count(), "source_sha256": {}}
        for name in ["web/src/lib/canvas/canvas-connection-target.ts", "web/src/pages/canvas/use-canvas-connection-controller.ts"]:
            metadata["source_sha256"][name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
        (output / ("environment-" + args.mode + ".json")).write_text(json.dumps(metadata, indent=2) + "\n")
        if args.mode in ["all", "bench"] or not (output / "environment.json").exists():
            (output / "environment.json").write_text(json.dumps(metadata, indent=2) + "\n")
        if args.mode in ["all", "tests"]:
            command = ["bun", "test", "test/canvas-connection-target.test.ts", "test/canvas-batch-connection.test.ts", "test/canvas-spatial-index.test.ts"]
            result = subprocess.run(command, cwd=web, env=env, capture_output=True, text=True)
            (output / "submitted-tests.txt").write_text("$ " + " ".join(command) + "\n" + result.stdout + result.stderr)
            print("已提交专项测试退出码：", result.returncode)
            if result.returncode:
                raise SystemExit(result.returncode)
        for mode in ["differential", "bench", "browser"]:
            if args.mode not in ["all", mode] or (mode == "browser" and not (HERE / "browser.ts").exists()):
                continue
            if mode == "browser":
                for name in ["browser.ts", "hook-harness.tsx"]:
                    shutil.copyfile(HERE / name, web / "scripts" / name)
            command = ["bun", "run", "scripts/browser.ts"] if mode == "browser" else ["bun", "run", "scripts/review.ts", mode]
            result = subprocess.run(command, cwd=web, env=env, capture_output=True, text=True)
            (output / (mode + ".txt")).write_text("$ " + " ".join(command) + "\n" + result.stdout + result.stderr)
            print(mode, "退出码：", result.returncode, result.stdout.strip())
            if result.returncode:
                print(result.stderr)
                raise SystemExit(result.returncode)
        if args.mode in ["all", "author"]:
            command = ["bun", "run", "scripts/canvas-interaction-bench.ts", "--nodes", "300", "--entries", "60", "--repeats", "60"]
            result = subprocess.run(command, cwd=web, env=env, capture_output=True, text=True)
            (output / "author-replay.txt").write_text("$ " + " ".join(command) + "\n" + result.stderr)
            if result.returncode:
                raise SystemExit(result.returncode)
            parsed = json.loads(result.stdout)
            (output / "author-replay.json").write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n")
            print("作者300节点测量已复放；parity：", parsed["parity"])


if __name__ == "__main__":
    main()
