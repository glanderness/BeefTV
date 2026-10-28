#!/usr/bin/env python3
"""往隔离数据目录里写一块合成画布，供原生客户端性能测量使用。

不读取也不写入用户的正式数据目录：只在显式给出的数据目录里操作，素材用内联的
`data:image/svg+xml` 小图，不联网、不调用模型、不产生费用。

    python3 seed-canvas.py <数据目录> --nodes 300 --title perf300 \
        [--group-all-children] [--collapsed] [--canvas-id perf300] \
        [--spacing-x 520] [--spacing-y 360]
    python3 seed-canvas.py . --self-check            # 不接触数据库，只核对种子

`--group-all-children` 按产品 `createStoryboardGroup` 的真实构造方式生成：所有图片
节点带 `parentId` 指向背板，背板追加在 `nodes` 数组末尾。背板默认**展开**，与
`use-canvas-node-operations.ts:312` 的 `frame: { collapsed: false, ... }` 一致——折叠的
背板会把子节点藏起来，原生客户端里就没有可拖的连线端口了；要复现折叠形态再传
`--collapsed`。

限制：这个种子只保留「背板追加在数组末尾」这一结构，布局和尺寸没有复用真实的多选
创建动作。正式的分组采样应优先在客户端里真实多选创建，或按 `--self-check` 核对最终
节点与连线后再用。

间距必须大于**渲染后**的卡片尺寸，不是种子里的 `width`/`height`。产品把 320x180 的
图片节点渲染成约 420x234 的卡片（图片区加标题行与外边距），早先按 360x240 排布会让
相邻卡片重叠 60px，被压住的那一侧连接点按不到：真实鼠标在它上面落下会打到邻卡或画布，
连线手势根本不会开始（实测连续三次拖拽 `落点调用=0`）。所以默认间距取 520x360，保证
每张卡片左右各留出约 100px，连接点（80px 宽，贴在卡片外沿）完全落在空隙里。
"""
import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='%23234'/><circle cx='60' cy='90' r='40' fill='%23adf'/></svg>"


def build_payload(canvas_id: str, title: str, count: int, group_all_children: bool, collapsed: bool = False, spacing_x: int = 520, spacing_y: int = 360) -> dict:
    columns = max(4, int(count ** 0.5) + 1)
    rows = (count + columns - 1) // columns
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    nodes = []
    child_ids = []
    for index in range(count):
        is_child = group_all_children
        node_id = f"perf-child-{index}" if is_child else f"perf-node-{index}"
        if is_child:
            child_ids.append(node_id)
        node = {
            "id": node_id,
            "type": "image",
            "title": f"节点 {index}",
            "position": {"x": (index % columns) * spacing_x, "y": (index // columns) * spacing_y},
            "width": 320,
            "height": 180,
            "createdAt": now,
            "updatedAt": now,
            "metadata": {"content": SVG, "mimeType": "image/svg+xml", "width": 320, "height": 180, "status": "success"},
        }
        if is_child:
            node["parentId"] = "perf-frame-group"
        nodes.append(node)
    if group_all_children:
        # 背板要包住整片子节点，否则面板只覆盖左上角一小块，和产品里「多选建组」的结果
        # 不一致；按渲染尺寸（420x234）留 40px 边距。
        frame_width = (columns - 1) * spacing_x + 420 + 80
        frame_height = (rows - 1) * spacing_y + 234 + 80
        nodes.append({
            "id": "perf-frame-group",
            "type": "frame",
            "title": f"分镜组 · {len(child_ids)} 镜",
            "position": {"x": -40, "y": -40},
            "width": frame_width,
            "height": frame_height,
            "createdAt": now,
            "updatedAt": now,
            "metadata": {"workflowKind": "storyboard", "frame": {"collapsed": collapsed, "expandedWidth": frame_width, "expandedHeight": frame_height}},
        })
    # 连线端点必须落在真实存在的节点上。分组形态的节点 id 是 `perf-child-*`，早先这里
    # 写死 `perf-node-*`，分组画布的 150 条连线全部指向不存在的节点（#101 第二轮复核）；
    # 那样的「150 条连线」既不能显示也不能参与规划。背板本身不是可连接节点，排除。
    connectable_ids = [node["id"] for node in nodes if node["type"] != "frame"]
    connections = []
    for index in range(1, len(connectable_ids), 2):
        connections.append({"id": f"perf-edge-{index}", "fromNodeId": connectable_ids[index - 1], "toNodeId": connectable_ids[index]})
    return {
        "id": canvas_id,
        "title": title,
        "nodes": nodes,
        "connections": connections,
        "chatSessions": [],
        "directorScenes": [],
        "activeChatId": None,
        "appearance": {"mode": "dark"},
        "backgroundMode": "dots",
        "showImageInfo": False,
        "viewport": {"x": 0, "y": 0, "k": 1},
        "createdAt": now,
        "updatedAt": now,
    }


def verify_payload(payload: dict) -> dict:
    """核对每条连线的两端都指向真实节点，返回计数；写入前必须过这一关。"""
    ids = {node["id"] for node in payload["nodes"]}
    invalid = [edge for edge in payload["connections"] if edge["fromNodeId"] not in ids or edge["toNodeId"] not in ids]
    return {"nodes": len(ids), "connections": len(payload["connections"]), "invalidEndpoints": len(invalid), "example": invalid[:1]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir")
    parser.add_argument("--nodes", type=int, default=300)
    parser.add_argument("--title", default="perf300")
    parser.add_argument("--canvas-id", default="perf300")
    parser.add_argument("--group-all-children", action="store_true")
    parser.add_argument("--collapsed", action="store_true", help="把分镜组背板设为折叠（默认展开，与产品一致）")
    parser.add_argument("--spacing-x", type=int, default=520, help="网格横向间距，必须大于渲染后的卡片宽度（约 420）")
    parser.add_argument("--spacing-y", type=int, default=360, help="网格纵向间距，必须大于渲染后的卡片高度（约 234）")
    parser.add_argument("--self-check", action="store_true", help="只构造普通/分组两份种子并核对连线端点，不接触数据库")
    args = parser.parse_args()

    if args.self_check:
        report = []
        for grouped in (False, True):
            payload = build_payload(args.canvas_id, args.title, args.nodes, grouped, args.collapsed, args.spacing_x, args.spacing_y)
            report.append({"grouped": grouped, **verify_payload(payload)})
        print(json.dumps(report, ensure_ascii=False))
        return 0

    database = Path(args.data_dir) / "open_ai_canvas.db"
    if not database.exists():
        print(f"数据库还不存在，先启动一次隔离客户端初始化: {database}", file=sys.stderr)
        return 1

    connection = sqlite3.connect(database)
    try:
        row = connection.execute("SELECT id FROM workspaces ORDER BY created_at LIMIT 1").fetchone()
        if not row:
            print("workspaces 表里还没有本地工作区记录，先启动一次隔离客户端", file=sys.stderr)
            return 1
        workspace_id = row[0]
        payload = build_payload(args.canvas_id, args.title, args.nodes, args.group_all_children, args.collapsed, args.spacing_x, args.spacing_y)
        check = verify_payload(payload)
        if check["invalidEndpoints"]:
            print(f"种子自检失败：{check['invalidEndpoints']} 条连线端点不存在，不写入 {check['example']}", file=sys.stderr)
            return 1
        now = time.strftime("%Y-%m-%d %H:%M:%S.000000+00:00", time.gmtime())
        # revision 必须每次 +1：客户端把 revision 相同或更旧的远端快照当成本机提交的回执
        # 直接忽略（local-workspace-repository.ts 的 reconcileRemoteCanvasUnlocked）。
        # 早先这里固定写 1，客户端于是永远用它本地缓存里的旧画布，种子写进去的分组画布
        # 一次都没被显示过（实测：库里是 perf-child-*，探针报的却是 perf-node-*）。
        connection.execute(
            "INSERT INTO canvas_projects (id, user_id, project_id, title, payload_json, revision, created_at, updated_at) "
            "VALUES (?, ?, '', ?, ?, 1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, title=excluded.title, revision=canvas_projects.revision+1, updated_at=excluded.updated_at",
            (args.canvas_id, workspace_id, args.title, json.dumps(payload, ensure_ascii=False), now, now),
        )
        connection.commit()
        revision = connection.execute("SELECT revision FROM canvas_projects WHERE id = ?", (args.canvas_id,)).fetchone()[0]
        print(f"写入画布 {args.canvas_id}（{check['nodes']} 节点，{check['connections']} 连线，端点全部有效，revision={revision}）到 {database}")
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
