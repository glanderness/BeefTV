#!/usr/bin/env python3
"""往隔离数据库里写一条「历史失败但上游已成功」的任务，让 BeefTV 后端自己的取回循环
真的去下载一次产物，从而走通服务端那一半的取回路径。

为什么需要它：第五轮测「生成中 + 后台自动取回叠加」时，只用手工改 `canvas_projects.revision`
模拟了「取回成功改了画布文档」之后的客户端成本；服务端的 5 秒取回循环、真实上游下载、
资源落盘与画布文档写回都没有真实发生（报告第 5.7.6 节第 3 项、第 7 节）。

本脚本复用的是 #87 已验证过的形态（`docs/release-evidence/v2.0.5-client-recovery-acceptance/seed.go`
与同名报告第 1 步）：一条 `status=failed` + `stage=submission_unknown` 的任务，配一条
`request_kind=create`、`status=succeeded` 的调用回执，回执正文里的产物 URL 指向本地假上游。
`task/outcome` 会把它判成 `retrievable / image_recovery_pending`，随后由**未经修改的产品代码**
完成下载、资源落盘与画布写回。

    python3 seed-recovery-task.py <数据目录> --upstream http://127.0.0.1:19118 \
        --canvas-id perf300 --task-id perf-recover-1 [--node-id perf-recover-node]

不启动服务、不启动客户端、不下载、不联网；只写隔离数据库与画布文档。

注意：这条任务**不是**在跑的真实生成——它只覆盖「后台取回 → 更新画布 → 客户端 4 秒兜底
取回并应用」。要覆盖「上游正在生成、进度持续更新」还需要一条绑到假上游的模型渠道 + 带
`provider_request_id` 的 running 任务，本轮未准备（见 round6-prep.md 的剩余项）。
"""
import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

UPSTREAM_NODE_TITLE = "后台取回目标（测量用，故意放在测量视口之外）"


def load_workspace(connection: sqlite3.Connection) -> str:
    row = connection.execute("SELECT id FROM workspaces ORDER BY created_at LIMIT 1").fetchone()
    if not row:
        raise SystemExit("workspaces 表里还没有本地工作区记录，先启动一次隔离客户端")
    return row[0]


def upsert_recovery_node(connection: sqlite3.Connection, canvas_id: str, task_id: str, node_id: str, upstream_url: str, error: str) -> dict:
    """把取回目标节点写进画布文档，并让 revision 前进一格。

    revision 必须前进：客户端把 revision 相同或更旧的远端快照当成本机提交的回执忽略
    （local-workspace-repository.ts 的 reconcileRemoteCanvasUnlocked）。位置取负 y，落在
    任何测量视口之外，卡片尺寸与节点数之外的一切几何都与纯交互采样保持一致。
    """
    row = connection.execute("SELECT payload_json, revision FROM canvas_projects WHERE id = ?", (canvas_id,)).fetchone()
    if not row:
        raise SystemExit(f"画布 {canvas_id} 不存在，先跑 seed-canvas.py")
    payload = json.loads(row[0])
    nodes = [node for node in payload.get("nodes", []) if node.get("id") != node_id]
    nodes.append({
        "id": node_id,
        "type": "image",
        "title": UPSTREAM_NODE_TITLE,
        "position": {"x": 0, "y": -4000},
        "width": 320,
        "height": 200,
        "createdAt": payload.get("createdAt"),
        "updatedAt": payload.get("updatedAt"),
        "metadata": {
            "taskId": task_id,
            "status": "error",
            "error": error,
            "generationSubmissionState": "unknown",
            "providerResultUrl": upstream_url,
        },
    })
    payload["nodes"] = nodes
    now = time.strftime("%Y-%m-%d %H:%M:%S.000000+00:00", time.gmtime())
    connection.execute(
        "UPDATE canvas_projects SET payload_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        (json.dumps(payload, ensure_ascii=False), now, canvas_id),
    )
    revision = connection.execute("SELECT revision FROM canvas_projects WHERE id = ?", (canvas_id,)).fetchone()[0]
    return {"canvasId": canvas_id, "nodeId": node_id, "nodes": len(nodes), "revision": revision}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir")
    parser.add_argument("--upstream", default="http://127.0.0.1:19118", help="假上游基址；回执里的产物 URL 指向它")
    parser.add_argument("--artifact-path", default="/artifact.png", help="假上游的产物路径")
    parser.add_argument("--canvas-id", default="perf300")
    parser.add_argument("--task-id", default="perf-recover-1")
    parser.add_argument("--node-id", default="perf-recover-node")
    parser.add_argument("--receipt-id", default="perf-recover-receipt")
    parser.add_argument("--self-check", action="store_true", help="只构造任务/回执/节点数据并核对，不接触数据库")
    args = parser.parse_args()

    artifact_url = args.upstream.rstrip("/") + args.artifact_path
    error = "提交结果尚未确认，上游任务可能仍在执行。请先查询原任务状态，不要立即重新提交。"

    if args.self_check:
        print(json.dumps({
            "task": {"id": args.task_id, "status": "failed", "stage": "submission_unknown", "routeRun": 3},
            "receipt": {"id": args.receipt_id, "requestKind": "create", "status": "succeeded", "statusCode": 200, "responseBody": {"data": [{"url": artifact_url}]}},
            "node": {"id": args.node_id, "type": "image", "position": {"x": 0, "y": -4000}},
            "artifactUrl": artifact_url,
        }, ensure_ascii=False, indent=2))
        return 0

    database = Path(args.data_dir) / "open_ai_canvas.db"
    if not database.exists():
        print(f"数据库还不存在，先启动一次隔离客户端初始化: {database}", file=sys.stderr)
        return 1

    connection = sqlite3.connect(database)
    try:
        workspace_id = load_workspace(connection)
        now = time.strftime("%Y-%m-%d %H:%M:%S.000000+00:00", time.gmtime())
        canvas = upsert_recovery_node(connection, args.canvas_id, args.task_id, args.node_id, artifact_url, error)
        connection.execute(
            "INSERT INTO tasks (id, user_id, project_id, type, status, stage, progress, route_run, error, input_json, attempts, created_at, updated_at) "
            "VALUES (?, ?, ?, 'canvas_image', 'failed', 'submission_unknown', 0, 3, ?, ?, 0, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET status='failed', stage='submission_unknown', route_run=3, error=excluded.error, input_json=excluded.input_json, updated_at=excluded.updated_at",
            (
                args.task_id,
                workspace_id,
                args.canvas_id,
                error,
                json.dumps({"mode": "image", "metadata": {"source": "canvas", "nodeId": args.node_id}}, ensure_ascii=False),
                now,
                now,
            ),
        )
        connection.execute(
            "INSERT INTO api_call_logs (id, user_id, task_id, capability, request_kind, api_format, method, path, status, status_code, response_body, created_at) "
            "VALUES (?, ?, ?, 'image', 'create', 'openai', 'POST', '/v1/images/generations', 'succeeded', 200, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET status='succeeded', status_code=200, response_body=excluded.response_body",
            (args.receipt_id, workspace_id, args.task_id, json.dumps({"data": [{"url": artifact_url}]}, ensure_ascii=False), now),
        )
        connection.commit()
        observed = connection.execute(
            "SELECT t.id, t.status, t.stage, t.route_run, (SELECT count(*) FROM api_call_logs l WHERE l.task_id = t.id AND l.request_kind='create' AND l.status='succeeded') "
            "FROM tasks t WHERE t.id = ?", (args.task_id,)
        ).fetchone()
    finally:
        connection.close()

    print(json.dumps({
        "task": {"id": observed[0], "status": observed[1], "stage": observed[2], "routeRun": observed[3], "succeededCreateReceipts": observed[4]},
        "canvas": canvas,
        "artifactUrl": artifact_url,
        "note": "启动客户端前先起 upstream.py（放行文件不存在）；记录开始后 touch 放行文件，由产品自己的取回循环完成下载与画布写回。",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
