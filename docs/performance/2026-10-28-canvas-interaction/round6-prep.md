# 第六轮准备与记录修正（2026-10-28）

本文件是第五轮原生测量的**记录修正与补测准备**记录。它不重跑第五轮已通过的几何研究，只做三件事：
把用户更正过的口径写清楚、把第五轮记录里对不上的地方改对、把第六轮补测要用的夹具和探针准备好。

第五轮结论与证据在 `../2026-10-28-canvas-interaction.md` 与 `round5/`；本文件的每条修正都同步改回了那份报告。

## 1. 两条口径更正（用户 2026-10-28 15:17 指出）

### 1.1 重复 start + 短时长只能说明「完整窗口未证明」

第五轮 `perf-after-grouped1000-r2.ndjson` 是 14:22:16 start → 14:22:45 stop（1718 帧），紧接着
14:23:19、14:23:24 两条 start，14:23:29 才 stop（334 帧）。当时把它写成「窗口被重置、计数清零」。

**更正后的口径**：`perf-sink` 只记录探针发来的请求，**HTTP 重传本身不会执行前端 reset**；接收端时间只能
旁证。重复 start 加上明显短于设定的时长，只能得出「这一段的**完整窗口未证明**」，不能证明前端真的重置过，
也不能把两次 `start` 的先后当成因果。**重传与真实二次点击在第五轮数据里分不开**——第五轮只落了汇总行，
没有 `runId`、没有 start 序号、没有逐帧数组，无法判断 334 帧那一段是新窗口的前 5 秒、还是旧窗口的尾部。

所以第六轮探针必须让这件事可判定，而不是靠推断：见第 3 节（`runId` / `startSeq` / 单调时间 / 逐帧数组）。

### 1.2 保存 400 的影响未知，索引建立时序也给不出结论

第五轮记录里有两处越界结论，已删除：

- 不能声称「400 对交互无影响」。现有提交里**没有请求/响应体、没有访问日志、没有过程记录**，
  400 的原因、次数、是否与拖拽手势重叠都不知道。局部 drop 总量可以继续当观察值保留，
  但「保存成功/取回正常」与「整窗 FPS」在第五轮**都不能认证**。
- `indexBuild=1` 没有时序，可能是首次冷建。**不能**写成「更新后重建只需 1–2 ms」。

这两条只用于保存查因与原始记录修正，不另开任务、不扩大产品改动。

## 2. 保存 400 的查因：已知与未知边界

### 2.1 已知（代码 + 隔离库数据双向确认）

- 第五轮种子 `seed-canvas.py` 把 `metadata.content` 写成 `data:image/svg+xml,...`（内嵌媒体）。
- 后端 `asset.ValidateSyncedPayload`（`backend/internal/asset/library_document.go:279-288`）对含内嵌媒体的
  文档返回 `kernel.BadAuthRequest("画布数据包含内嵌媒体，请先上传到资源存储")` → HTTP 400；另有 4MB 上限。
- 隔离库 `canvas_projects.payload_json` 在 offset 274 处就是 `data:image/svg+xml`，整段 2,333,173 字节。
- 因此这是**夹具原因**：种子形态不合规，不是产品 bug。

### 2.2 未知（第五轮记录不足以判定）

- 400 出现的**次数**：`round5/isolated-client-access.log` 里 `POST /api/ops/canvas.document.commit` 状态行
  共 6 条（14:49:20、14:52:23、14:55:35、14:56:15、14:56:47、14:57:43），但日志只到状态码，
  **没有请求体、没有响应体、没有 `reason`**，无法确认这 6 条是否全是内嵌媒体这一条路径。
- 是否与拖拽手势**重叠**、是否与局部 drop 总量异常有关：**未知**。第五轮没有逐帧数组，
  也没有输入起止，无法做时间对齐。
- 对交互的影响：**未知**（见 1.2）。

结论写法固定为：**「唯一能与源码对上的 400 路径是内嵌媒体；其余分支未验证」**，不用 HTTP 400 反推具体处理分支。

### 2.3 第六轮的验证目标

种子改成 resource 形态后，保存**应当**不再 400。第六轮用一次真实编辑 + 保存，记录
`canvas.document.commit` 的状态码、`reason` 与时刻，与第五轮的 6 条对照；**成功保存**是这一轮的
认证目标之一（第五轮不具备）。

## 3. 夹具与探针（第六轮新增/重写）

| 文件 | 作用 |
| --- | --- |
| `seed-canvas.py`（重写） | 默认 `--media resource`：节点引用真实 resource 行（写 `resources`/`assets` 行 + SVG 落到 `<dataDir>/resources/perf/<rid>.svg`），payload 不再内嵌媒体；`--media inline` 保留第五轮旧形态用于对照。`--self-check` 不碰数据库。 |
| `seed-recovery-task.py`（新） | 往隔离库写一条 `failed`/`submission_unknown`/`routeRun=3` 的假任务 + `request_kind=create`/`succeeded` 回执（产物 URL 指向假上游），并把取回目标节点写进画布且 revision+1。复现 #87 已验证的 `retrievable / image_recovery_pending` 形态，**零付费**。 |
| `upstream.py`（新） | 常驻本地假上游。`--gate` 指定的文件出现前不回应产物请求（请求挂住），放行后返回 320×200 PNG；其他路径 404、POST 405；jsonl 记请求/响应/等待秒数。 |
| `perf-sink.py`（改） | 保留 GET `/perf` 汇总行；新增 POST `/perf` 收完整 JSON 落到 `<out>.dump.jsonl`。HTTP/1.1 + 显式 `Content-Length`。 |
| `perf-probe-round6.ts`（新） | 第六轮探针，整份复制为两侧 `web/src/perf-probe.ts`（两侧逐字节相同）。字段见第 4 节。 |
| `round6.sh`（新） | 恢复同条件初始画布并启动该侧隔离客户端；与 `round5/round.sh` 的差别是种子改用 resource 形态、清理本轮汇总行、`RECOVER=1` 时额外写取回任务。 |

resource 形态的可保存节点（与后端媒体守卫 `backend/internal/canvas/canvas_asset_guard.go:23-80` 对齐）：

```json
{"id": "...", "type": "image",
 "metadata": {"assetId": "...", "storageKey": "resource:<rid>", "content": "/api/resources/<rid>/file"}}
```

守卫要求：`assetId` 非空、该 asset 属于该 user、asset payload 引用该 resource id、resource 存在且
`status=ready`；resource 行需 `provider='local'` 且有 `object_key`，文件落在 `<dataDir>/resources/<object_key>`。
前端渲染走 `type==image && Boolean(metadata.content)` → `imageUrl = metadata.content`，卡片尺寸仍由节点
`width/height`（320×180）决定，**几何与第五轮完全一致**，可比性不受影响。

已做的夹具自检（不接触产品数据库）：

- `seed-canvas.py --self-check`：resource 模式 `inlineMedia=0, unlinkedMedia=0`；inline 模式 `inlineMedia=300`。
- 对隔离库**副本**实测：`--group-all-children` 写入 301 节点 / 150 连线，媒体 resource 173 字节，
  payload 从 2,331,173 字节降到 **151,915** 字节且无内嵌媒体。
- `seed-recovery-task.py` 在同一副本上写入任务 `perf-recover-1` 与画布 revision+1（302 节点）。
- `upstream.py`：放行前请求挂住（`curl -m 3` → 000），`touch` 放行文件后 200 / 1263 字节，404 路径正常。

## 4. 第六轮探针的字段与可复算方法

第五轮的缺陷是**只落汇总行**：19 个 ndjson 里没有逐帧数组，也没有每次输入的起止和落点实际目标，
所以 FPS/p95 无法复算、拖线帧与空闲帧无法分离。第六轮探针把原始数据一起导出（POST `/perf` → `.dump.jsonl`）：

- `frames` / `frameTimestamps` / `frameMonotonic`：逐帧间隔、epoch 时间戳、单调时间。
- `frameDropTargets` / `frameIndexBuilds`：每一帧里有几次落点调用、几次索引建立 → **拖线帧与空闲帧可分离**。
- `dropTargets`：每次落点调用的实际目标（`nodeId` / `handleId`）与耗时。
- `inputs`：`pointerdown/up/cancel`、`wheel`、`keydown/up` 全记，`pointermove` 只记每次手势的首末条。
- `startLog`：`runId` / `startSeq` / epoch / 单调时间 / `restartedWhileRecording`。
- `timeOrigin`：把 epoch 与单调时间对齐。

调用点新增钩子 `window.__perfLogDropTarget(target, ms)`，两侧各在算出 `target` 之后加一行
（`use-canvas-connection-controller.ts` 的普通与批量两条出口）。第五轮的 `dropTargetMs` 口径未改，
仍是从回调体开始到算出 target 的整段耗时，所以两侧 `dropTargetMs` 仍可直接比较，
`indexBuildMs`/`indexQueryMs` 只用于内部拆分。

**第六轮的认证标准**（先于补测场景）：一组完整录制里，逐帧数组 + 每次真实输入的起止 + 落点实际目标 +
`runId`/`startSeq` 能一一对应，且能由原始数组复算出与汇总行一致的 FPS/p95。

## 5. 第五轮记录的修正清单

1. `round5/` 实际是 **19 个 ndjson、24 条 `start`、23 条 `stop`**；报告原文「20 次录制各一条 start」错误。
2. `perf-after-grouped1000-r2` 那段 334 帧按 1.1 改成「完整窗口未证明」。
3. 索引建立时序按 1.2 撤回结论。
4. 保存 400 按 1.2 / 2.2 重写，只保留「唯一能对上源码的路径是内嵌媒体」。
5. **`round5/isolated-client-access.log` 第五轮没有进仓库**：它命中根 `.gitignore` 的 `*.log`，
   原件留在 `/private/tmp/beef-perf/app-before.log`（sha256 `214ecb117d240e6f803a686eff2c0827d1b2c969015bac88ccf66ac593127a27`，
   与 `round5/` 下同名文件一致）。第六轮按**原字节**补进仓库，并在根 `.gitignore` 加了一条只针对该目录的例外；
   报告里原先写的 `round5/isolated-client-access.log.txt` 这个名字**不存在**，已改回真实文件名。
   内容已核：无密钥、无绝对机器路径，含 Gin 启动路由 dump。
6. 报告 §7 恢复「不是安静机器」条目（第五轮采样期间 `mds_stores` 因 `rsync` 迁移工作树持续占用 CPU），
   并新增「fps / 尾延迟可复算性有限」条目。
7. 构建命令里的 `BEEFTV_MEDIA_RUNTIME` 路径写错了：正确值是
   `/Applications/BeefTV.app/Contents/Resources/agent-host/media-runtime`（`build-beeftv-release.sh:156`
   把它放到 `Contents/Resources/agent-host/media-runtime`）。按错误路径传会直接在
   `manifest.json` 处 ENOENT 失败。第六轮记录见 `native-builds-round6.json`。

**旧数据全部保留**，包括失败样本和第五轮的错误结论（只在报告中标注更正），不用新跑冒充旧日志。

## 6. 第六轮构建与采样记录

两侧构建来源、探针 sha256、二进制 sha256、构建命令与实测耗时见 `native-builds-round6.json`。
隔离客户端在 `/private/tmp/beef-perf/apps/`，数据目录 `/private/tmp/beef-perf/data/{before,after}`，
本轮证据入库副本见 `round6/`（`perf-{before,after}.ndjson` 汇总行、`perf-{before,after}.ndjson.dump.jsonl`
完整导出、`app-{before,after}.log` 后端访问日志）。

约束未变：同条件（相同初始节点/连线/视口/源/目标/时长）、隔离客户端与独立数据库、Yomado 虚拟屏、
常驻本地假上游、**零真实付费**、不动正式客户端与 `~/Library/WebKit/com.wails.beeftv`。

### 6.1 本轮已完成（有原始数据）

**保存不再 400。** 种子改成 resource 形态后，两侧隔离客户端对 `POST /api/ops/canvas.document.commit`
全部返回 **200**（after：15:31:08 载入后 42.4 ms、15:39:10 拖线后 47.3 ms；before：15:42:17 33.5 ms、
15:45:43 33.5 ms）。第五轮同一路径有 6 条 400。after 侧一次真实拖线把画布从 revision 8 推到 9，
`connections` 150 → 151，新边 `{"id":"conn-1793173150002","fromNodeId":"perf-node-19","toNodeId":"perf-node-20"}`，
payload 里 `data:image/` 出现 0 次。**这是「保存成功」第一次有端到端证据**：真实手势 → 落点 → 新边 → 落盘 200。

**一次完整真实输入的逐帧导出能一一对应并复算。** after 侧 `run-4`：

| 字段 | 值 |
| --- | --- |
| runId / startSeq | `run-4-1793173140296` / 4，`restartedWhileRecording=false` |
| 帧 / 窗口 | 1284 帧 / 21405 ms（startedAt 1793173140296 → stoppedAt 1793173161701） |
| 汇总 | fps=60.0 p50=17 p95=18 p99=18 max=42 gt33=1 |
| 由 `frames` 复算 | fps=60.0 p50=17 p95=18 p99=18 max=42 gt33.4=1 —— **与汇总完全一致** |
| 输入 | pointerdown (1098,447) 命中 perf-node-19 → pointermove → pointerup (1170,447) 命中 perf-node-20 |
| 落点 | 31 次调用，前 10 次目标为空、后 21 次目标 `perf-node-20`（`handleId` 为空字符串） |
| 落点帧 | `frameDropTargets` 里 31 帧非 0，索引与 `inputs` 的时间区间一致 |

逐帧数组、输入起止、落点实际目标、`runId`/`startSeq` 四者能对上，且拖线帧与空闲帧可以分开
（`frameDropTargets` 非 0 的帧就是活动帧）。这正是第五轮汇总行做不到的事。

**基线侧同样成立。** before 侧 `run-1`：969 帧 / fps 60.0 / max 31 ms / 3 条输入 / 31 次落点调用
（22 次目标为空、9 次 `perf-node-19`），`indexBuilds=0`（基线结构性没有索引）。

### 6.2 本轮新发现的操作性事实

1. **客户端窗口必须在前台/活动状态，否则 rAF 不跑。** 窗口被遮挡时录到 **0 帧**（after `run-2`，
   这条完整导出已入库：`round6/perf-after.ndjson.dump.jsonl` 第 1 行，`frames` 是空数组）。
   另有一次 before 侧录制出现 **122943 ms 的单帧间隔**（fps 4.0），那次录制已被随后的重新种子覆盖，
   **没有留下原件**，只能作为现场观察记录；after 的 0 帧那条有原件。第五轮的采样窗口是否也受此影响，
   现有材料无法判定（它没有逐帧数组，只有汇总）。第六轮每次采样前都先 `bring_to_front`，并把这一点记进流程。
2. **两侧落点调用点的变量结构不同，插桩不能照抄。** 候选有 `const target = resolveConnectionDropTarget(...)`，
   基线把结果内联构造。第一次按候选写法给基线插桩，运行时抛 ReferenceError，落点目标一条都没记到
   （`落点调用=47` 而 `dropTargets=0`）。基线侧必须显式传 `{ nodeId: bestNodeId, handleId: bestHandleId }`。
   修正后重新构建，31 次调用全部记到目标。
3. 窗口坐标 = CSS 坐标 + 标题栏 32 px；截图缩放会让按截图估的坐标错位，所以按钮一律用无障碍树
   `AXPress` 点，画布手势用无障碍树给出的 rail 坐标。

### 6.3 本轮**没有**完成的部分（不得当成已覆盖）

- **没有形成受控的前后对照。** 两侧各有一段完整录制，手势坐标相同（起点 CSS (930,450)、终点 (980,450)，
  600 ms / 30 步），但解析出的落点目标不同：after 得到 `perf-node-20`，before 得到 `perf-node-19`
  （且基线这次没有新增连线）。两侧的 `dropTargetMs`（before 18 ms / 31 次 = 0.581 ms/次；
  after 2 ms / 31 次 = 0.065 ms/次）因此**不能当作同输入对照**，只能作为「同一画布、同一路径长度下
  两侧落点回调成本的量级观察」。原因已定位：种子横向间距 520、卡片宽约 420、两侧 rail 各自外扩 40，
  相邻节点的 rail 只隔 20 px，落点圆半径 56 px 把两个 rail 同时罩住，解析结果对「起点落在哪个 DOM 元素上」
  敏感。正式对照要改成源与目标 rail 明显分离的路径（例如跨行拖线）。
- 普通 300 画布的原生批量连线入口、真实多选创建展开分组、滚轮/捏合缩放，仍未覆盖。
- 4000 档同状态/同输入/同窗口的对照与后台完整取回交叠，仍未覆盖。
- 第五轮 400 的次数、分支与手势重叠关系，仍无法从旧原件补齐（见第 2.2 节）。

### 6.4 复现方式

```bash
# 每轮开始（会杀掉另一侧客户端、归档该侧 WebKit 存储、按种子重写画布并启动客户端）
bash docs/performance/2026-10-28-canvas-interaction/round6.sh before   # 或 after
# RECOVER=1 round6.sh after   # 额外写一条可后台取回的假任务（需 upstream.py 已在跑）

# 探针汇总行与完整导出落盘（接收端要独立起，别和客户端同一个进程组）
python3 docs/performance/2026-10-28-canvas-interaction/perf-sink.py --port 8799 \
  --out <out>.ndjson --dump-out <out>.ndjson.dump.jsonl
```

采样时必须先让窗口成为前台窗口（`cua-driver bring_to_front`），否则 rAF 不跑、录到 0 帧。


## 7. 与 #101 固定报告「最小重采范围」的对照

固定原件：`docs/reviews/2026-10-28-canvas-connection-index.md` 第五轮一节，提交
`ad9ff9cbf38f19508fd2a256a2c71b07013e5b79`（证据同名目录 `/16d2e903/`）。它列的最小重采范围与本轮进度对照如下；
**没有重做任何已通过的产品差分、相切行为、双侧补丁或逻辑性能研究**。

| #101 要求 | 本轮状态 |
| --- | --- |
| 保留现有探针已收集的逐帧数组、每次真实输入起止及源/目标、录制序号/单调时间，并记录初始与结束文档、保存回执、负载 | **已具备并已验证可复算**（第 6.1 节）；初始/结束文档用隔离库 `canvas_projects` 的 revision 与 payload 长度记录（after 8→9 且连线 150→151；before 7→16 但连线仍是 150，说明该侧那次手势没有新增边），保存回执用后端访问日志的 `canvas.document.commit` 状态行 |
| 查清 400、验证保存并重读 | **已完成**：resource 种子后 commit 全部 200，且一次真实编辑落盘（150 → 151 条连线） |
| 首次/更新后重建、热查询分开标注 | **部分**：本轮记录了 `索引建立=1 / 1 ms`（after 拖线）与 `索引建立=0`（before），且逐帧数组能定位到建立发生在哪一帧；但「更新后重建」需要连续进度更新场景，本轮未覆盖 |
| 4000 档同状态、同输入、同窗口对照 + 逐帧数据 | **未做** |
| 1000 after 第 2 段（重复 start）若原件不能澄清则只重采该段 | **未做**；本轮探针已能区分「真二次点击」与「重传」（`startLog` 的 `restartedWhileRecording`），材料就绪 |
| 301 / 1000 / 2000 的同输入、同长窗口对照 | **未做**；且本轮暴露出这类对照的路径设计问题（第 6.3 节） |
| 普通 300、原生批量连线、真实多选建组、滚轮缩放 | **未做** |
| 访问日志依赖的可见性/请求耗时 | 第五轮原件已按原字节补进仓库（第 5.5 条），但依赖它的现场数字仍未认证；本轮新增了「窗口必须前台否则 rAF 不跑」这一条独立事实 |

## 8. 仍存在的缺口（第六轮结束后同步更新）

- 第五轮汇总行**不可复算**（无逐帧数组），只能作为观察值保留；第六轮是唯一有原始数组的一轮。
- 第五轮 400 的具体分支与手势重叠关系，**第五轮数据无法补齐**；第六轮已用可保存种子证明夹具是原因，
  但旧记录不做回填。
- **受控的前后对照仍缺**：两侧各有一段完整录制，但同一条手势路径解析出的落点目标不同，
  不能当同输入对照（第 6.3 节）。正式对照要重新设计路径，让源与目标 rail 明显分离。
- 原生批量连线入口、真实多选创建展开分组、滚轮/捏合缩放、4000 档同窗口对照、后台完整取回交叠，
  均未覆盖；`seed-recovery-task.py` + `upstream.py` 已就绪但本轮没有跑通一次完整取回。
- 附件类证据（截图）不随本目录入库，需人工确认。

