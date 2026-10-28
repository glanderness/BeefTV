# 画布交互三条路径：拖连线 / 悬停 / 节点进度查询（2026-10-28）

针对用户 2026-10-28 的反馈截图，在 v2.0.5（`6a155448`）上先复现、定位，再改已证实的原因。原始数据与可重放夹具在 `docs/performance/2026-10-28-canvas-interaction/`。

## 结论

**三条路径都测了，在 #50 那份 300 节点画布上没有任何一条是卡顿主因。**截图里「每帧 25 万次比较」「轮询必然整页重绘」在这次实测里都不成立。

| 路径 | 改前实测（300 节点） | 判定 |
| --- | --- | --- |
| 拖连线落点判定 | 0.010–0.013 ms/帧 | 不是瓶颈；但算法本身有一处超线性缺陷（见下），已修 |
| 悬停进/出节点 | 一次跨节点悬停 0.4–0.5 ms 同步提交（p95 0.8–2.0 ms），只重渲染被悬停的那一张卡 | 不是「整页重渲染」，未改 |
| 节点进度查询 | 60 条进度 × 33 张挂载卡 ≈ 0.02–0.05 ms/帧 | 低于噪声，未改 |

唯一确认的算法缺陷在拖连线落点判定：它每次 pointermove 都对**全部节点**逐个做隐藏判断，而隐藏判断内部又是一次 `nodes.find` 线性查找，成本是 `O(节点数 × 该节点的根/背板在节点数组里的下标)`。在 300 节点夹具里批量根节点排在数组前面，所以只表现为近线性；一旦根节点靠后，1000 节点就是 1.18–1.28 ms/帧，5000 节点是 33–34 ms/帧——那种画布上连线根本拖不动。这一条已修：改成按指针吸附圆查空间索引，只对命中吸附圆的那几个节点做可见性和连线策略判断。

悬停和进度查询**没有改动**。实测收益落在噪声里，按「基线没有证实问题就不要包装成已解决」处理，不为它们加改动。

## 复现方法

```bash
cd web
# 落点判定 + 进度查询（纯 JS，不联网、不调用模型、不写用户数据）
bun run scripts/canvas-interaction-bench.ts --nodes 0 --repeats 150      # 100/300/500/1000 节点
bun run scripts/canvas-interaction-bench.ts --nodes 5000 --repeats 60
# 悬停路径（真实画布组件 + 无头 Chrome）
bun run scripts/canvas-interaction-hover-bench.ts --nodes 300 --scale 0.6
```

- `scripts/canvas-interaction-bench.ts` 里 `legacy*` 是从 `6a155448` 的 `pages/canvas/use-canvas-connection-controller.ts`（`getConnectionDropTarget` / `getBatchConnectionDropTarget`）和 `lib/operation-progress.ts`（`canvasNodeOperation`）**逐行复刻**的旧实现，只把 ref 解引用改成参数传入；`current` 是当前源码。改前改后在同一个进程里交替测量，所以比值可信，绝对值受机器负载影响。
- 夹具三种：`mixed`（图片/视频/文本/分镜/折叠批次/折叠背板混合）、`batch-heavy`（一半节点是折叠批次的子节点）、`root-late`（同上，但批量根节点和背板排在节点数组末尾）。
- 悬停夹具复用仓库已有的 `test/fixtures/canvas-render-performance-harness.tsx`（真实 `useCanvasRenderModel` + `CanvasProjectWorldLayers` + 真实 `CanvasNode`），本次给它补了「页面级 hoveredNodeId → lodPinnedNodeIds → 渲染模型」这条链和一个 `hover` 用例；卡片重渲染次数由 `scripts/canvas-render-performance-server.ts` 的插桩统计。
- 机器：Mac16,10 / Apple M4 / macOS 25.6.0，`bun 1.4.2`，测量期间 load average 10–12（同机还有别的任务在跑）。绝对毫秒数因此偏高，改前改后同条件对比不受影响。

## 改前基线：拖连线落点判定

`performance.now()` 包裹单次调用的中位数（毫秒），`--repeats 150`。

| 夹具 | 节点数 | 指针位置 | 旧实现 | 新实现 |
| --- | --- | --- | --- | --- |
| mixed | 300 | 空白处 | 0.0097 | 0.0003 |
| mixed | 300 | 节点边缘 | 0.0122 | 0.0034 |
| mixed | 1000 | 空白处 | 0.0367 | 0.0002 |
| mixed | 1000 | 节点边缘 | 0.0409 | 0.0083 |
| mixed | 5000 | 空白处 | 0.1971 | 0.0024 |
| mixed | 5000 | 节点边缘 | 0.2394 | 0.0398 |
| batch-heavy | 1000 | 节点边缘 | 0.0216 | 0.0071 |
| root-late | 300 | 空白处 | 0.1069 | 0.0002 |
| root-late | 300 | 节点边缘 | 0.1104 | 0.0053 |
| root-late | 1000 | 空白处 | 1.1846 | 0.0001 |
| root-late | 1000 | 节点边缘 | 1.2807 | 0.0100 |
| root-late | 5000 | 空白处 | 33.9951 | 0.0012 |
| root-late | 5000 | 节点边缘 | 32.7385 | 0.0763 |

按 60 fps 的 16.7 ms 预算：300 节点时旧实现占 0.06–0.08%，确实不是卡顿主因；`root-late` 1000 节点占 7%，5000 节点直接把一帧撑满（33 ms/帧 ≈ 30 fps 上限，且这一帧只用来算落点）。缩放 0.3 那一档的数据在同名 JSON 里，趋势一致。

## 改前基线：悬停

300 节点、`hover` 用例 = 每次把 `hoveredNodeId` 换到一个**当前视野内**的节点（真实鼠标只会停在看得见的卡上），40 次。

| 缩放 | 画布状态 | 挂载卡 | 提交中位数 / p95 | 渲染模型重算中位数 | 被悬停卡重渲染次数 | 其它卡重渲染次数 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.25（缩略图模式） | lod | 1 | 0.5 / 2.0 ms | 0.1 ms | 40 | 0 |
| 0.6 | 普通卡片 | 49 | 0.4 / 1.5 ms | 0.1 ms | 98 | 0 |
| 1.0 | 普通卡片 | 20 | 0.4 / 0.8 ms | 0.1 ms | 83 | 9 |

同一次运行里的对照：改节点标题（`title`）0.3–0.4 ms、平移视口（`pan`）0.1–0.3 ms。**悬停和一次普通的节点状态更新同量级，只比它略贵**；除被悬停的卡以外，其它卡基本不重渲染（`other` 列 0–9 次 / 40 次，来自悬停目标切换时的那一两张）。

所以截图里「hover 进/出节点触发整页重渲染」不成立：页面级 state 确实会重跑渲染模型和世界层元素列表，但 `React.memo` 把重渲染收在被悬停的那张卡上。

一个**未处理的观察**：`visibleNodes` 会把被 pin 的节点（含 hovered）排到数组前面，而 `sortCanvasNodesByStackOrder` 在交互顺序为空时原样返回，于是悬停会让那张卡的 DOM 元素在容器里前后移动一次（叠放顺序随之变化，重叠卡片上可见）。这是显示层语义，不是本任务能单方面改的，留作后续决策。

## 改前基线：节点进度查询

`canvasNodeOperation` 每张挂载卡每帧调一次（zustand selector），33 张卡。

| 进度条目数 | 旧实现（33 次查询） | 新实现（未改） |
| --- | --- | --- |
| 1 | 0.0034 ms | 0.0055 ms |
| 10 | 0.0067 ms | 0.0078 ms |
| 60 | 0.0480 ms | 0.0267 ms |
| 200 | 0.0736 ms | 0.0741 ms |

同一份代码两次运行就能差 0.02 ms（`entries=60` 两列反着来），所以这一列是噪声。进度更新本身有 150 ms 节流（`startOperation` 里 `Date.now() - lastReport < 150` 直接返回），每秒最多 7 次。**结论：不值得改**。`Object.values(entries).reverse().find(...)` 每次确实多分配一个数组，但在这个规模下看不见。

## 修改

只改了一处产品代码，新增一个纯函数模块：

- 新增 `web/src/lib/canvas/canvas-connection-target.ts`：`resolveConnectionDropTarget` / `resolveBatchConnectionDropTarget`。落点判定先按指针吸附圆查一次均匀网格索引（复用 `lib/canvas/canvas-spatial-index.ts` 的 `buildCanvasSpatialIndex`），再对命中节点做原来的可见性判断、端口计算和连线策略判断。命中顺序保持原样：取文档顺序最靠后的可连接节点，而不是最近的一个。
- `web/src/pages/canvas/use-canvas-connection-controller.ts`：两个 `useCallback` 改成调用上面的函数，其余逻辑（指针捕获、rAF 合帧、快速创建菜单、批量连接）一行没动。
- 索引按**节点数组身份**缓存在一个 `WeakMap` 里。节点数组是整份替换的不可变更新，所以索引不会过期，也不需要新增一份要同步的状态；数组换了身份就自然重建。
- 没有新增设置项、开关、过滤或兜底逻辑。

## 行为保持证据

- **差分**：5400 组随机指针位置 × 3 种夹具 × 3 个缩放（1 / 0.3 / 2.5），新旧实现返回的节点、端口 id、`isNearNode`、`anchorRatio` 完全一致，0 处不一致（`parity` 字段在两个 JSON 里，`mismatches: 0`）。5000 节点那一轮同样是 5400/0。
- **新增用例** `web/test/canvas-connection-target.test.ts`（15 条）：吸附圆边界（55 px 命中 / 57 px 不命中）、重叠时取文档顺序靠后的节点、折叠批次子节点与折叠背板子节点不可命中（展开后恢复）、背板本身不可命中、分镜按行返回端口且表头不命中、批量表按参考列返回端口、落在圆内但连线不合法时 `isNearNode` 仍为 true、源节点自身不算落点、零尺寸卡片可命中、节点数组换新后索引跟着换、缩放越大世界半径越小、**命中判定只读指针附近的节点**（2000 个节点的几何属性被 getter 计数，空白处和命中处都 < 50 次读取；旧实现是每次 6000+ 次）。批量连线三条。
- **相关检查**：`bun run typecheck`、`bun run lint` 通过。`test/canvas-connection-drag.browser.test.ts` 9/9、`test/canvas-viewport-controller.browser.test.ts` 1/1 通过。
- **批量回归**：199 个非浏览器画布测试文件一起跑，改前改后**同为** 1428 通过 / 1 跳过 / 78 失败 / 2 错误 / 13337 断言 / 1507 用例。这 78 个失败是同一进程里跨文件全局状态串扰（`canvas-generation-submission`、`canvas-folder-storage`、`canvas-drawing-storage` 等），改前就存在，单独跑这 4 个文件 64/64 通过；与本次改动无关。

## 没做的 / 未测的

- **原生客户端 FPS 与真实鼠标事件分发没测**。本轮只有逻辑耗时（`performance.now` 包裹的纯函数）和浏览器内同步提交耗时，都不是 FPS，也不含绘制/合成与原生宿主。按约束「同机原生性能对比不能同时抢屏」，需要原生测量时间窗时交 Chief 协调。
- **悬停、进度查询不改**，理由见上；如果后续在更大画布或更差负载下测出悬停提交超过一帧预算，再单独开。
- **平移缩放的剩余卡顿不在本任务写入范围**：既有证据在 `docs/reports/2026-10-27-mac-canvas-perf.md`（#40）与 `docs/reports/2026-10-27-mac-canvas-perf-fix.md`（#50，v2.0.5 已含其四处修复）。截图里的「每次 patch 都做两遍全文档 JSON 规范化」「生成期间三层保存叠加」指向 `stores/canvas/use-canvas-store.ts` 与保存链路，属于保存研究任务的写入范围，本轮只把线索留在本条。
- **连线拖动过程中每帧的 `document.elementFromPoint` / `closest()` / `getBoundingClientRect()`（参考图替换提示）没测**。它们会强制布局，可能是同一帧里比落点判定更贵的一项；本轮夹具没有覆盖，作为下一步候选。
- **`root-late` 那种节点顺序在当前代码里到不了**：`bringNodeToFront` 只改 `nodeStackOrder`，不会重排 `nodes` 数组，也没找到任何把节点数组按 Map/对象重建的地方。所以这一列是「算法在最不利输入下的表现」，不是当前客户端的现状；写它是为了说明这次修的是算法量级，而不是某次卡顿的复现。
