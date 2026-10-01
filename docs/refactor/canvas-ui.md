# 画布页面组合重构

本切片只拆 `InfiniteCanvasPage` 的页面私有职责。不是整仓 full-refactor 验收。基线 `15266ba`（v1.6.21 正式修复 + Agent 候选）。官方 pi SDK 仍在服务端；前端是 React。

## 责任边界

| 所有者 | 文件 | 职责 |
| --- | --- | --- |
| 页面 | `web/src/pages/canvas/project.tsx` | 组合、渲染、视口交互、键盘/焦点、节点删除与清空的页面级收口、mention 规范化、文件夹插入与预览、Ark 上传确认、Lighting `AppModal`、节点浮层、`retryCanvasNode` 装配 |
| 提案执行 | `use-canvas-assistant-proposal.ts` + `canvas-assistant-proposal-source.ts` | 人工确认后执行提案；冻结快照；稳定 callback（`handleGenerateNodeRef`）；不自动生成 |
| 生成编排 | `use-canvas-generation-orchestration.ts` + `canvas-generation-orchestration.ts` | 生成查询/执行/批次/分镜/重试/历史插入/从文本建图；纯函数决定重试计划与历史插入顺序 |
| 资源转入 | `use-canvas-resource-handoff.ts` + `canvas-resource-handoff-plan.ts` | 关联项目查询、角色刷新、项目画风节点、文件夹样式同步、handoff 一次性提交、资源重载、归档 |
| 弹窗状态 | `use-canvas-project-dialogs.ts` | 编辑类弹窗开关；删除清理不含 `timelineNodeId`；清空画布不重置角色/导演/分镜/版本/时间线/超分 |
| 弹窗宿主 | `canvas-project-editor-dialogs.tsx` | 按分组 props 挂载搜索/历史/导入/画风/导演模板/信息/字幕/抽帧/时间线/角色/文本/绘图/审美/全景/分镜/导演台/版本对比/素材选择；不持有业务状态 |
| 剪贴板 | `canvas-project-clipboard.ts` | 系统剪贴板写 PNG |

分组 props 是显式类型，不是巨型 untyped context，也不是把整页改名为 hook。

## 调用顺序

页面内 hook 顺序（必须稳定）：

```text
lifecycle
  -> versions / assistant（只读边界，本切片不改）
  -> viewport
  -> generation orchestration（含 executor / batches / storyboard / retry / history）
  -> assistant proposal（只依赖 handleGenerateNode，经 ref 稳定）
  -> upload
  -> resource handoff（需要 handleProjectAssetsInsert）
  -> timeline insert（需要 refetchLinkedProject）
  -> media tools（需要 startGenerationRequest / bindGenerationTask / setRunningNodeId）
  -> node ops
  -> selection
  -> node editor
```

循环切断：

- `retryCanvasNode` 留在页面：需要 media tools 的 `retryDepthCaptureNode`，以及编排层的 `handleRetryNode` / `retryImageBatchChildren` / `generateScriptRows`。
- 提案 hook 放在生成编排之后、上传之前：生成函数经 `handleGenerateNodeRef.current(...)` 调用，callback 身份不随 executor 重建而变。

## 项目 ID

| 用途 | 值 |
| --- | --- |
| 生成任务查询 / live 绑定 | `linkedProjectId` = `shortDramaEnabled ? currentProject?.projectId \|\| "" : ""`，传入 `useCanvasGeneration({ domainProjectId: linkedProjectId })` |
| 执行器 / 重试 / 历史插入素材归属 | `domainProjectId: currentProject?.projectId` |

handoff 查询参数是 `asset`（单数，可重复），不是 `assets`。

## 只读边界（本切片不改）

- `use-canvas-assistant.ts`、`canvas-assistant-sidebar` / turn / composer、`services/api/agent-assistant.ts`
- `web/src/lib/timeline`、canvas-video-merge、export-integrity、zip helpers
- stores、services、APIs、backend、generation executor 内部、timeline 渲染、lockfile
- 持久化 / 任务投递（后续 lead wave）

## 页面仍持有的职责

这些没有抽走，因为依赖渲染模型或会形成环：

- mention 规范化：依赖 `mentionReferencesByNodeId`（render model 的可见 + 语义节点）
- `handleProjectFolderInsert`、`linkedFolderPreviewNodesById`
- Ark 私有素材上传确认
- 角度 / 灯光 / 情绪 / 提示词 / 选择工具条等画布浮层；灯光仍用页面上的 `AppModal`
- `dialogNodeId`（提示词面板，不是编辑弹窗簇）
- `retryCanvasNode` 装配
- 节点内容更新节流与卸载时清理 `toolbarHideTimerRef` / `mediaUpdateTimerRef`
- 键盘、焦点、复制媒体节点（`VIDEO_NODE_MAX_SIZE` 720 在 `canvas-node-size.ts`，复制隔离在 `isolateCopiedNodeMetadata`）

## 行为锁

- Agent 提案必须显式人工确认；快照不可变；不自动生成。`generateImageFromTextNode` 只建连接后的图片节点，不提交任务。
- 批次重试：先 `setNodes` 标记，等全部 child retry，再 reconcile 一次 root。
- 历史插入：`persist` 完成后才关弹窗；重叠插入由 `createInsertingHistoryGate` 挡住。
- 删除节点不关时间线弹窗；清空画布不重置角色参考 / 导演台 / 分镜编辑器 / 版本对比 / 时间线 / 超分。
- 修订冲突 UX 仍走顶栏 `CanvasSyncStatus`，助手侧栏不重复。

## 剩余缺口

- 页面仍约 3400 行：视口安全区平移、世界层 props、节点内容回调、选择/快捷键仍在页面。
- `retryCanvasNode` 跨 media tools 与 generation orchestration，下一切片若要下沉需要先把 depth retry 从 media tools 拆出。
- mention 规范化与 render model 绑定，不能进 resource handoff。
- 持久化、任务投递、助手 SDK 事件投影、时间线渲染由其他 worker 负责。
- `CanvasProjectEditorDialogs` 是宿主而不是控制器；状态仍在 `useCanvasProjectDialogs` + 页面。

## 验证

`cd web && bun install --frozen-lockfile && bun run typecheck`，再跑本切片相关 `bun test`。不跑 GUI / 全量 build / 付费上游 / 真实 DB。
