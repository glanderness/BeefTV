# 素材 UI 写入边界

状态：前端素材创建/项目链接/分类/文件夹/删除写入接入已有 `asset.Library` 与 `internal/project` HTTP 合同。SQLite 为已提交事实；前端只保留显示和明确未提交草稿。不是完整重构完成证明。Lead 负责 backup worker 接线。

## 运行时分流

以现有函数为准，不凭关键词替换：

| 运行时 | 判定 | 素材写入 |
| --- | --- | --- |
| 浏览器纯本地（无 Go 资源库） | `usesBrowserLocalResourceStore()` | IndexedDB 仍是产品持久路径；`projectIds` 写在本地 metadata |
| 桌面有后端 | `isNativeDesktopRuntime()` 且本地运行时 | `PUT /assets/:id`、`POST /projects/:id/assets`、分类/文件夹 PATCH、`DELETE /assets/:id` |
| hosted | 非浏览器本地资源库 | 同上 typed API；禁止 `saveRemoteUserDataNow` 整批覆盖 |

`isLocalWorkspaceMode()` 仍表示本地优先产品面（路由把项目详情送到画布）。桌面也是 local workspace，不能再用它跳过项目链接。

## 入口

- `ensureCanvasNodeAsset(options)`：入口捕获 `expectedScope`（可注入，backup worker 复用）；pending key 含 `userScope` 与 `epoch`；429 等待后、HTTP dispatch 前、store 投影前同一身份。
- `persistWorkspaceAssetLink`：浏览器本地走 IDB；其余先 upsert 素材再链接项目。失败向上抛出。成功才把 `linkedToProject` 交给调用方（ensure 在 persist 返回后才标记）。
- `persistWorkspaceAssetChanges` / `deleteWorkspaceAsset`：同一分流。脏草稿走具体 PUT/DELETE，不把 flush IDB 当成服务端保存。
- `registerMaterializedLocalAsset`：现有 `localWorkspace()` 注入点保留；`putAsset` 接收 `expectedScope`。

## 禁止

- 用 IndexedDB flush 冒充服务端已保存
- 用 `saveRemoteUserDataNow` 覆盖服务端新数据
- 新建平行 ledger / 整批 ReplaceUserAssets
- 改 `hydrateBackendGeneratedOutputs`、canvas-generation-consumer、local-workspace-repository/journal/canvas store、资源配额或 schema 12

## Lead 接线

backup worker 把已捕获的 `CapturedUserScope` 传入 `EnsureCanvasNodeAssetOptions.expectedScope` 与 `persistWorkspaceAssetLink`。资源上传继续用现有 `meta.expectedScope`。
