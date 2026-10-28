# 生成进度与画布保存开销：测量与重构衔接（2026-10-28）

状态：研究任务 #96 的交付。只测量、只记录衔接依据，**不改产品代码**。原始数据与可重放夹具在
[`2026-10-28-canvas-save-investigation/`](2026-10-28-canvas-save-investigation/)。

## 0. 本版修订说明（第二次修订，2026-10-28）

第一版把「代码读取推算的调用次数」当成了「每次轮询实际发生的事」，摘要里还混进了另一个口径的每轮毫秒数。
本版**只做三件事**：统一口径并修正被指出的数字、补一份真实入口的运行计数、把越界的表述降回它真正的证据等级。
原始测量数据（`raw/run-1..3.json`、`raw/summary.json`）与夹具脚本一字未改，仍是第一版的字节；新增的只有
[`runtime-count/`](2026-10-28-canvas-save-investigation/runtime-count/) 一套运行计数材料（含一次独立复跑核对）。

三类证据在全文中必须分清，摘要与表格都按这个分法标注：

| 标记 | 含义 | 来源 |
| --- | --- | --- |
| **实测** | 直接调生产函数得到的单次耗时（ms） | `raw/run-1..3.json`，第 3.1 节 |
| **计算模型** | 用实测单次耗时 × 一组调用次数推算的每分钟开销；**不是测量** | 第 3.3 节，含被本版修正的旧模型 |
| **运行计数** | 在真实浏览器里跑真实入口（真 store、真去抖、真提交路径）数出来的执行次数 | 第 3.5 节，`runtime-count/raw/*.json` |

本版修正的六处（前五处对应 Chief 的复核）：

1. 摘要写「301 节点每次轮询约 9.8 ms、1001 节点约 38 ms」，与 3.3 表按 2 s 轮询给出的 408.1 / 1832.4 ms/分
   不是同一个口径，也**无法从 raw 数据复算**。本版改用运行计数核对后的 A 情景：**301 节点约 14.5 ms/轮、
   1001 节点约 61.1 ms/轮**（= 434.3 / 1833.9 ms/分 ÷ 30），并说明单轮原始值分散在 12.1–19.7 ms 与
   35.2–60.0 ms（负载噪声）。
2. 3.2 的调用次数是代码读取推测，本版用运行计数核对，**实测次数与原推测不同**（见 3.2、3.5）。
3. 「4 s 兜底轮询延长到 10–15 s 不改变用户行为」不成立：它直接拉长外部改动可见延迟，且桌面端根本收不到
   SSE（见 4 节与 7.1 第 2 项）。
4. `taskProgress` / `taskStage` 还有合并、助手上下文、本地任务历史等读者；「移出文档降到 0.07 ms/分」是
   省略这些路径后的情景模型，不是已实现收益，也不是唯一方案（见 5 节、7.3）。
5. 120 ms 更新与 400/500 ms 去抖的实际合并次数原来没有捕获；本版补上运行计数，结论与第一版假设相反：
   **连续编辑会把两个去抖窗口饿死**（见 3.5）。
6. 第一版把「5 秒循环里的后台图片取回」写成第 3 步新增的能力；核对提交后确认这个循环与画布写回在 `main`
   上就存在，第 3 步改的是它在 job 仍 pending 时不再落到冻结 POST 重放（见 6 节交点 1）。

本轮不做的事：不改产品行为、不实现按元素守卫/延长轮询/按面板开关停查询/进度字段迁移/增量提交、不把
这些建议写成已批准、不新开原生测试客户端（真机对比仍归 #95）、不调用真实付费生成。

基线：本分支起点 `6a155448096d2425aa07e81cc6016410091ad0be`（与 v2.0.5 固定候选一致，也是本轮读到的 `origin/main`）。
核对过的输入：

| 输入 | 固定提交 / 分支 | 本轮怎么用 |
| --- | --- | --- |
| #86 修订方案与统筹记录 | `bffc87f54625406ccb7b778e088e01d1e5165f01`，分支 `tds/conv-01a17e7f-517e-7dca-b073-c61207fdd555` | 读第 2.4 节（共用保存入口）与第 C3 项（画布保存先验证现有合同）；本报告是 C3 的输入 |
| #88 第 3 步候选 | `6d4d13735569751a98126052055021a8a04549dd`，分支 `tds/conv-01a18064-1402-7d75-9399-bb10bb3d06d2` | 读 `docs/implementation/generation-task-state-step-3.md`；并用 `git diff --stat FETCH_HEAD main` 核实它相对 main 的 39 个文件里没有 `web/` 下的任何文件 |
| #40/#50 画布性能报告与修复 | `docs/reports/2026-10-27-mac-canvas-perf.md` | 核对本轮与它们的边界，不重复测量已归 #50 的项 |
| #95 交互性能任务 | todo `YtUHepbwMnZOwhIX3uM97` | 本任务的并行分工对象；交互显示改动与**完整 Mac 客户端测量**的唯一执行方 |
| 第一版报告 | `7c2cb12b1b340a7acbf474bb57aaf9378d2bbc21`，分支 `tds/conv-01a1806f-d230-784a-8005-dbf8786f060f` | 本版是它的定点补正；报告与 `raw/` 已按字节核对复制过来 |

## 结论

1. **保存系统没有重复，也没有绕路。** 画布文档只有一条保存链：`updateProject` → zustand persist 中间件（400 ms 去抖）→ IndexedDB 落盘，以及 `scheduleLocalCanvasBackendSync`（500 ms 去抖）→ `commitLiveCanvasDocument` → 整份文档 POST 给后端。没有找到第二个画布文档存储、也没有找到绕过这个入口的写入。#86 第 2.4 节撤回「约 20 个文件各自写库」的判断，本轮实测支持这个撤回。
2. **开销在共用入口内部的比较与序列化上，而不在入口数量上。** 一个节点生成中时，主线程每轮都会做几次
   「把整份 nodes 数组做一遍键排序序列化」（`canonicalize`）的全文比较，外加一次 IndexedDB 落盘、一次
   全文档深拷贝和一次整份文档的 HTTP 请求体序列化。**实测**（3.1）301 节点单次 `sameCanvasContent` 4.20 ms、
   `sameCanvasDocument` 3.89 ms、`parse+rebase+serialize` 0.57 ms；**计算模型**（3.3，按 3.1 实测 × 3.5 运行计数）
   301 节点约 **14.5 ms/轮**、1001 节点约 **61.1 ms/轮**，折合 2 s 轮询 0.43 s / 1.83 s 每分钟、500 ms 轮询
   1.08 s / 4.04 s 每分钟。第一版摘要写的 9.8 / 38 ms 与这张表不是同一口径，也无法从 raw 数据复算，本版删除。
3. **运行计数（3.5）说明「每轮几次」比 3.2 的推测更少也更多，而且去抖会改变结论。** 在真实入口上数出来的是：
   2 s 轮询每轮 2 次 store 守卫比较、3 次编辑器比较、1 次三路合并、1 次 `sameCanvasDocument`、2 次持久化落盘、
   1 次后端提交；500 ms 轮询每轮 1 次落盘，但**整段生成只提交 1 次**；120 ms 内容更新 60 轮只落盘 2 次、提交 1 次。
   两个去抖窗口在连续编辑下会被「每次新写入重置计时器」饿死，第一版把它当成「每轮各落盘一次、各提交一次」的上界，
   方向错了。
4. **`sameCanvasContent` 只在 `nodes` 真的换了引用时才会全量序列化，纯视口更新不会。** 截图说的「每次都对全文档做两遍 JSON 规范化」只对了一半：被规范化的是 `nodes` 数组（两侧各一次），不是整份文档；视口、`updatedAt`、`revision`、`remoteContentHash` 在 `canvasContentSnapshot` 里已被排除，且 `nodes` 同引用时走 `a[key] === b[key]` 早退，实测 0.001 ms 且不随节点数增长。
5. **编辑器的 autosave 比较（`canvasDocumentMatchesFields`）本来就很便宜，不是瓶颈。** 实测 0.001 ms 且不随节点数增长；它的合并路径（`mergeCanvasRefreshPatch`）才是这条路上第二重的 O(文档) 开销，但比 `canonicalize` 轻一个量级（301 节点 0.073 ms vs 4.2 ms）。
6. **`taskProgress` / `taskStage` 只服务当前画面与助手上下文，重启恢复和回执绑定都不读它们。** 恢复扫描读的是 `taskId` / `taskClientOperationId` / `generationSubmissionState` / `status` / `taskStatus` / `content` / `storageKey`（`canvasNodeNeedsGenerationRecovery`，`canvas-project-generation.ts:559`）。把纯进度字段从画布文档里挪走能让**这一条路径**的开销降到几乎为零（301 节点从约 434 ms/分降到 0.1–0.2 ms/分），但那是省略了合并语义与助手上下文读者的**情景模型**（3.3 情景 C），不是完成改造后的测量，也不是唯一方案；会改变合并语义与助手上下文，属于行为改动，需要 Basis 并由 Chief 决定。
7. **与第 3 步的交点有两处，另有与第 6 步的一处**：第 3 步方面，后台自动取回把成片写回画布时产生的外部 revision（决定 4 s 轮询与外部合并的触发频率），以及整文档提交改增量会碰它的 revision 读投影语义；第 6 步方面，前端改读 `taskOutcome` 时写进文档的字段集合会缩小。第 3 步本身不碰画布保存（其 diff 无 `web/` 文件）。
8. **不用等重构完，但「现在能做」的三项要按证据重新分级。** 守卫改按元素比较与第 3 步零重叠，可以先做，但
   必须先确认它比现在更保守（7.1 第 1 项有一处会漏写的前置条件）；「4 s 轮询延长」会改变用户可见延迟，不是
   零行为改动；「活动任务面板停轮询」在桌面上没有现成开关，且这份数据还喂着取消任务兜底。「哪些进度字段留在
   文档里」要等第 6 步的字段清理一起做，「整文档提交改增量」要等第 3 步复查结论。

## 1. 范围、分工与不做什么

本任务只做三件事：测量这条路径的真实 CPU 开销、查清每个字段的实际用途、定位与当前重构的交点。
本版在这三件事上各补一处：把调用次数从「代码读取推测」换成「真实入口运行计数」，把摘要数字统一到可复算的口径，
并把越界结论降级。

不做：不提交产品行为改动；不重写保存系统；不接管交互显示改动（那是 #95）；不重测 #50 已修完的平移/缩放/毛玻璃/连线；不测后端 Go 侧 5 秒交付/取回循环本身的耗时（那是 #25/#55 的范围，结论见 #40 报告第 5 节；本轮只在 3.4、6 节记录它会写回画布并产生外部 revision 这一事实）；不新开原生测试客户端；不调用真实付费生成。

截图里的第 3–6 条（平移缩放 64 ms 整页重渲染、拖连线 O(n²)、hover 整页重渲染、`canvasNodeOperation` 线性扫描）本轮只核对了代码事实，没有测量，也不改：

| 截图条目 | 代码事实（本轮核对） | 归属 |
| --- | --- | --- |
| 3 平移/缩放 64 ms 一次整页重渲染 | `canvas-viewport-render-sync.ts:3` 常量仍在，但 `#50` 已改成「接近预渲染边缘才刷新」 | #50 已修；剩余部分 #95 |
| 4 拖连线 O(n²) 节点扫描 | `use-canvas-connection-controller.ts:458-497` 仍对 `nodesRef.current` 全量 filter，`isHiddenBatchChild` 内部仍有 `nodes.find` | #95 |
| 5 hover 触发整页重渲染 | `use-canvas-pointer-chrome.ts:108` 的 `setHoveredNodeId` 仍是页面级 state（`project.tsx:294`） | #95 |
| 6 每节点 operation selector 线性扫描 | `canvas-node-content.tsx:86` 每个挂载节点订阅 `canvasNodeOperation(state.entries, …)`（`operation-progress.ts:20` 为 `Object.values(...).reverse().find`） | #95 |

## 2. 测量条件与可复现步骤

### 2.1 单次耗时（3.1 / 3.3 的**实测**）

| 项 | 内容 |
| --- | --- |
| 方法 | 直接调用生产代码里的比较/序列化函数，用合成夹具驱动；**不启动浏览器、不连后端、不读用户数据** |
| 运行时 | Bun 1.4.2，darwin/arm64，10 核 |
| 负载 | 三轮运行期间 1 分钟平均负载 9.85–11.96（10 核机器）。**同机有并行任务，绝对耗时偏高**；结论以「随文档字节增长的形状」和「层与层之间的相对量级」为准 |
| 样本 | 每项 3 次预热 + 51 次采样取中位数；三轮取「中位数的中位数」，并单列三轮区间 |
| 夹具 | `fixture.ts`：25/100/300/1000 个已完成节点 + 1 个生成中节点；70% 图片 / 28% 视频 / 2% 文本；含 20 条助手会话消息；一个节点带完整生成标识 |
| 未覆盖 | 浏览器帧率、桌面客户端实机、IndexedDB 与 HTTP 的真实 IO 时间、React 渲染与 GC 停顿、`web/` 未安装 node_modules 时的构建路径 |

### 2.2 运行计数（3.5 的**运行计数**）

| 项 | 内容 |
| --- | --- |
| 方法 | 真实 Chromium 里挂载真实 `useCanvasProjectLifecycle` + `useCanvasGeneration` + zustand 画布 store；后端是假 CAS 服务；生成任务由假任务对象驱动（**无付费上游**）。计数在构建期注入真实源码的函数体开头，仓库文件不被修改 |
| 驱动 | `poll` 模式 = 每轮调一次真实 `bindGenerationTask`（即轮询回调 `onTaskUpdate` 的入口）；`content` 模式 = 每轮改一次节点内容字段（模拟 120 ms 媒体内容合并走 `setNodes` 的那条路） |
| 节奏 | 2 s × 8 轮、500 ms × 24 轮、120 ms × 60 轮（各留 1.6 s 让去抖与提交收尾） |
| 规模 | 300 节点（三种节奏）与 1000 节点（只跑了 `poll:2000:8` 一种节奏做对照）；两次的 17 项计数逐项一致，说明**次数与节点数无关，只有单次耗时随节点数变** |
| 未覆盖 | 桌面客户端（`wails://` WebView）、页面级轮询（4 s 兜底、活动任务浮层）、真实媒体解码路径、真实 IndexedDB/HTTP 的 IO 时间 |
| 分工 | 真机与桌面端到端仍由 #95 执行；本轮只做隔离的真实入口计数，不代表桌面端表现 |

### 2.3 复现

```sh
cd <repo>/web && bun install --frozen-lockfile     # 需要 json-canonicalize@2.0.0（package.json 钉的版本）
cd <repo>
bun docs/performance/2026-10-28-canvas-save-investigation/runtime-count/run.ts --nodes=300
```

`runtime-count/run.ts` 会自己构建夹具、起假后端、跑真实 Chromium，并把计数写到
`runtime-count/raw/runtime-count.json`；`--nodes=`、`--scenarios=poll:2000:8`、`--out=` 可选。需要本机有
Google Chrome（或 `CHROME_PATH`）。本轮该工作区已用 `bun install --frozen-lockfile` 装好 `web/node_modules`
（`json-canonicalize` 解析到钉定的 2.0.0），**没有临时环境依赖**。

第一版的 3.1/3.3 是在没有 `web/node_modules` 的工作区里用一个临时 `NODE_PATH`（只装 `json-canonicalize@2.0.0`）
跑完的，那份 `raw/run-1..3.json` 与 `raw/summary.json` 原样保留。若用 Bun 全局缓存解析（本机当时是
`json-canonicalize@3.0.1`）重跑会得到同形状、同量级但更高的数字（301 节点 `sameCanvasContent` 5.23 ms、
`sameCanvasDocument` 5.87 ms，运行期间负载 11.25），所以绝对毫秒数以三轮 2.0.0 数据为准。

## 3. 实测数据

### 3.1 单次调用耗时（三轮中位数的中位数，ms）——**实测**

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

### 3.2 每次任务轮询的调用序列（代码读取推测 + 运行计数核对）

下表左半是第一版**从代码读取推测**的调用次数，右半是 3.5 节**运行计数实测**的次数（2 s 轮询，300 / 1000 节点两次一致）：

| 层 | 生产位置 | 推测次数 / 轮 | 实测次数 / 轮 | 差异原因 |
| --- | --- | ---: | ---: | --- |
| L1 store 守卫 | `use-canvas-store.ts:850`（`bindGenerationTask` → `use-canvas-generation.ts:245` → `updateProject`） | `sameCanvasContent` ×1 | **×2** | `bindGenerationTask` 先写一次 store；同一次 render 的编辑器 autosave effect（`use-canvas-project-lifecycle.ts:564`）又 `updateProject` 一次，两次都过守卫（归因来自代码读取，运行计数只证明次数） |
| L2 编辑器比较 | `use-canvas-project-lifecycle.ts:545`、`:561` | `canvasDocumentMatchesFields` ×2 | **×3** | autosave effect 的一次 render 里跑了两处比较，另有一处来自同批次的其它读取路径 |
| L3 编辑器合并 | `use-canvas-project-lifecycle.ts:556` → `:138` | `mergeCanvasRefreshPatch` ×1 | ×1 | 一致 |
| L4 未确认检查 | `use-canvas-project-lifecycle.ts:563` → `local-workspace-repository.ts:182` | `sameCanvasDocument` ×1 | **×0** | 该分支只在 L2 判「没变」时走；生成中每轮都在变，走不到 |
| L5 IndexedDB 落盘 | `use-canvas-store.ts:705-712`（400 ms 去抖） | parse + rebase + serialize ×1 | **×2** | 400 ms 计时器每次写入都重置，本轮写入先落盘一次；提交回执写回后 `applyAcceptedCanvasSave`（`local-workspace-repository.ts:532`）又显式 `flushCanvasStorePersistence()` 一次（2 s 节奏下两次落盘相隔 112 ms） |
| L6 后端提交 | `local-workspace-repository.ts:885-895`（500 ms 去抖）→ `:609`、`:620` | `sameCanvasDocument` + `structuredClone` + `JSON.stringify` ×1 | **×1** | 两次 `scheduleLocalCanvasBackendSync` 被 500 ms 去抖并成一次；这一轮的 `sameCanvasDocument` 就来自这里 |

轮询间隔来自 `services/api/task-center.ts:428`（2000 ms）与 `:475`（取回结果阶段 `min(intervalMs, 500)`）。
L1 由 `bindGenerationTask` 直接触发；L2–L4 由 React 提交后同一次 render 的 autosave effect 触发。**L2 判定「没变」时 L3–L6 都不会发生**——这正是纯视口更新和纯任务面板刷新不会触发保存的原因。运行计数里有一条直接证据：2 s 场景计数清零后还有一次同内容的 `updateProject` 调用（时间线 +0，第一轮之前），被守卫挡下，它后面没有写入、落盘或提交。注意本轮夹具没有跑纯视口轮次，视口路径的结论来自 3.1 的单次实测（`nodes` 同引用早退），不是运行计数。

第一版接着写的「两个去抖窗口都不大于轮询间隔，所以每次轮询各自落盘一次、各自提交一次；按每 tick 各一次计，是上界」**不成立**：
去抖是「每次新写入重置计时器」的尾沿语义，连续编辑会把计时器一直往后推。运行计数实测：

| 输入节奏 | 每轮 store 守卫 | 每轮落盘（400 ms） | 整段落盘 | 整段后端提交（500 ms） |
| --- | ---: | ---: | ---: | ---: |
| 2 s × 8 轮 | 2 | 2 | 16 | 8（每轮 1 次） |
| 500 ms × 24 轮 | 2 | 1 | 25 | **1**（整段只提交一次，计时器被每 250 ms 的排程反复重置） |
| 120 ms × 60 轮 | 1 | 0 | **2**（都在输入停止后） | **1** |

### 3.3 每分钟模型（**计算模型**）

三种情景：

- **A 现状**：L1–L6 全走。
- **B 只换守卫**：L1 换成按元素比较（`canvasDocumentMatchesFields(current, { nodes })` 的语义），保存行为不变。
- **C 守卫 + 进度字段不进画布文档**：文档不再随进度变化，只剩 L1（廉价）+ L2。**这是行为改动，需要 Basis 与 Chief 决定；它是情景模型，只覆盖这一条路径，没有算上 5 节列出的合并/助手上下文/本地任务历史读者，也没有任何改造后的测量支撑。**

下表是**第一版按 3.2 推测次数**算出来的，保留原值以便追溯；**它的调用次数已被 3.5 的运行计数推翻，不应再作为决策依据**：

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

**按运行计数重算的 A 情景（实测次数 × 3.1 实测单次耗时，仍然是计算模型，不是测量）：**

| 节点 | 轮询 | 每轮次数（守卫 / 落盘 / 提交） | 每分钟 ms（守卫 + 落盘 + 提交） | 旧模型 | 差额来源 |
| --- | --- | --- | ---: | ---: | --- |
| 301 | 2000 ms | 2 / 2 / 1 | 2×30×4.195 + 2×30×0.567 + 1×30×(3.890+0.834+0.153) = **434.3** | 408.1 | L4 的 3.890 不再计入，但 L1、L5 各多一次，净增 |
| 301 | 500 ms | 2 / 1 / ≈0 | 2×120×4.195 + 1×120×0.567 + ≈0 = **1083.7** | 1632.5 | 整段只有 1 次提交，L6 的 585 基本消失（−34%） |
| 1001 | 2000 ms | 2 / 2 / 1 | 2×30×15.056 + 2×30×3.339 + 1×30×(18.344+4.726+1.059) = **1833.9** | 1832.4 | 两层一增一减，量级不变 |
| 1001 | 500 ms | 2 / 1 / ≈0 | 2×120×15.056 + 1×120×3.339 + ≈0 = **4039.5** | 7329.5 | 整段只有 1 次提交（−45%） |

也就是说：**2 s 轮询下总量级不变（301 约 0.43 s/分、1001 约 1.83 s/分）**，500 ms 取回阶段的旧模型高估了
约 34%（301）与 45%（1001），因为被高估的正是后端提交那一层，而它在连续编辑下几乎不执行。反过来说，
500 ms 阶段真正落在主线程的是「守卫比较 + 落盘」，不是「提交」。

按一次核的占比（重算后）：301 节点在 2 s 轮询下约 0.72%；1001 节点约 3.1%。

**情景 C 在重算口径下**：进度不再改文档 → 只剩守卫（换成按元素比较后 2×30×0.002 = 0.12 ms/分）与编辑器比较
（3×30×0.001 = 0.09 ms/分），合计约 **0.2 ms/分**（301 节点）。这是「只覆盖这一条路径」的情景模型：没有算上
5 节列出的合并、助手上下文、本地任务历史读者，也没有任何改造后的测量支撑，所以它说明的是「这条路径值得
改」，不是「改完能省 0.2 ms/分」的收益承诺。

三轮区间（A，旧模型口径，说明负载噪声；26 节点因为绝对值太小，噪声占主导）：

```text
26   节点 / 2000ms: 36.75 / 39.83 / 47.87 ms/分（最小/中位/最大）
26   节点 /  500ms: 90.55 / 154.99 / 180.38
301  节点 / 2000ms: 361.51 / 424.56 / 591.68
301  节点 /  500ms: 1373.2 / 1406.68 / 1832.33
1001 节点 / 2000ms: 1057.36 / 1284.52 / 1799.93
1001 节点 /  500ms: 5213.36 / 5318.84 / 5639.8
```

单轮原始 `perTick.totalMs`（同一份 raw，负载噪声的直接体现，供核对第一版摘要里的 9.8 / 38 从哪来）：
301 节点三轮 19.72 / 14.15 / 12.05 ms，1001 节点三轮 42.82 / 60.00 / 35.25 ms。**这些是单轮值，与 3.3 表
「中位数的中位数 × 次数」不是同一口径**；本报告统一采用后者（按运行计数重算后 301 为 14.5 ms/轮、
1001 为 61.1 ms/轮）。

**派生量（由实测字节数 × 推测次数推算，不是直接测量）：** 旧模型假设一次 tick 里 `canonicalize` 被调用 6 次
（3 次比较 × 两侧）。运行计数显示 2 s 轮询确实是 6 次/轮（2 次 `sameCanvasContent` + 1 次 `sameCanvasDocument`，
各两侧），但 500 ms 与 120 ms 节奏下 `sameCanvasDocument` 很少执行，实际约 4 次/轮与 2 次/轮。1001 节点
2 s 轮询约 6 × 1.26 MB ≈ 7.5 MB/轮、约 226 MB/分（旧口径的 218 MB/分同量级）。这解释了 p95 明显高于中位数
（`sameCanvasContent` 在 1001 节点上中位 15.1 ms、p95 21–30 ms）——大量瞬时字符串分配带来的 GC 压力。

### 3.4 轮询与页面更新（回答「其他任务查询是否真的触发页面更新」）

| 轮询 | 周期 | 代码位置 | 是否写画布文档 | 是否让画布页面重渲染 |
| --- | --- | --- | --- | --- |
| 任务进度订阅 | 2000 / 500 ms | `task-center.ts:428,475` → `bindGenerationTask` | **是**（L1–L6） | 是（`setNodes`） |
| 画布活动任务浮层 | 2000 / 10000 ms | `use-canvas-active-tasks.ts:17`，在 `project.tsx:363` 顶层调用 | 否 | **代码读取的推断**：任务数据每次进度变化都变，`useCanvasActiveTasks` 在页面组件顶层调用 → 页面组件函数体重新执行；是否连带子组件取决于 memo 边界，**本轮没有测渲染次数** |
| 外部改动兜底轮询 | 4000 ms | `project.tsx:246-259` → `refreshLocalCanvasProjectIfChanged` | 否 | 仅当服务端 revision 前进时 |
| 服务端事件推送（SSE） | 服务端每 250 ms 读一次项目 | `project.tsx:259-266`；后端 `user_data.go:534` | 否（只是通知，仍走 `refreshLocalCanvasProjectIfChanged`） | 是（`canvas.updated` 时 `setNodes`）；**桌面端不订阅，见下** |
| 任务详情弹窗 | 2000 ms（running/queued） | `use-task-details.ts:32` | 否 | 仅弹窗组件 |
| 后端 Go 交付/绑定恢复循环 | 5000 ms | `task_delivery.go:29`（`generationDeliveryRecoveryInterval`）、`:131`（`startImageRecoveryPass`）、`:138`（ticker） | 后端写库；取回成功会改画布文档并产生外部 revision | 否（不占 WebView 主线程，但会经 4 s 轮询/SSE 反映到页面） |

**桌面客户端不订阅 SSE。** `project.tsx:259` 的守卫要求 `window.location.protocol === "http:"`，否则直接返回；
macOS 桌面端的 WebView 由 Wails v3 以 `wails://localhost` 提供
（`wails/v3@v3.0.0-beta.24/internal/assetserver/assetserver_darwin.go`：`Scheme: "wails"`、`Host: "localhost"`），
所以**桌面端这条订阅根本不执行**。桌面端的外部改动可见性只来自 4 s 兜底轮询与助手回合结束时的显式调用。
后端 `/canvas-projects/:id/events` 端点本身存在，但它自己的实现是每 250 ms 轮询一次项目、revision 前进才发
`canvas.updated`（`backend/internal/handler/user_data.go:534`），不是事件驱动。

**截图说的「4 秒轮询必然整页重绘」不成立。** `refreshLocalCanvasProjectIfChanged` 每次都发一次 `GET /canvas-projects/:id`，但拿到快照后先比 revision：`reconcileRemoteCanvasUnlocked`（`local-workspace-repository.ts:348`）在 `remote.revision <= confirmedRevision` 时返回 `stale`，调用方返回 `undefined`，不 `notifyCanvasRefresh`、不 `setNodes`。所以服务端没变时它是「一次网络读 + 一次 journal 读」，不是一次整页重绘。它的真实代价是**每 4 秒一次无条件 HTTP 请求**（本地后端，但仍是主线程之外的网络往返 + 一次 journal 反序列化）。

### 3.5 真实入口运行计数（**运行计数**）

第一版把 3.2 的调用次数当结论用。本节用真实入口把它数出来：真实 Chromium 挂载真实的
`useCanvasProjectLifecycle` + `useCanvasGeneration` + zustand 画布 store（真 400/500 ms 去抖、真 CAS 提交路径），
后端是假 CAS 服务，生成任务由假任务对象驱动（无付费上游）。计数注入在真实源码的函数体开头，仓库文件未被改动。
材料：[`runtime-count/`](2026-10-28-canvas-save-investigation/runtime-count/)，原始计数
`runtime-count/raw/runtime-count.json` 与 `runtime-count-1000.json`。

**300 节点、三种输入节奏的实测次数：**

| 事件 | 2 s × 8 轮 | 500 ms × 24 轮 | 120 ms × 60 轮 |
| --- | ---: | ---: | ---: |
| `store.updateProject` 调用 | 17（≈2/轮） | 48（2/轮） | 60（1/轮） |
| `sameCanvasContent`（L1 守卫） | 17（≈2/轮） | 48（2/轮） | 60（1/轮） |
| `store.updateProject` 真正写入 | 16（2/轮） | 48（2/轮） | 60（1/轮） |
| `canvasDocumentMatchesFields`（L2） | 24（3/轮） | 72（3/轮） | 180（3/轮） |
| `sameCanvasDocumentValue` | 112 | 336 | 543 |
| `mergeCanvasRefreshPatch`（L3） | 8（1/轮） | 24（1/轮） | 0 |
| `sameCanvasDocument`（L4/L6） | 8（1/轮） | 1 | 1 |
| `canonicalize` 全文序列化 | 48（6/轮） | 98（≈4/轮） | 122（≈2/轮） |
| `serializeCanvasStorageDocument` + `rebaseCanvasProjects` | 16 / 16 | 25 / 25 | 2 / 2 |
| `writeQueuedCanvasPersist`（L5 落盘） | 16（2/轮） | 25（≈1/轮） | **2** |
| `indexedDb.setItem`（画布文档 + journal） | 32 | 27 | 4 |
| `scheduleLocalCanvasBackendSync` 排程 | 16（2/轮） | 48（2/轮） | 120（2/轮） |
| `syncLocalCanvasProject` 真正执行 | 8（1/轮） | **1** | **1** |
| `commitCanvasDocument` 真正调用 | 8（1/轮） | **1** | **1** |

两处需要说明的计数：

- `store.updateProject` 17 次而写入 16 次：多出的一次发生在计数清零后约 0.5 s、第一轮之前，参数与现值内容相同，
  被守卫挡下（时间线里它后面没有 `.write`）。它证明守卫确实在真实入口上生效。**注意这类被挡下的调用仍然要付一次
  完整的 `sameCanvasContent` 比较成本**，省掉的只是写入与后续的落盘/提交——这也是 7.1 第 1 项能省下开销的原因。
- 表里用 `commitCanvasDocument`（注入计数）而不是场景的 `requests.commit`（HTTP 计数，2 s 场景 8、另两个场景 2）：
  HTTP 计数把计数窗口开始前的那次种子提交也算进去了，注入计数只数窗口内的调用。

1000 节点的数据只跑了 `poll:2000:8` 一种节奏，其**全部 17 项计数与 300 节点逐项相同**（`raw/runtime-count-1000.json`）。
所以在这个夹具里「次数」与画布规模无关，规模只影响单次耗时（3.1）。这是本夹具的结论，不是对所有路径的断言。

**可复现性**：本版定稿前在同一工作区又独立跑了一遍 300 节点全三节奏（负载 7.11 vs 首次的 6.89），
三种节奏的全部计数与首次**逐项相同**，`pageErrors` 为空；原始输出保留为 `raw/runtime-count-recheck.json`。

**时间线说明去抖为什么这样合并**（原始时间线在 `raw/runtime-count.json` 每个场景的 `timeline`，时间相对该场景第一次调用）：

- 2 s 轮询，每轮：t 处 2 次 `updateProject`（写入 2 次）与 2 次 `scheduleSync`；t+407 ms 一次落盘；t+507 ms
  `syncLocalCanvasProject` + `sameCanvasDocument` + 提交；t+519 ms 又一次落盘。两次落盘相隔 112 ms：第一次来自
  400 ms 去抖计时器，第二次是提交回执写回后 `applyAcceptedCanvasSave` 末尾的显式 `flushCanvasStorePersistence()`
  （`local-workspace-repository.ts:532`）。**每轮稳定 2 次落盘、1 次提交**。
- 500 ms 轮询，每轮：t 处 2 次 `updateProject` 与 2 次 `scheduleSync`；t+405 ms 一次落盘；**没有提交**。
  每 500 ms 一次的 `scheduleSync` 会把 500 ms 计时器一直重置 → 24 轮里后端只提交 1 次，发生在最后一轮之后
  （+12122 ms，最后一轮在 +11608 ms，即输入停止后约 514 ms）。
- 120 ms 内容更新，每轮：t 处 1 次 `updateProject` 与 2 次 `scheduleSync`，没有任何落盘。60 轮里落盘 2 次、
  提交 1 次，都在输入停止之后（落盘 +7571 ms、提交 +7681 ms，最后一轮在 +7170 ms）。

所以第一版「每轮各落盘一次、各提交一次，是上界」错在哪里：**实测是下沿，不是上界**。它有两面：

- 好的一面：连续生成期间真正落在主线程的是守卫比较与（部分节奏下的）落盘，后端提交几乎不执行，
  所以 500 ms 取回阶段的旧每分钟模型高估了 34–45%（3.3）。
- 风险的一面：**连续编辑期间文档不会落盘到 IndexedDB，也不会提交到后端**，只在输入停止 400/500 ms 后补一次。
  120 ms 媒体内容流如果长时间不断，这段时间内的改动只存在于内存。这是现有去抖语义的后果，本报告只记录这个事实，
  不在这里改，也不把它写成 7.1 的建议（要改属于单独的行为决定）。

**本节没有覆盖、也不代表的**：桌面客户端（`wails://` WebView 里的真实帧率与真实 IO）、页面级轮询（4 s 兜底、
活动任务浮层的 2 s 查询——它们不在本节挂载的钩子里，见 3.4）、真实媒体解码与 120 ms 内容流的真实来源、真实
IndexedDB/HTTP 的耗时。运行计数只回答「谁执行了多少次」，不回答「桌面端感受如何」；后者是 #95 的活。

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
| 2s/4s/5s 三个轮询各自造成整页 re-render | **部分成立**：2 s 任务订阅确实写文档 + 重渲染（运行计数已证）；活动任务浮层的 2 s 查询只重渲染不写文档，且「整页」只是代码读取的推断（本轮没测渲染次数）；4 s 轮询在服务端没变时既不重渲染也不写文档；5 s 是后端 Go 循环，不占 WebView 主线程 | 3.4 节 |
| 修复建议：把 4 s 兜底轮询当成「有 SSE 就不需要」 | **在桌面端不成立**：桌面端 origin 是 `wails://localhost`，`project.tsx:259` 的 SSE 订阅不执行 | 3.4 节、7.1 第 2 项 |
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

真正的交点有三处（两处与第 3 步相关，一处与第 6 步相关）：

1. **后台自动取回的外部 revision 频率已经存在于主线，第 3 步改的是它在「job 还在跑」时的行为。** 5 秒循环
   （`task_delivery.go:29` 的 `generationDeliveryRecoveryInterval`、`:131` 调 `startImageRecoveryPass`）与画布写回
   在 `main` 上就有，不是第 3 步新增；第 3 步的 diff 在 `image_auto_recovery.go` 里加的是一段「先查 job，pending
   就不落到冻结 POST 重放」的短路（`git diff main 6d4d1373 -- backend/internal/app/image_auto_recovery.go`），
   而 `task_delivery.go` 本身在两个提交间没有差异。每次取回成功仍是一次外部 revision，会经 `notifyCanvasRefresh`
   → 编辑器 `adoptIncomingEditorDocument` → autosave，这条路径上编辑器会额外跑一次 `mergeCanvasRefreshPatch` +
   `sameCanvasDocument`。**同一台机器上「生成中」与「后台取回」叠加时，本报告测的每分钟开销会成倍出现**；
   本轮没有测这个叠加场景（见第 8 节）。
2. **第 6 步会改变写进文档的字段集合**（按 #86 修订方案的步骤划分）。第 6 步要把前端的重试/取回判断改成只读 `taskOutcome`，并删掉 `resourceReloadAvailable`、`generationErrorCode`（前端写的部分）等字段。**这才是「哪些字段留在文档里」该动的时候**——现在动会做两遍，而且会和第 6 步的字段删除打架。
3. **整文档提交改增量依赖第 3 步的 revision 语义稳定。** 现有代码里已经有增量合同（`canvas-patch-merge.ts` 的 `CanvasPatch` + `applyCanvasPatch`），但只用在外部刷新合并上；后端提交走的是 `payload: { canvasId, expectedRevision, document: structuredClone(settled) }`（`local-workspace-repository.ts:617-621`）整份文档 + `expectedRevision` 的 CAS。把提交改成增量会改到 CAS 与冲突判定的语义，而第 3 步正在动 revision 相关的读投影与绑定路径 → **必须等它的复查结论**。

对照 #86 第 C3 项（「画布保存先验证现有合同」）的验收要求：本轮查明**没有找到绕开共用入口的写入，也没有找到可重现的丢改动场景**。按 #86 自己写的规则（「找不到反例就保留当前实现，不按文件数量改造」），保存架构不需要重构；需要改的是共用入口内部的两处实现细节。

## 7. 可现在改 / 需要等待 / 需要 Chief 决定

### 7.1 与第 3 步零重叠，可以现在安排（需指定写手）

| # | 改什么 | 最小落点 | 预期收益（证据等级） | 是否改变用户行为 |
| --- | --- | --- | --- | --- |
| 1 | store 守卫改成按元素比较：`nodes` 同长度时逐项比引用，只有引用不同的项才做深度比较（`sameCanvasDocumentValue` 已是这个语义） | `use-canvas-store.ts:846-855` 的 `updateProject` 守卫 | **计算模型**（3.1 实测单次 × 3.5 运行计数）：301 节点 2 s 轮询约 434 → 180 ms/分；1001 节点约 1834 → 924 ms/分。候选守卫的单次耗时是**实测** 0.002 ms（301 节点，已包含「一个节点变化」的情形），比 `sameCanvasContent` 的 4.195 ms 低三个数量级 | 否（只影响「要不要写」的判断；见下方前置条件） |
| 2 | 4 s 兜底轮询：**不要按「SSE 会立即触发」去延长或删除它**。可做的更小版本是「只在页面可见时轮询」（`document.visibilityState === "visible"`），保持 4 s 间隔不变 | `project.tsx:246-259` | 可见时的行为完全不变；不可见时省掉每分钟约 15 次 GET + journal 读。**这项收益没有测**（只数了请求次数，也没测不可见状态下浏览器是否已经在节流定时器） | 「只在可见时轮询」不改变前台可见延迟；**延长间隔则是行为改动**（见下） |
| 3 | 活动任务浮层的数据查询：把 `useCanvasActiveTasks` 从页面顶层移到浮层组件内，浮层收起时不查询；取消任务路径已有 `?? await queryGenerationTask(taskId)` 兜底 | `project.tsx:363`、`use-canvas-active-tasks.ts:10`、`project.tsx:2536` | 生成期间少一次页面组件函数体重执行 / 2 s。**未测渲染次数**（3.4 只是代码读取的推断） | 取消按钮在浮层收起时多一次按需查询；浮层数据晚一点刷新 |

**第 1 项的前置条件（必须写进实现说明）：** 保留「viewport 单独比较」的语义（现在由 `samePersistenceValue(current.viewport, next.viewport)` 承担），并且要比现在**更保守而不是更激进**——`sameCanvasDocumentValue` 对变化项用 `JSON.stringify`，键顺序不同会被判成「变了」，方向是「多写一次」而不是「漏写一次」，是安全的。

**第 2 项为什么不是零行为改动：** 4 s 兜底轮询是桌面端唯一的外部改动发现通道（3.4 已证桌面端不订阅 SSE），助手回合结束只是「回合结束时会多查一次」。把它延长到 10–15 s，外部客户端（CLI/MCP）、另一个窗口或后台取回写回的改动，最坏可见延迟就从 ≤4 s 变成 ≤10–15 s。要砍掉它，前提是先有桌面端可用的事件通道，或者第 3 步自动取回上线后量出真实的外部 revision 频率（7.2）。

**第 3 项为什么没有现成开关：** `useCanvasActiveTasks(projectId, projectLoaded)` 的 `enabled` 只受「项目是否加载」控制，浮层自己的 `open` 是另一个组件里的 state；而且这份数据还喂给 `activeTasksRef`（取消任务时先在这里找任务对象）。所以不是加一个 `enabled: 面板打开` 就完事，需要把查询搬进浮层、并确认取消路径的兜底查询能覆盖收起状态。

### 7.2 需要等待

| 项 | 等什么 | 原因 |
| --- | --- | --- |
| 把纯进度字段移出画布文档（情景 C） | 第 6 步前端改读 `taskOutcome` 时的字段清理 | 两处合并语义与助手上下文会一起改；现在做会做两遍 |
| 后端提交改增量 | 第 3 步复查结论 | 改 CAS 与冲突判定语义，与正在动的 revision 读投影重叠 |
| 4 s 兜底轮询进一步延长或改成事件驱动 | 桌面端可用的改动通知通道（现在 `wails://` 下 SSE 订阅不执行），或第 3 步自动取回上线后量出的真实外部 revision 频率 | 现在不知道外部 revision 多久来一次，先别把唯一的发现通道砍掉 |

### 7.3 需要 Chief 决定

1. **7.1 的三项由谁写。** 本任务按分工不改产品文件；#95 是交互显示的写手，但第 1 项落在 `use-canvas-store.ts`（保存核心），第 3 项落在 `use-canvas-active-tasks.ts`（进度查询）。按 #95 自己的约束「若需要跨到生成进度与保存的核心文件，先交 Chief 协调写入归属」，这三项要 Chief 指派。
2. **情景 C（纯进度字段不进文档）要不要做。** 它是唯一能把 301 节点这条路径从约 434 ms/分降到 0.1–0.2 ms/分（情景模型，只覆盖这条路径）的改法，但会改变：`canvas-document-rebase.ts` 的 loading overlay 结算、`canvas-patch-merge.ts` 的进度回退保护、助手上下文里的 `progress`/`stage`。Basis 需要用户确认「进度条刷新可以不走画布文档」这一条产品行为。
3. **4 s 兜底轮询要不要动，动到什么程度。** 「只在页面可见时轮询」不改前台可见延迟，可以直接排；「延长到 10–15 s」会拉长外部改动（CLI/MCP、另一个窗口、后台取回）的最坏可见延迟，而桌面端没有 SSE 兜底，需要用户确认这个延迟可接受。

## 8. 未测项与证据缺口

- **没有真机测量。** 本轮全是纯逻辑 CPU 测量，不是浏览器帧率、不是桌面客户端实机。按分工，原生同机对比由 #95 优先使用测试时段、需要同机窗口时交 Chief 协调；本报告不把函数基准冒充客户端表现。
- **同机负载高。** 三轮运行期间 1 分钟负载 9.85–11.96（10 核）。绝对毫秒数是「负载下的上界」，不是空闲机器的数字。跨轮次方差在 1001 节点上可见（`sameCanvasDocument` 12.6–18.3 ms）。
- **调用次数已在真实入口上数过（3.5），但仍限于浏览器夹具。** 运行计数用的是真实生产钩子与真实去抖，可是跑在 headless Chromium 里、后端是假 CAS 服务、生成任务由假对象驱动。桌面客户端（`wails://` WebView）、页面级轮询（4 s 兜底、活动任务浮层的 2 s 查询）、真实媒体解码与真实 IndexedDB/HTTP 的耗时都没有覆盖。
- **没有测「生成中 + 后台自动取回」叠加场景**（第 6 节交点 1），也没有测多节点同时生成（每次轮询会改写多个节点）。注意 5 秒取回循环本身在 `main` 上就存在（`task_delivery.go:29,131`），不是第 3 步新增。
- **120 ms 媒体内容合并路径只数了次数，没有跑真实媒体解码。** 运行计数显示 60 轮里落盘 2 次、提交 1 次（都在输入停止后），与第一版「后端提交几乎每次都发生」的猜测相反；但夹具里的内容更新是直接改节点字段，不是真实的解码/缩略图产出。
- **没有测 `hasUnconfirmedCanvasEdits` 在「无确认基线」时的退化路径**（`canvas-unconfirmed-edits.ts` 的 `no-baseline`），它会让 L4 直接返回 true 而不做比较。
- **没有验证 `canonicalize` 的实际分配量。** 3.3 节的 MB/分是由实测字节数 × 调用次数推算的，不是 `--expose-gc` 之类的直接分配测量。
- **没有跑 `web/` 的构建与类型检查。** 本轮只运行了独立夹具脚本（自己用 `Bun.build` 打包夹具），没有改产品文件；`bun run build`、`tsc --noEmit` 未跑。

## 9. 原始数据与复现

```text
docs/performance/2026-10-28-canvas-save-investigation/
├── fixture.ts                 合成画布夹具（节点/文档形状、进度 tick、纯视口更新）
├── measure-canvas-save-cost.ts 真实生产函数测量 + 调用模型，写 raw/run-N.json
├── summarize-runs.ts          三轮汇总，写 raw/summary.json 并打印报告用表格
├── raw/
│   ├── run-1.json             完整测量（含每项 51 次采样的中位数/p95、守卫结果、负载）
│   ├── run-2.json
│   ├── run-3.json
│   └── summary.json           三轮聚合 + 每分钟 A/B/C 模型 + 逐轮区间
└── runtime-count/             真实入口运行计数（本版新增）
    ├── harness.tsx            挂载真实 useCanvasProjectLifecycle + useCanvasGeneration + 画布 store
    ├── run.ts                 Bun.build + 假 CAS 后端 + Playwright 启动 Chrome，写 raw/*.json
    └── raw/
        ├── runtime-count.json         300 节点：2 s / 500 ms / 120 ms 三种节奏 + 逐事件时间线
        ├── runtime-count-recheck.json 同夹具第二次独立运行（计数逐项相同，用于核对可复现性）
        └── runtime-count-1000.json    1000 节点：poll:2000:8 对照
```

`runtime-count/run.ts` 不改仓库文件：计数是在 `Bun.build` 的 `onLoad` 里往真实源码的函数体开头插入一行
`__bumpCount("名字")` 实现的，注入点清单见该文件顶部的标记表。假后端只实现夹具需要的最小接口
（`/api/canvas-projects/c1/events`、`/api/canvas-projects/c1`、带真实 CAS 与 409 的 `/api/ops/canvas.document.commit`），
没有任何上游模型调用、没有真实账号或用户数据。

数据里只有合成夹具的字节数与耗时、以及计数与相对时间戳，不含任何用户内容、路径或凭据。
