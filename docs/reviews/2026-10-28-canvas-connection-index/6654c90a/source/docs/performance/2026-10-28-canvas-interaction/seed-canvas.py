#!/usr/bin/env python3
"""往隔离数据目录里写一块合成画布，供原生客户端性能测量使用。

不读取也不写入用户的正式数据目录：只在显式给出的数据目录里操作，素材用内联的
小图，不联网、不调用模型、不产生费用。

    python3 seed-canvas.py <数据目录> --nodes 300 --title perf300 \
        [--group-all-children] [--collapsed] [--canvas-id perf300] \
        [--spacing-x 520] [--spacing-y 360] [--media resource|inline]
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

`--media` 决定节点指向哪种媒体（默认 `resource`）：

- `resource`（第五轮之后新增，**默认**）：先写一个真实的 `resources` 行 + `assets` 行，
  把 SVG 落到 `<数据目录>/resources/perf/<id>.svg`，节点用
  `storageKey=resource:<rid>` + `content=/api/resources/<rid>/file` + `assetId` 指向它。
  这样文档里没有内嵌 `data:` 媒体，客户端自己的保存（`canvas.document.commit`）才能
  通过服务端校验——第五轮两侧客户端每次提交都返回 400，原因就是旧的 `inline` 形态
  被 `asset.ValidateSyncedPayload` 拒绝（`画布数据包含内嵌媒体，请先上传到资源存储`），
  画布头部因此一直显示「保存失败」，客户端编辑从未落盘。
- `inline`：第五轮的旧形态（`metadata.content` 直接是 `data:image/svg+xml,...`）。
  渲染结果相同，但**任何一次保存都会被 400 拒绝**，只在需要复现第五轮那个失败现象时用。

两种形态的节点 id、位置、尺寸、连线与背板完全相同，渲染出的卡片尺寸也相同，因此可以
直接与第五轮的采样做同条件对比。
"""
import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='%23234'/><circle cx='60' cy='90' r='40' fill='%23adf'/></svg>"

# 资源文件是同一张 SVG，只是不再以 data: URL 形式进画布文档。
SVG_FILE = """<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
  <rect width="320" height="180" fill="#223344"/>
  <circle cx="60" cy="90" r="40" fill="#aaddff"/>
</svg>
"""


def media_identity(canvas_id: str) -> tuple[str, str]:
    """种子的资源/素材身份由画布 id 派生，重复写入同一块画布不会累积垃圾行。"""
    slug = "".join(char if (char.isalnum() or char in "-_") else "-" for char in canvas_id)[:40]
    return f"perf-res-{slug}", f"perf-asset-{slug}"


def build_payload(
    canvas_id: str,
    title: str,
    count: int,
    group_all_children: bool,
    collapsed: bool = False,
    spacing_x: int = 520,
    spacing_y: int = 360,
    media: str = "resource",
) -> dict:
    columns = max(4, int(count ** 0.5) + 1)
    rows = (count + columns - 1) // columns
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    resource_id, asset_id = media_identity(canvas_id)
    if media == "resource":
        content_metadata = {
            "content": f"/api/resources/{resource_id}/file",
            "storageKey": f"resource:{resource_id}",
            "assetId": asset_id,
            "mimeType": "image/svg+xml",
            "width": 320,
            "height": 180,
            "status": "success",
        }
    else:
        content_metadata = {"content": SVG, "mimeType": "image/svg+xml", "width": 320, "height": 180, "status": "success"}
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
            "metadata": dict(content_metadata),
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


def verify_payload(payload: dict, media: str = "resource") -> dict:
    """核对连线端点与媒体形态，返回计数；写入前必须过这一关。

    `invalidEndpoints` 非 0 说明连线指向不存在的节点；`inlineMedia` 非 0 说明文档里还有
    内嵌媒体，保存必然被服务端 400 拒绝（除非本来就是想复现那个失败）。
    """
    ids = {node["id"] for node in payload["nodes"]}
    invalid = [edge for edge in payload["connections"] if edge["fromNodeId"] not in ids or edge["toNodeId"] not in ids]
    inline_media = 0
    unlinked = 0
    for node in payload["nodes"]:
        if node["type"] not in ("image", "video", "audio"):
            continue
        metadata = node.get("metadata") or {}
        for value in metadata.values():
            if isinstance(value, str) and value.lower().startswith(("data:image/", "data:video/", "data:audio/")):
                inline_media += 1
                break
        if media == "resource" and (not metadata.get("assetId") or not metadata.get("storageKey")):
            unlinked += 1
    return {
        "nodes": len(ids),
        "connections": len(payload["connections"]),
        "invalidEndpoints": len(invalid),
        "inlineMedia": inline_media,
        "unlinkedMedia": unlinked,
        "example": invalid[:1],
    }


def seed_media(database: Path, data_dir: Path, workspace_id: str, resource_id: str, asset_id: str) -> dict:
    """写一条 ready 的本地资源 + 一条引用它的素材行，并把 SVG 落到资源目录。

    画布保存的媒体守卫（`canvas.validateCanvasMediaAssetsWithCandidates`）要求：媒体节点
    同时给出 `assetId` 与资源定位符，且该素材属于当前用户、其 payload 指向该资源、该资源
    存在且 `status=ready`。三者缺一都会 400，所以资源与素材必须和画布一起写。
    """
    payload_bytes = SVG_FILE.encode("utf-8")
    object_key = f"perf/{resource_id}.svg"
    target = data_dir / "resources" / "perf" / f"{resource_id}.svg"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload_bytes)
    now = time.strftime("%Y-%m-%d %H:%M:%S.000000+00:00", time.gmtime())
    asset_payload = json.dumps(
        {"id": asset_id, "kind": "image", "title": "perf 种子图", "resourceId": resource_id, "storageKey": f"resource:{resource_id}"},
        ensure_ascii=False,
    )
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            "INSERT INTO resources (id, user_id, kind, status, provider, object_key, mime_type, size, width, height, created_at, updated_at) "
            "VALUES (?, ?, 'image', 'ready', 'local', ?, 'image/svg+xml', ?, 320, 180, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET object_key=excluded.object_key, mime_type=excluded.mime_type, size=excluded.size, status='ready', updated_at=excluded.updated_at",
            (resource_id, workspace_id, object_key, len(payload_bytes), now, now),
        )
        connection.execute(
            "INSERT INTO assets (id, user_id, kind, category, status, title, payload_json, created_at, updated_at) "
            "VALUES (?, ?, 'image', 'generated', 'ready', 'perf 种子图', ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, status='ready', updated_at=excluded.updated_at",
            (asset_id, workspace_id, asset_payload, now, now),
        )
        connection.commit()
    finally:
        connection.close()
    return {"resourceId": resource_id, "assetId": asset_id, "objectKey": object_key, "bytes": len(payload_bytes), "path": str(target)}


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
    parser.add_argument("--media", choices=("resource", "inline"), default="resource", help="节点媒体形态：resource=可保存（默认），inline=第五轮旧形态（保存必 400）")
    parser.add_argument("--self-check", action="store_true", help="只构造普通/分组两份种子并核对连线端点与媒体形态，不接触数据库")
    args = parser.parse_args()

    if args.self_check:
        report = []
        for grouped in (False, True):
            for media in ("resource", "inline"):
                payload = build_payload(args.canvas_id, args.title, args.nodes, grouped, args.collapsed, args.spacing_x, args.spacing_y, media)
                report.append({"grouped": grouped, "media": media, **verify_payload(payload, media)})
        print(json.dumps(report, ensure_ascii=False))
        return 0

    data_dir = Path(args.data_dir)
    database = data_dir / "open_ai_canvas.db"
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
        payload = build_payload(args.canvas_id, args.title, args.nodes, args.group_all_children, args.collapsed, args.spacing_x, args.spacing_y, args.media)
        check = verify_payload(payload, args.media)
        if check["invalidEndpoints"]:
            print(f"种子自检失败：{check['invalidEndpoints']} 条连线端点不存在，不写入 {check['example']}", file=sys.stderr)
            return 1
        if args.media == "resource" and (check["inlineMedia"] or check["unlinkedMedia"]):
            print(f"种子自检失败：内嵌媒体 {check['inlineMedia']} 处、未挂素材 {check['unlinkedMedia']} 处，保存会被服务端拒绝，不写入", file=sys.stderr)
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
    finally:
        connection.close()
    media_note = ""
    if args.media == "resource":
        resource_id, asset_id = media_identity(args.canvas_id)
        seeded = seed_media(database, data_dir, workspace_id, resource_id, asset_id)
        media_note = f"，媒体 {seeded['resourceId']}（{seeded['bytes']} 字节 → {seeded['objectKey']}）"
    print(f"写入画布 {args.canvas_id}（{check['nodes']} 节点，{check['connections']} 连线，端点全部有效，media={args.media}{media_note}，revision={revision}）到 {database}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
