# 第七轮：报告更正、两侧完整插桩补丁与实机采样准备（2026-10-28）

本文件接续第六轮（`round6-prep.md`、`round6/`），落实 #101 独立复核
（`docs/reviews/2026-10-28-canvas-connection-index.md`，固定 `b1a68712117ccbd821094a5a3dcdc8072f4d4d32`）
第六轮一节**第 7 节「主力可接续的最小修改」**的第 1–3 条与第 5 条的静态部分。第 4 条（恢复约定环境后实机采样）
与第 5 条的实机部分留给下一轮。

## 0. 本轮边界与来源

**只做四件事**：改报告事实、固定两侧完整插桩来源、给探针与插桩补必要输入字段、静态核对与准备数据。
**不做**：不启动 Mac 客户端、不编译 Go、不做正式采样（同机 #88 正在一次并行诊断）、不改产品代码、不联网、
不产生任何真实付费。

| 输入 | 固定来源 |
| --- | --- |
| 作者第六轮完整成果 | 提交 `6654c90afa98534f8d3fc155d53d5b3e91494bae`，分支 `tds/conv-01a18157-690d-78de-9208-0b4516f6f843` |
| 独立复核 | 提交 `b1a68712117ccbd821094a5a3dcdc8072f4d4d32`，分支 `tds/conv-01a18157-7169-7827-95ae-396dfaa56f49` |
| 产品 before | `6a155448096d2425aa07e81cc6016410091ad0be` |
| 产品 after | `e54d4863d52244c5b024464c70e6a1e9e7a4e0c7` |
| 两侧实际插桩原件（只读读回） | `6654c90a/readback/{before,after}/web/src/**`（13 份，哈希见 `round7/instrumentation-hashes.json` 的 `round6Readback`） |

**未按印象重写旧插桩**：第七轮的两侧补丁由 `readback/` 里的实际留存文件生成（生成方式见第 3.4 节），
补丁套回固定产品提交后的结果与 `readback/` **逐字节一致**（静态核对已断言）。

## 1. 交付物清单

| 文件 | 内容 |
| --- | --- |
| `round7-prep.md`（本文件） | 报告更正、字段说明、静态核对结论、下一轮清单 |
| `round7/perf-probe-round7.ts` | 共享探针（两侧逐字节相同，sha256 `fb10d7e0…436d89`） |
| `round7/round6-instrumentation-{before,after}.patch` | 第六轮**实际运行过**的插桩，完整补丁（对各自固定产品提交） |
| `round7/round7-instrumentation-{before,after}.patch` | 追加第七轮必要字段后的完整补丁（对各自固定产品提交） |
| `round7/instrumentation-hashes.json` | 固定原件、第六轮读回、第七轮新件的完整 sha256 |
| `round7/static-check.py` + `round7/static-check.json` | 静态核对脚本与结果 |
| `round7/probe-gesture-check.ts` + `round7/probe-gesture-check.json` | 第七轮探针新逻辑的功能核对（bun，DOM shim） |
| `round7/callback-replay.json` | 复用 #101 的等输入窄回调复放结果（未重做） |
| `round7/independent-round6.json` | 复用 #101 对第六轮逐帧数据的独立重算（静态核对的对照基准） |
| `round7/native-builds-round7.template.json` | 下一轮构建身份模板（要求完整哈希 + PID） |

## 2. 报告事实更正（#101 第六轮复核第 7.1 条）

以下逐条更正已**就地写回** `round6-prep.md` 与 `2026-10-28-canvas-interaction.md` 的对应段落，原文保留为历史。

### 2.1 两侧实际输入不同，基线松手时目标为空

撤下「两侧手势坐标相同（起点 CSS (930,450)、终点 (980,450)，600 ms / 30 步）」。原件（`clientX/clientY`）是：

| 项目 | after `run-4-1793173140296` | before `run-1-1793173561266` |
| --- | --- | --- |
| pointerdown | `(1098,447)` | `(930,450)` |
| 第 1 条保留的 move | `(1100,447)` | `(932,450)` |
| pointerup | `(1170,447)` | `(980,450)` |
| down → up | 779 ms | 787 ms |
| 落点序列 | 前 10 次空 → 后 21 次 `perf-node-20` | 前 9 次 `perf-node-19` → 后 22 次空 |
| 松手时目标 | `perf-node-20` | **空** |

因此两侧的 `dropTargetMs` 只能当量级观察，**不是**同输入对照。另外，第六轮输入记录里没有 `pointerId`、
`buttons`、`handleType`、`current`、`world`、`viewport`、容器矩形与显示器身份，`handleId=""` 是
`null/undefined` 被转成空字符串后的目标标识，说明不了源是输入端还是输出端。

### 2.2 「rail 重叠已定因」撤下

撤下「原因已定位：相邻 rail 只隔 20 px、56 px 吸附圆同时罩住两个 rail」。产品的目标锚点由
`getConnectionTargetAnchor` 按 `current.handleType` 选择目标节点左/右侧；没有导出实际源端口与坐标变换，
就没有依据说哪个吸附圆参与了判断。换跨行路径后通过**不能**解释这次差异。参见第 5 节。

### 2.3 保存 200 的范围与一处抄录错误

- before 第一次是 **42.633250 ms**（原写 33.5 ms，抄录错误），第二次 33.529375 ms；after 42.446959 / 47.270542 ms。
- 四条都只是**访问日志状态行**，没有请求/响应正文或 operationId，不能关联到具体文档内容。
- before 两条 200（15:42:17、15:45:43）都**早于** `run-1` 的手势（15:46:06.694–15:46:07.481），
  不是该次手势新增边的成功回执。
- 「revision 8 → 9、连线 150 → 151、含 `19→20`」来自 #101 复核对留存隔离库的**当前**只读读回；
  采样前的 revision 8 / 150 边**没有历史原件**。可以认可「resource 夹具能保存、after 的新边当前已持久化」，
  不能写成「已独立读取两个历史状态」或「已验证重启恢复」。后台完整取回仍未完成。

### 2.4 现场环境不满足用户约定的虚拟屏

`native-builds-round6.json.samplingEnvironment` 写的是 **G22A 1920×1080（主显示器）**、内容区 1440×960、dpr=1；
原件里没有显示器枚举、窗口所属 display/坐标、focus/visibility 时序，`round6.sh` 也**没有**把窗口放到虚拟屏的动作。
所以第六轮应标为「主显示器上的隔离客户端记录」，**不能**宣称满足 Yomado 虚拟屏、不抢主屏。
「窗口被遮挡时录到 0 帧」这一观察**不授权**改用主显示器。

### 2.5 标记帧 ≠ 完整 down/up 区间；move 首末未按手势处理

- `frameDropTargets>0` 只表示两次探针观察之间计数增加。按 down/up 事件时间，两侧各有 **47 次 rAF 回调**
  落在手势内，而标记帧只有 **31 个**；最后一次松手调用在 up 后 **15 / 26 ms** 的探针帧才体现。
  不能把无标记帧当空闲，也不能把计数标记的时间戳当调用精确开始时间。
- 第六轮 `pointermove` 用一个全局计数器 + 取模采样，**无法把移动归属到某一次手势**，也给不出「每手势首末」。
- 「122943 ms 单帧间隔」**没有原件**（那次录制被随后重新种子覆盖），本轮不认证这个数字。

## 3. 第七轮探针与插桩（#101 第六轮复核第 7.3 条）

### 3.1 新增的记录字段

| 字段 | 位置 | 作用 |
| --- | --- | --- |
| `connectStarts[]` | 真实开始入口（`handleConnectStart` / `startBatchConnection`） | `entry`、`pointerId`、`nodeId`、`handleType`、`handleId`、`anchorRatio`、实际 `rail`（`data-canvas-connection-rail` 的值与矩形）、client 坐标、`projectId`、节点数、连线数 |
| `dropTargets[]`（改为整条对象） | 每次落点调用 | `entry`（`ordinary`/`batch`/`batch-no-source`）、`clientX/Y`、`worldX/Y`、`viewportX/Y/K`、`containerRect`、`target`（resolver 返回值的完整浅拷贝）、`targetNodeId`/`targetHandleId`、`projectId`、`nodeCount`、`connectionCount`、`ms`、`recordMs` |
| `gestures[]` | 每次 pointerdown→up/cancel | 按 `pointerId` 归属：`downT`/`endT`/`endType`、`down`/`end` 坐标与节点、`moveCount`、`firstMove`、`lastMove` |
| `hoverMoves` | 无按下的移动 | `count`/`firstAt`/`lastAt` |
| `perf-env` 按钮 + `env` 上报 | 探针 UI | `screen`、`availLeft/Top`、`screenX/Y`、`outer`/`inner`、`dpr`、`visibilityState`、`hasFocus`、画布容器矩形 |

文档身份在调用点可得的量是 `projectId + nodeCount + connectionCount`（控制器的 refs 就是当前文档内容）；
权威的 `revision` / payload 长度仍以采样边界的隔离库只读读回为准（第六轮就是这样做的）。

### 3.2 计时口径：新增记录开销与落点计时分开

`dropTargetMs`（汇总）与每条记录的 `ms` **口径未改**，仍是从回调体开始到算出 `target` 的整段耗时，
两侧仍可直接比较。第七轮新增的记录开销（对象构造 + 一次 `getBoundingClientRect`）发生在计时区间**之后**，
由探针单独计量为每条记录的 `recordMs`，**不与落点耗时混算**。`recordMs` 是在真实事件/rAF 路径里发生的
同步开销，读报告时不能忽略。

### 3.3 三类区间分开

导出与汇总行同时给出：**整窗帧**（`frames.length`）、**完整 down/up 区间内的 rAF 回调**
（`手势内rAF`，按每次手势的 down/end 时间与逐帧时间戳求交）、**计数标记帧**（`frameDropTargets>0` 的个数）。
三者不再混用（第 2.5 条）。

### 3.4 两侧完整补丁与完整源码哈希

- `round7/round6-instrumentation-before.patch` / `…-after.patch`：第六轮实际运行过的插桩（此前只有
  `native-builds-round6.json` 的行号与文字描述，缺完整补丁，见 #101 复核第 3 节）。
- `round7/round7-instrumentation-before.patch` / `…-after.patch`：追加第 3.1 节字段后的完整补丁。
- 补丁对各自**固定产品提交**生成，`git apply -p1` 可直接套用（静态核对已断言）。
- 完整 sha256 见 `round7/instrumentation-hashes.json`；两侧探针逐字节相同。
- 下一轮构建身份按 `round7/native-builds-round7.template.json` 填**完整**哈希 + PID + 进程启动时刻，
  与 `runId` 相连。

两侧补丁的生成方式（可复现）：从固定产品提交取被测文件 → 套 `readback/` 的第六轮插桩得到第六轮补丁；
再把第六轮控制器加上第 3.1 节的记录点得到第七轮补丁；探针作为新文件加在 `web/src/perf-probe.ts`。

## 4. 静态核对结果（不启动客户端、不编译 Go、不联网）

`python3 docs/performance/2026-10-28-canvas-interaction/round7/static-check.py --repo <BeefTV 仓库根>`

`round7/static-check.json`：

1. **补丁可用性**：四个补丁在各自固定产品提交上 `git apply --check` 通过并成功套用；
   第六轮补丁套完的结果与 `readback/` **逐字节一致**（`round6ReadbackHashMatch = true`，两侧）；
   第七轮补丁套完的控制器含全部要求字段（`allRequiredTokens = true`，两侧），探针哈希与
   `instrumentation-hashes.json` 一致。
2. **数字可复算**：只读 `round6/perf-{before,after}.ndjson.dump.jsonl` 重算 4 条录制，
   帧数 / fps / p50 / p95 / p99 / max / gt33、落点目标序列、松手时目标、完整 down/up 区间内的 rAF 回调、
   计数标记帧，与 #101 的 `independent-round6.json` **零不一致**（`compareMismatches = 0`）。
   其中两侧的「完整 down/up 区间内 rAF = 47」「计数标记帧 = 31」与复核一致。
3. **探针口径**：`__perfLogDropTarget` / `__perfLogConnectStart` 存在；move 按 `pointerId` 手势归属
   （`activeGestures`/`gestureLog`）；三类区间分开（`frameCallbacksWithinGestures`）；悬停移动单独汇总。

补充的功能核对（`round7/probe-gesture-check.ts`，bun + DOM shim，不启动浏览器）：
`round7/probe-gesture-check.json`，`ok = true`。它用两个不同 `pointerId` 的手势验证
「move 首末按手势归属」（`pointerId=7` 的 `moveCount=3`、首末 `1100→1170`；`pointerId=9` 的 `moveCount=1`）、
无按下的移动只进 `hoverMoves`、`pointermove` 不进 `inputs`、落点记录含全部新字段，
以及「整窗帧 4 / 手势内 rAF 4 / 计数标记帧 1」三者分开。

**仍未验证**（下一轮才能做）：套上补丁后的两侧客户端能否构建、能否运行、以及实机采样本身。
本轮只做了 `bun build --no-bundle` 级别的语法解析通过。

## 5. 同一实际源/方向/坐标的核对（复用 #101，不重做）

#101 已做一组**明确给定源/handle/世界坐标**的窄回调复放（identity 变换、缩放 1、连线数组为空，
读取原工作树留存的实际控制器与各自固定产品的未插桩回调逐字比较），结果在 `round7/callback-replay.json`：
两侧各 6 例**结果一致**，且记录的 `nodeId`/`handleId` 与返回目标一致、每次调用只计 1 次。

| 明确给定的输入 | before 与 after 的相同结果 |
| --- | --- |
| 源 19，`handleType=source`，世界点 `(908,450)` | 空目标 |
| 同一源/方向，点 `(980,450)` | 节点 20 |
| 源 20，`handleType=target`，点 `(930,450)` | 节点 19 |
| 同一源/方向，点 `(980,450)` | 空目标 |
| 批量源 `[19]`，点 `(980,450)` | 节点 20 |
| 批量无源，点 `(980,450)` | 空目标 |

按本轮执行约束「已通过几何/回调研究不重做」，第 5 节**直接复用**这份结果，不重新跑复放。
它的边界（复核已声明，本文件沿用）：这是**受控逻辑输入**，不是原生手势，也不是历史现场复现；
不能据此宣布「旧差异已解释」。正式对照仍须在原 19/20 节点附近做一次**锁定实际源/handle、初始图、
视口与容器变换**的等输入核对——第七轮探针已能记录这些字段（第 3.1 节），核对通过后再选更易稳定投递的路径，
并把它作为**新实验**记录。

## 6. 数据与脚本准备

### 6.1 挂载与路径事实（本轮实测）

`/Volumes/Workspaces`（`/dev/disk5s1`）与 `/Volumes/ExternalWork`（`/dev/disk5s4`）是**两个不同的卷**，
不是别名或挂载点映射。因此第六轮 `round6.sh` 里写死的
`/Volumes/Workspaces/Worktrees/BeefTV/canvas-interaction-perf-20261028` 属于**遗留 Workspaces 路径**，
不能自行当作符合「已挂载 ExternalWork」约定。本会话的工作区在 `/Volumes/ExternalWork/todos/workspaces/…`，
符合约定。下一轮要么把两侧 perf 工作树建在 ExternalWork 上，要么先说明 Workspaces 卷的用途并单独记录，
不能把两者当成同一个卷。

### 6.2 夹具与假上游（本轮实测，均不接触产品数据/不启动客户端）

| 命令 | 结果 |
| --- | --- |
| `python3 seed-canvas.py <dir> --self-check` | 4 组：`resource` 模式 `inlineMedia=0`、`inline` 模式 `inlineMedia=300`；普通 300 节点 / 150 连线，分组 301 / 150；`invalidEndpoints=0` |
| `python3 seed-recovery-task.py <dir> --self-check` | 构造出 `failed` / `submission_unknown` / `routeRun=3` 任务 + `create`/`succeeded` 回执，产物 URL 指向假上游 |
| `bash -n round6.sh` | 通过（脚本语法可用；但见 6.1 的路径问题） |
| `python3 upstream.py --help` | 参数 `--port/--gate/--log/--artifact` 齐备 |

`seed-recovery-task.py` 的边界（脚本自述）：它覆盖「后台取回 → 更新画布 → 客户端 4 秒兜底取回并应用」；
覆盖「上游正在生成、进度持续更新」还需要一条绑到假上游的模型渠道 + 带 `provider_request_id` 的 running 任务，
**本轮仍未准备**。

### 6.3 隔离客户端与数据目录现状

`/private/tmp/beef-perf/apps/BeefTV2-{before,after}.app` 与 `/private/tmp/beef-perf/data/{before,after}`
仍在（第六轮构建产物）。它们带的是**第六轮**插桩，下一轮必须用第 3.4 节的第七轮补丁重建后再采样。
`round6.sh` 只启动客户端、不设虚拟屏位置，也没有记录显示器身份——下一轮要补上（第 7 节）。

## 7. 下一轮实机采样的执行清单与验收条件

按 #101 第六轮复核第 7 节的第 4、5 条，与原任务的实机范围（普通 300、分组及既有 301/1000/2000/4000 档，
普通/批量连线、悬停、真实多选建组、平移与滚轮/捏合缩放，活动任务浮层、不可见/恢复、持续生成进度与后台取回交叠）。
**不扩大节点规模；只重采受已证缺口影响的部分；已通过的几何/回调研究不重做。**

1. **环境**：所有 Mac 客户端与真实鼠标只在用户约定的 **Yomado 虚拟屏**、自有 PID、独立 bundle/数据库；
   每次采样前用探针 `perf-env` 记录显示器身份、窗口位置、dpr、focus/visibility，并确认连续帧可用。
   若虚拟屏确实无法持续采帧，**报具体实测限制交 Chief 协调**，不得自行改用主显示器。
2. **构建**：按第 3.4 节重建两侧客户端，填实 `native-builds-round7.json`（完整哈希 + PID + 进程启动时刻）。
3. **等输入核对**：先在原 19/20 节点附近做一次锁定 `current`/rail/初始图/视口/容器变换的核对。
   一致 → 再采稳定性能路径（作为新实验记录）；仍有差异 → **保留证据并报告**，不靠换路径宣称旧差异已解释。
4. **采样**：沿用 `perf-sink.py`（汇总行 + 完整导出），保持 4 秒查询、进度持久化与取消/恢复行为不变；
   零真实付费，常驻本地假上游，不动正式客户端与生产。
5. **保存**：记录采样前/后的文档（隔离库只读读回）与可关联的 commit 回执；区分固定提交原件与后来读回。
6. **验收**：三类区间分开给出；每次落点记录含 client/world/viewport/容器矩形/完整返回值/文档指纹；
   每手势 move 首末；`runId` 能反查到完整源码/二进制/进程。

## 8. 未覆盖与待确认（本轮结束时）

- 本轮**没有**实机采样，因此「同一实际源/方向/坐标与文档下两侧是否一致」「约定虚拟屏上原范围有哪些可重复的改善」
  两个待确认问题仍**未回答**；第 5 节只给出受控逻辑输入的等价，不等于历史现场等价。
- 第六轮 47/31 的区间划分已复算通过，但第六轮的 4 条录制仍是**不同实际输入**，不能合成性能前后对照。
- 第五轮 400 的分支与手势重叠关系仍无法从旧原件补齐；第六轮 400 已由 resource 种子消除。
- 附件类证据（截图）不随目录入库，需人工确认。
