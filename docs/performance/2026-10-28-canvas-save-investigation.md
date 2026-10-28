# 生成进度与画布保存开销：测量与重构衔接（2026-10-28）

状态：研究任务 #96 的交付。只测量、只记录衔接依据，**不改产品代码**。原始数据与可重放夹具在
[`2026-10-28-canvas-save-investigation/`](2026-10-28-canvas-save-investigation/)。

基线：本分支起点 `6a155448096d2425aa07e81cc6016410091ad0be`（与 v2.0.5 固定候选一致，也是本轮读到的 `origin/main`）。
核对过的输入：

| 输入 | 固定提交 / 分支 | 本轮怎么用 |
| --- | --- | --- |
| #86 修订方案与统筹记录 | `bffc87f54625406ccb7b778e088e01d1e5165f01`，分支 `tds/conv-01a17e7f-517e-7dca-b073-c61207fdd555` | 读第 2.4 节（共用保存入口）与第 C3 项（画布保存先验证现有合同）；本报告是 C3 的输入 |
| #88 第 3 步候选 | `6d4d13735569751a98126052055021a8a04549dd`，分支 `tds/conv-01a18064-1402-7d75-9399-bb10bb3d06d2` | 读 `docs/implementation/generation-task-state-step-3.md`；并用 `git diff --stat FETCH_HEAD main` 核实它相对 main 的 39 个文件里没有 `web/` 下的任何文件 |
| #40/#50 画布性能报告与修复 | `docs/reports/2026-10-27-mac-canvas-perf.md` | 核对本轮与它们的边界，不重复测量已归 #50 的项 |
| #95 交互性能任务 | todo `YtUHepbwMnZOwhIX3uM97` | 本任务的并行分工对象；交互显示改动的唯一写手是它 |

## 结论

1. **保存系统没有重复，也没有绕路。** 画布文档只有一条保存链：`updateProject` → zustand persist 中间件（400 ms 去抖）→ IndexedDB 落盘，以及 `scheduleLocalCanvasBackendSync`（500 ms 去抖）→ `commitLiveCanvasDocument` → 整份文档 POST 给后端。没有找到第二个画布文档存储、也没有找到绕过这个入口的写入。#86 第 2.4 节撤回「约 20 个文件各自写库」的判断，本轮实测支持这个撤回。
2. **开销在共用入口内部的比较与序列化上，而不在入口数量上。** 一个节点生成中时，每次任务轮询会让主线程做 **3 次「把整份 nodes 数组做一遍键排序序列化」的全文比较**（`canonicalize`），外加一次 IndexedDB 全量落盘、一次全文档深拷贝和一次整份文档的 HTTP 请求体序列化。301 节点画布每次轮询约 **9.8 ms**，1001 节点约 **38 ms**；按 2 s 轮询换成每分钟约 0.29 s / 1.1 s，按取回阶段的 500 ms 轮询换成约 1.2 s / 4.6 s。
3. **`sameCanvasContent` 只在 `nodes` 真的换了引用时才会全量序列化，纯视口更新不会。** 截图说的「每次都对全文档做两遍 JSON 规范化」只对了一半：被规范化的是 `nodes` 数组（两侧各一次），不是整份文档；视口、`updatedAt`、`revision`、`remoteContentHash` 在 `canvasContentSnapshot` 里已被排除，且 `nodes` 同引用时走 `a[key] === b[key]` 早退，实测 0.001 ms 且不随节点数增长。
4. **编辑器的 autosave 比较（`canvasDocumentMatchesFields`）本来就很便宜，不是瓶颈。** 实测 0.001 ms 且不随节点数增长；它的合并路径（`mergeCanvasRefreshPatch`）才是这条路上第二重的 O(文档) 开销，但比 `canonicalize` 轻一个量级（301 节点 0.073 ms vs 4.2 ms）。
5. **`taskProgress` / `taskStage` 只服务当前画面与助手上下文，重启恢复和回执绑定都不读它们。** 恢复扫描读的是 `taskId` / `taskClientOperationId` / `generationSubmissionState` / `status` / `taskStatus` / `content` / `storageKey`（`canvasNodeNeedsGenerationRecovery`，`canvas-project-generation.ts:559`）。把纯进度字段从画布文档里挪走能让这条路径的开销降到几乎为零（301 节点从 408 ms/分降到 0.07 ms/分），但会改变合并语义与助手上下文，属于行为改动，需要 Basis 并由 Chief 决定，不在本报告建议立即做。
6. **与第 3 步的交点只有两处**：后台自动取回把成片写回画布时产生的外部 revision（决定 4 s 轮询与外部合并的触发频率），以及第 6 步前端改读 `taskOutcome` 时字段集合会缩小。第 3 步本身不碰画布保存（其 diff 无 `web/` 文件）。
7. **不用等重构完。** 守卫改按元素比较、4 s 轮询这两项与第 3 步零重叠，可以现在安排；「哪些进度字段留在文档里」要等第 6 步的字段清理一起做，「整文档提交改增量」要等第 3 步复查结论，避免做两遍或与 revision 语义打架。

## 1. 范围、分工与不做什么

本任务只做三件事：测量这条路径的真实 CPU 开销、查清每个字段的实际用途、定位与当前重构的交点。

不做：不提交产品行为改动；不重写保存系统；不接管交互显示改动（那是 #95）；不重测 #50 已修完的平移/缩放/毛玻璃/连线；不测后端 Go 侧的 5 秒绑定恢复循环（那是 #25/#55 的范围，结论见 #40 报告第 5 节）。

截图里的第 3–6 条（平移缩放 64 ms 整页重渲染、拖连线 O(n²)、hover 整页重渲染、`canvasNodeOperation` 线性扫描）本轮只核对了代码事实，没有测量，也不改：

| 截图条目 | 代码事实（本轮核对） | 归属 |
| --- | --- | --- |
| 3 平移/缩放 64 ms 一次整页重渲染 | `canvas-viewport-render-sync.ts:3` 常量仍在，但 `#50` 已改成「接近预渲染边缘才刷新」 | #50 已修；剩余部分 #95 |
| 4 拖连线 O(n²) 节点扫描 | `use-canvas-connection-controller.ts:458-497` 仍对 `nodesRef.current` 全量 filter，`isHiddenBatchChild` 内部仍有 `nodes.find` | #95 |
| 5 hover 触发整页重渲染 | `use-canvas-pointer-chrome.ts:108` 的 `setHoveredNodeId` 仍是页面级 state（`project.tsx:294`） | #95 |
| 6 每节点 operation selector 线性扫描 | `canvas-node-content.tsx:86` 每个挂载节点订阅 `canvasNodeOperation(state.entries, …)`（`operation-progress.ts:20` 为 `Object.values(...).reverse().find`） | #95 |

## 2. 测量条件与可复现步骤

| 项 | 内容 |
| --- | --- |
| 方法 | 直接调用生产代码里的比较/序列化函数，用合成夹具驱动；**不启动浏览器、不连后端、不读用户数据** |
| 运行时 | Bun 1.4.2，darwin/arm64，10 核 |
| 负载 | 三轮运行期间 1 分钟平均负载 9.85–11.96（10 核机器）。**同机有并行任务，绝对耗时偏高**；结论以「随文档字节增长的形状」和「层与层之间的相对量级」为准 |
| 样本 | 每项 3 次预热 + 51 次采样取中位数；三轮取「中位数的中位数」，并单列三轮区间 |
| 夹具 | `fixture.ts`：25/100/300/1000 个已完成节点 + 1 个生成中节点；70% 图片 / 28% 视频 / 2% 文本；含 20 条助手会话消息；一个节点带完整生成标识 |
| 未覆盖 | 浏览器帧率、桌面客户端实机、IndexedDB 与 HTTP 的真实 IO 时间、React 渲染与 GC 停顿、`web/` 未安装 node_modules 时的构建路径 |

复现：

```sh
cd <repo>/web
bun ../docs/performance/2026-10-28-canvas-save-investigation/measure-canvas-save-cost.ts raw/run-1.json
bun ../docs/performance/2026-10-28-canvas-save-investigation/summarize-runs.ts
```

需要能解析 `json-canonicalize@2.0.0`（`web/package.json` 钉的版本），`cd web && bun install` 之后即有。`@/` 路径别名由
`web/tsconfig.json` 提供，跨目录导入可正常解析。本轮该工作区没有安装 `web/node_modules`，三个采样轮是用一个临时
`NODE_PATH`（只装 `json-canonicalize@2.0.0`）跑完的，跑完已删除；**没有留任何环境依赖**。

复现脚本在 `web/` 里运行后会落到 Bun 的全局缓存解析（本机当前解析到 `json-canonicalize@3.0.1`）。用缓存版本重跑一次得到的是
同形状结果（301 节点 `sameCanvasContent` 5.23 ms、`sameCanvasDocument` 5.87 ms，与表里 4.20 / 3.89 ms 同量级且更高——运行期间
1 分钟负载 11.25，见第 8 节），所以本报告的绝对毫秒数以三轮 2.0.0 数据为准，复现时若能 `bun install` 请优先用钉定版本。

## 3. 实测数据

### 3.1 单次调用耗时（三轮中位数的中位数，ms）

| 节点 | 文档字节 | `sameCanvasContent`（进度 tick） | 编辑器比较 | 编辑器合并 | 候选守卫（按元素） | `sameCanvasDocument` | parse+rebase+serialize | `structuredClone` | `JSON.stringify` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 26 | 41,467 | 0.196 | 0.001 | 0.015 | 0.002 | 0.182 | 0.080 | 0.069 | 0.017 |
| 101 | 135,263 | 1.184 | 0.001 | 0.026 | 0.001 | 1.454 | 0.191 | 0.254 | 0.053 |
| 301 | 384,619 | 4.195 | 0.001 | 0.073 | 0.002 | 3.890 | 0.567 | 0.834 | 0.153 |
| 1001 | 1,257,584 | 15.056 | 0.000 | 0.210 | 0.003 | 18.344 | 3.339 | 4.726 | 1.059 |

另外三项（同夹具，供核对截图结论）：

| 调用 | 26 节点 | 1001 节点 | 说明 |
| --- | ---: | ---: | --- |
| `sameCanvasContent(current, current)` | 0.000 | 0.000 | `left === right` 早退 |
| `sameCanvasContent(current, viewportOnly)` | 0.001 | 0.001 | 纯视口更新：`nodes` 同引用，不做任何序列化 |
| `canvasContentSnapshot(project)` | 0.000 | 0.000 | 只做浅拷贝与解构，不深拷贝 |

`sameCanvasContent` / `sameCanvasDocument` 的耗时随文档字节近似线性增长；两者都走 `canonicalize`，所以量级一致。

### 3.2 每次任务轮询的调用序列（来自代码读取，不是运行抓取）

| 层 | 生产位置 | 次数 / 次轮询 |
| --- | --- | ---: |
| L1 store 守卫 | `use-canvas-store.ts:850`（`bindGenerationTask` → `use-canvas-generation.ts:245` → `updateProject`） | `sameCanvasContent` ×1 |
| L2 编辑器比较 | `use-canvas-project-lifecycle.ts:545`、`:561` | `canvasDocumentMatchesFields` ×2（便宜） |
| L3 编辑器合并 | `use-canvas-project-lifecycle.ts:556` → `:138` | `mergeCanvasRefreshPatch` ×1 |
| L4 未确认检查 | `use-canvas-project-lifecycle.ts:563` → `local-workspace-repository.ts:182` | `sameCanvasDocument` ×1 |
| L5 IndexedDB 落盘 | `use-canvas-store.ts:705-712`（400 ms 去抖） | parse + rebase + serialize ×1 |
| L6 后端提交 | `local-workspace-repository.ts:885-895`（500 ms 去抖）→ `:609`、`:620` | `sameCanvasDocument` + `structuredClone` + `JSON.stringify` ×1 |

轮询间隔来自 `services/api/task-center.ts:428`（2000 ms）与 `:475`（取回结果阶段 `min(intervalMs, 500)`）。
L1 由 `bindGenerationTask` 直接触发；L2–L4 由 React 提交后同一次 render 的 autosave effect 触发。**L2 判定「没变」时 L3–L6 都不会发生**——这正是纯视口更新和纯任务面板刷新不会触发保存的原因。

两个去抖窗口（400 ms / 500 ms）都不大于轮询间隔，所以每次轮询各自落盘一次、各自提交一次；这里按「每 tick 各一次」计，是上界（500 ms 轮询与 500 ms 去抖同周期，实际可能合并掉一部分）。

### 3.3 每分钟模型

三种情景：

- **A 现状**：L1–L6 全走。
- **B 只换守卫**：L1 换成按元素比较（`canvasDocumentMatchesFields(current, { nodes })` 的语义），保存行为不变。
- **C 守卫 + 进度字段不进画布文档**：文档不再随进度变化，只剩 L1（廉价）+ L2。**这是行为改动，需要 Basis 与 Chief 决定，本报告只给量级。**

| 节点 | 轮询 | A 现状 ms/分 | B 只换守卫 ms/分 | C 不进文档 ms/分 |
| --- | --- | ---: | ---: | ---: |
| 26 | 2000 ms | 22.3 | 16.5 | 0.14 |
| 26 | 500 ms | 89.2 | 66.0 | 0.55 |
| 101 | 2000 ms | 138.5 | 103.0 | 0.07 |
| 101 | 500 ms | 554.1 | 412.1 | 0.28 |
| 301 | 2000 ms | 408.1 | 282.3 | 0.07 |
| 301 | 500 ms | 1632.5 | 1129.2 | 0.30 |
| 1001 | 2000 ms | 1832.4 | 1380.8 | 0.11 |
| 1001 | 500 ms | 7329.5 | 5523.1 | 0.43 |

按一次核的占比：301 节点在 2 s 轮询下约 0.7%，取回阶段 2.7%；1001 节点约 3.1% 与 12.2%（负载下偏高）。

三轮区间（A，说明负载噪声；26 节点因为绝对值太小，噪声占主导）：

```text
26   节点 / 2000ms: 36.75 / 39.83 / 47.87 ms/分（最小/中位/最大）
26   节点 /  500ms: 90.55 / 154.99 / 180.38
301  节点 / 2000ms: 361.51 / 424.56 / 591.68
301  节点 /  500ms: 1373.2 / 1406.68 / 1832.33
1001 节点 / 2000ms: 1057.36 / 1284.52 / 1799.93
1001 节点 /  500ms: 5213.36 / 5318.84 / 5639.8
```

**派生量（由实测字节数 × 调用次数推算，不是直接测量）：** 一次 tick 里 `canonicalize` 被调用 6 次（3 次比较 × 两侧），每次产出一份与 nodes 数组等大的字符串。1001 节点画布约 7.3 MB/tick；2 s 轮询约 218 MB/分，500 ms 轮询约 873 MB/分。这解释了 p95 明显高于中位数（`sameCanvasContent` 在 1001 节点上中位 15.1 ms、p95 21–30 ms）——大量瞬时字符串分配带来的 GC 压力。

### 3.4 轮询与页面更新（回答「其他任务查询是否真的触发页面更新」）

| 轮询 | 周期 | 代码位置 | 是否写画布文档 | 是否让画布页面重渲染 |
| --- | --- | --- | --- | --- |
| 任务进度订阅 | 2000 / 500 ms | `task-center.ts:428,475` → `bindGenerationTask` | **是**（L1–L6） | 是（`setNodes`） |
| 画布活动任务浮层 | 2000 / 10000 ms | `use-canvas-active-tasks.ts:17`，在 `project.tsx:363` 顶层调用 | 否 | **是**：任务数据每次进度变化都变，React Query 的结构共享失效，整个 3557 行的页面组件重渲染；只渲染，不保存 |
| 外部改动兜底轮询 | 4000 ms | `project.tsx:246-259` → `refreshLocalCanvasProjectIfChanged` | 否 | 仅当服务端 revision 前进时 |
| 任务详情弹窗 | 2000 ms（running/queued） | `use-task-details.ts:32` | 否 | 仅弹窗组件 |
| 后端 Go 绑定恢复 | 5000 ms | `task_delivery.go:121`（后端） | 后端写库 | 否（不占 WebView 主线程） |

**截图说的「4 秒轮询必然整页重绘」不成立。** `refreshLocalCanvasProjectIfChanged` 每次都发一次 `GET /canvas-projects/:id`，但拿到快照后先比 revision：`reconcileRemoteCanvasUnlocked`（`local-workspace-repository.ts:348`）在 `remote.revision <= confirmedRevision` 时返回 `stale`，调用方返回 `undefined`，不 `notifyCanvasRefresh`、不 `setNodes`。所以服务端没变时它是「一次网络读 + 一次 journal 读」，不是一次整页重绘。它的真实代价是**每 4 秒一次无条件 HTTP 请求**（本地后端，但仍是主线程之外的网络往返 + 一次 journal 反序列化）。

## 4. 与截图结论逐条核对

| 截图说法 | 核对结果 | 依据 |
| --- | --- | --- |
| `updateProject` 每次都对全文档做两遍 JSON 规范化 | **部分成立**：被规范化的是 `nodes` 数组、两侧各一次，不是整份文档；只在 `nodes` 引用变化时发生 | `canvas-content.ts:15`；3.1 表里「纯视口更新」一行 |
| 内部用 `json-canonicalize` 把新旧两份完整文档序列化对比 | **不成立**：`canvasContentSnapshot` 先排除 viewport/updatedAt/revision/remoteContentHash，逐字段先比引用 | `canvas-content.ts:5-16` |
| 生成过程中节点内容每 120 ms flush 一次，等于每次进度更新都触发全文档 canonicalize | **归因错误**：120 ms 合并的是**媒体节点内容**更新（`use-canvas-node-content.ts:7,38`），走 `setNodesState`，**不经过 store 守卫**；进度更新来自 2 s/500 ms 的任务轮询，走 `bindGenerationTask` → `updateProject`。两条不同路径 | `use-canvas-node-content.ts:35-49`、`use-canvas-generation.ts:237-251` |
| 持久化层再叠三层开销：逐节点快照遍历 → 400 ms 后整文档写 IndexedDB → 自动保存 effect 里逐节点 stringify 比对 | **大体成立，但顺序与责任要改**：`ordinaryCanvasProjectSnapshot` 在没有 `generationEffectKeys` 时直接返回原对象（近零成本）；400 ms 落盘（parse+rebase+serialize）实测 0.57 ms @301 节点；编辑器 effect 的逐节点比对用的是 `sameCanvasDocumentValue`（引用优先），实测 0.001 ms，不是瓶颈 | `use-canvas-store.ts:542-545`、`:705-712`；3.1 表 |
| 平移/缩放 64 ms 一次整页重渲染 | **#50 已改**（改成接近预渲染边缘才刷新），本轮不测 | `canvas-viewport-render-sync.ts:36-50` |
| 拖连线 O(n²) 节点扫描，`nodeSpatialIndex` 没用上 | **代码事实成立**，本轮未测；属 #95 | `use-canvas-connection-controller.ts:458-497` |
| hover 进/出节点触发整页重渲染 | **代码事实成立**；属 #95 | `use-canvas-pointer-chrome.ts:108` |
| 每节点 operation selector O(entries) 线性扫描 | **代码事实成立**；属 #95 | `canvas-node-content.tsx:86`、`operation-progress.ts:20` |
| 2s/4s/5s 三个轮询各自造成整页 re-render | **部分成立**：2 s 任务订阅确实写文档 + 重渲染；活动任务浮层的 2 s 轮询只重渲染不写文档；4 s 轮询在服务端没变时既不重渲染也不写文档；5 s 是后端 Go 循环，不占 WebView 主线程 | 3.4 节 |
| 修复建议：短路过 viewport 变化 | **已经是现状**，无需改 | `canvas-content.ts:6`、3.1 表 |
| 修复建议：内容比较降级为「数组按位比 + 只对替换项比 metadata」 | **方向正确，且有现成实现**：`sameCanvasDocumentValue` / `canvasDocumentMatchesFields` 就是这个语义 | `canvas-document-equality.ts:2-20` |
| 修复建议：生成期间的进度更新不应触发文档级 autosave | **方向正确但属行为改动**：需要把纯进度字段移出文档，会改变合并语义与助手上下文 | 5 节、7 节 |
| 修复建议：`getConnectionDropTarget` 改用 `nodeSpatialIndex` | 代码事实成立；属 #95 | — |
| 修复建议：平移节流 64 ms → 100 ms 或纯 ref + rAF | 属 #50/#95，本轮不测 | — |

## 5. 字段用途：展示 / 重启恢复 / 回执绑定 / 最终结果 / 并发编辑

逐个核对了写入方（`canvas-project-generation.ts:232-256`、`canvas-generation-failure.ts:98-126`）与读取方。**判定标准是「有没有读者」**，不是字段名。

| 字段组 | 重启恢复 / 任务对账 | 回执绑定 / 重复保护 | 最终结果 | 并发编辑与合并 | 只服务当前画面 |
| --- | --- | --- | --- | --- | --- |
| `taskId` | ✅ `canvasNodeNeedsGenerationRecovery`、恢复扫描 | ✅ 任务身份 | — | ✅ | — |
| `taskClientOperationId` / `generationSubmissionState` | ✅ 按操作号反查任务（`use-canvas-generation.ts:429-436`） | ✅ 避免重复扣费 | — | — | — |
| `retryOf` / `attemptGroupId` / `taskOutputIndex` / `generationOutputNodeIds` | ✅ 批次与重试身份 | ✅ | ✅ 多输出定位 | — | — |
| `status` / `taskStatus` | ✅ | — | — | ✅ `canvas-patch-merge.ts:97-104` 终态保护 | ✅ |
| `taskProgress` / `taskStage` | ❌ 恢复判定完全不读 | ❌ | ❌ | ⚠️ `canvas-document-rebase.ts:90-91`（结算 loading overlay）、`canvas-patch-merge.ts:103`（防回退） | ✅ 进度条、脚本节点、任务详情弹窗、助手上下文、本地任务历史、诊断字段名 |
| `taskStartedAt` / `taskCompletedAt` / `taskDurationMs` | ❌ | ❌ | — | — | ✅ 已用时长 |
| `taskUpdatedAt` | ❌ | ❌ | — | ⚠️ 同上（overlay 结算会整键拷贝） | ✅ 诊断 |
| `taskProvider` / `taskOfficialStatus` / `taskReceiptRecorded` / `taskErrorCode` / `taskFailureDiagnostics` / `taskProviderRequestId` | ❌ | — | — | — | ✅ 失败说明与诊断 |
| `content` / `storageKey` / `assetId` / `mimeType` / `bytes` / `naturalWidth` / `naturalHeight` / `durationMs` | ✅ 判断是否已有成片 | — | ✅ | ✅ `GENERATION_MEDIA_RESULT_KEYS` | ✅ |
| `generationEffectKeys` | — | ✅ `attachNodeEffectKey` 幂等 | ✅ 重复应用保护 | ✅ | — |
| `prompt` / `references` / `model` / `size` / `count` / `quality` / `videoSeconds` | ✅ 恢复失败后重试要用 | — | — | — | ✅ |

读 `taskProgress` / `taskStage` 的位置：`canvas-node-generation-progress.tsx:24,28`、`canvas-node.tsx:314-315`、`canvas-script-node.tsx:157,165`、`canvas-context-discovery.ts:116-117,252`、`local-task-history.ts:29-30`、`use-canvas-generation.ts:226-227`，以及上面两个合并点。

**结论：`taskProgress` / `taskStage` 不是恢复或回执的必需数据。** 它们每次轮询都变，却是这条路上唯一「变了也不需要保存」的内容。但把它们移出文档会改到两处合并语义（loading overlay 结算、进度回退保护）和助手上下文，属于用户可见行为改动 → 需要 Basis 与 Chief 决定。**不建议因为字段名里带 progress 就一概不保存**；`taskId`、`taskClientOperationId`、`content`、`storageKey`、`generationEffectKeys` 这些必须照原样保存。

## 6. 与第 3 步（#88）及 #86 计划的实际交点

先核实事实：`git diff --stat 6d4d1373 main` 的 39 个文件全部在 `backend/` 与 `docs/implementation/` 下，**没有 `web/` 文件**；其实现说明第 5 节也写明「未做真实桌面客户端或前端绘制验收」「不修改画布保存、悬停、连线或进度绘制」。所以第 3 步不直接改这条路径。

真正的交点有三处：

1. **后台自动取回决定外部 revision 的产出频率。** 第 3 步让后台在 5 秒循环里自动重建/取回图片并写回画布节点（`image_auto_recovery.go`、`recoverPendingCanvasBindings`）。每次写回都是一次外部 revision，会经 `notifyCanvasRefresh` → 编辑器 `adoptIncomingEditorDocument` → autosave。这条路径上编辑器会额外跑一次 `mergeCanvasRefreshPatch` + `sameCanvasDocument`。**同一台机器上「生成中」和「后台取回」叠加时，本报告测的每分钟开销会成倍出现。** 本轮没有测这个叠加场景（见第 8 节）。
2. **第 6 步会改变写进文档的字段集合。** 第 6 步要把前端的重试/取回判断改成只读 `taskOutcome`，并删掉 `resourceReloadAvailable`、`generationErrorCode`（前端写的部分）等字段。**这才是「哪些字段留在文档里」该动的时候**——现在动会做两遍，而且会和第 6 步的字段删除打架。
3. **整文档提交改增量依赖第 3 步的 revision 语义稳定。** 现有代码里已经有增量合同（`canvas-patch-merge.ts` 的 `CanvasPatch` + `applyCanvasPatch`），但只用在外部刷新合并上；后端提交走的是 `payload: { canvasId, expectedRevision, document: structuredClone(settled) }`（`local-workspace-repository.ts:617-621`）整份文档 + `expectedRevision` 的 CAS。把提交改成增量会改到 CAS 与冲突判定的语义，而第 3 步正在动 revision 相关的读投影与绑定路径 → **必须等它的复查结论**。

对照 #86 第 C3 项（「画布保存先验证现有合同」）的验收要求：本轮查明**没有找到绕开共用入口的写入，也没有找到可重现的丢改动场景**。按 #86 自己写的规则（「找不到反例就保留当前实现，不按文件数量改造」），保存架构不需要重构；需要改的是共用入口内部的两处实现细节。

## 7. 可现在改 / 需要等待 / 需要 Chief 决定

### 7.1 与第 3 步零重叠，可以现在安排（需指定写手）

| # | 改什么 | 最小落点 | 预期收益（实测依据） | 是否改变用户行为 |
| --- | --- | --- | --- | --- |
| 1 | store 守卫改成按元素比较：`nodes` 同长度时逐项比引用，只有引用不同的项才做深度比较（`sameCanvasDocumentValue` 已是这个语义） | `use-canvas-store.ts:846-855` 的 `updateProject` 守卫 | 301 节点：408 → 282 ms/分（-31%）；1001 节点：1832 → 1381 ms/分（-25%） | 否（只影响「要不要写」的判断，比较更保守） |
| 2 | 4 s 兜底轮询改为「只在页面可见时轮询」并延长到 10–15 s（助手回合结束与 SSE 已经会立即触发） | `project.tsx:246-259` | 每分钟少 6–9 次 HTTP GET + journal 读；服务端没变时本来就不重渲染 | 否（外部改动的可见延迟从 ≤4 s 变到 ≤10–15 s，助手与 SSE 路径不变） |
| 3 | 活动任务浮层的 2 s 轮询加 `enabled: 面板打开` 或延长间隔 | `use-canvas-active-tasks.ts:17` | 生成期间少一次整页重渲染 / 2 s（本页 3557 行） | 否（浮层数据晚一点刷新） |

**注意**：第 1 项必须保留「viewport 单独比较」的语义（现在由 `samePersistenceValue(current.viewport, next.viewport)` 承担），并且要比现在**更保守而不是更激进**——`sameCanvasDocumentValue` 对变化项用 `JSON.stringify`，键顺序不同会被判成「变了」，方向是「多写一次」而不是「漏写一次」，是安全的。这条要写进实现说明。

### 7.2 需要等待

| 项 | 等什么 | 原因 |
| --- | --- | --- |
| 把纯进度字段移出画布文档（情景 C） | 第 6 步前端改读 `taskOutcome` 时的字段清理 | 两处合并语义与助手上下文会一起改；现在做会做两遍 |
| 后端提交改增量 | 第 3 步复查结论 | 改 CAS 与冲突判定语义，与正在动的 revision 读投影重叠 |
| 4 s 轮询进一步改成「只靠 SSE + 助手回调」 | 第 3 步自动取回上线后的实际外部 revision 频率 | 现在不知道后台会自动写回多少次，先别把兜底砍掉 |

### 7.3 需要 Chief 决定

1. **7.1 的三项由谁写。** 本任务按分工不改产品文件；#95 是交互显示的写手，但第 1 项落在 `use-canvas-store.ts`（保存核心），第 3 项落在 `use-canvas-active-tasks.ts`（进度查询）。按 #95 自己的约束「若需要跨到生成进度与保存的核心文件，先交 Chief 协调写入归属」，这三项要 Chief 指派。
2. **情景 C（纯进度字段不进文档）要不要做。** 它是唯一能把 301 节点这条路径从 408 ms/分降到 0.07 ms/分的改法，但会改变：`canvas-document-rebase.ts` 的 loading overlay 结算、`canvas-patch-merge.ts` 的进度回退保护、助手上下文里的 `progress`/`stage`。Basis 需要用户确认「进度条刷新可以不走画布文档」这一条产品行为。
3. **要不要把 4 s 兜底轮询的间隔写进用户可见的行为说明。** 若延长到 10–15 s，外部客户端（CLI/MCP）改画布后最坏可见延迟会变长。

## 8. 未测项与证据缺口

- **没有真机测量。** 本轮全是纯逻辑 CPU 测量，不是浏览器帧率、不是桌面客户端实机。按分工，原生同机对比由 #95 优先使用测试时段、需要同机窗口时交 Chief 协调；本报告不把函数基准冒充客户端表现。
- **同机负载高。** 三轮运行期间 1 分钟负载 9.85–11.96（10 核）。绝对毫秒数是「负载下的上界」，不是空闲机器的数字。跨轮次方差在 1001 节点上可见（`sameCanvasDocument` 12.6–18.3 ms）。
- **调用次数是代码读取推的，不是运行抓取。** 没有在真实客户端上打点计数。要拿到真实计数，需要在桌面客户端加临时探针（属 #95 或另一个获批的探针任务）。
- **没有测「生成中 + 后台自动取回」叠加场景**（第 6 节交点 1），也没有测多节点同时生成（每次轮询会改写多个节点）。
- **没有测 120 ms 媒体内容合并路径的真实频率**（`use-canvas-node-content.ts:35-49`）。它不经过 store 守卫，但会经编辑器 effect 触发 L2–L6；120 ms < 400 ms，所以 store 落盘会被去抖合并，但后端提交（500 ms 去抖）几乎每次都发生。
- **没有测 `hasUnconfirmedCanvasEdits` 在「无确认基线」时的退化路径**（`canvas-unconfirmed-edits.ts` 的 `no-baseline`），它会让 L4 直接返回 true 而不做比较。
- **没有验证 `canonicalize` 的实际分配量。** 3.3 节的 MB/分是由实测字节数 × 调用次数推算的，不是 `--expose-gc` 之类的直接分配测量。
- **没有覆盖 `web/` 未安装依赖时的构建/类型检查。** 本轮只运行了独立夹具脚本；`web/` 的 `bun run build`、`tsc --noEmit` 未跑（本任务没有改产品文件，也没有装依赖）。

## 9. 原始数据与复现

```text
docs/performance/2026-10-28-canvas-save-investigation/
├── fixture.ts                 合成画布夹具（节点/文档形状、进度 tick、纯视口更新）
├── measure-canvas-save-cost.ts 真实生产函数测量 + 调用模型，写 raw/run-N.json
├── summarize-runs.ts          三轮汇总，写 raw/summary.json 并打印报告用表格
└── raw/
    ├── run-1.json             完整测量（含每项 51 次采样的中位数/p95、守卫结果、负载）
    ├── run-2.json
    ├── run-3.json
    └── summary.json           三轮聚合 + 每分钟 A/B/C 模型 + 逐轮区间
```

数据里只有合成夹具的字节数与耗时，不含任何用户内容、路径或凭据。
