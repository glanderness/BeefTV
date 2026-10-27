# canvas.bind 失败后按画布版本号重试（2026-10-27）

## 结论

- 后台扫描遇到「节点已换任务」或「节点已删除」导致的绑定失败时，记下**那次失败读到的画布 revision**。之后扫描时，画布 revision 没变就跳过；画布有任何保存（revision 变了）就重试一次，重试仍失败就记下新的 revision。
- 这替代了 #25 分支上三个后续提交（`39dfc90`、`85f2a24`、`aca445c`）里的逐字段比对。那个做法要在比对里复刻一遍「什么情况下能绑上」的规则，绑定规则每改一次就可能漏一种情况，复查了 4 轮都在补字段。现在不再判断「这次改动能不能让绑定成功」，只判断「画布有没有改过」。
- 本机副本实测 2 分钟（24 轮扫描）：`canvas.bind` 从 **286 次**降到 **58 次**，58 次全部在第一轮完整扫描里，之后为 0。中途编辑一次画布，只会让这块画布上被拒绝的目标各重试一次（实测多出 30 次），然后又回到 0。

## 改了什么（只改后台）

- `internal/canvas/task_bind.go`：`node_deleted` / `node_task_mismatch` 拒绝时，在错误里带上这次读到的 revision。拒绝判断和这个 revision 来自同一次读。
- `internal/operations/task_bind.go`：把这个 revision 放进拒绝证据 `canvasBinding.revision`。`node_deleted` 现在也带一份最小证据（节点 ID、`nodePresent:false`、revision）。这里不重新读画布，所以失败之后才落下的写入一定会让标记过期。
- `internal/task/canvas_bind_recovery.go`：标记只剩节点 ID、输出序号、原因、revision，格式版本改为 1。#25 版本 3 的标记解不开，按「没有标记」处理，下一轮重新记，不会漏绑。
- `internal/app/task_binding.go`：扫描前只读画布元数据（`CanvasProjectMetadata`，不读 payload）比较 revision。`node_mismatch` / `canvas_mismatch` 只由任务本身决定，记下后不再重试。拿不到 revision 的拒绝不记标记，退回原来的每轮重试。
- 删掉 #25 新加的 `NodeHasBindingOccupancy`、`nodeTopLevelTaskId` / `nodeHasBindingOccupancy` 证据字段，以及节点状态比对代码。

## 开工前核实的两件事

1. **每次画布写入都会让 revision 变。** `canvas_projects` 的写入路径逐个查过：`UpsertCanvasProject`（前端保存、助手写入、bind 和 Seedream 展开都走这里，`revision = expected + 1` 带 CAS）、`AssignCanvasToProject`（`revision + 1`）、`UnassignCanvasFromProject` / `DeleteProject` 里的画布改写（`revision + 1`）、恢复历史（走 Upsert）。删除整块画布后行不存在，读元数据报错，扫描按「状态读不到」处理，会去重试，不会误跳过。没找到绕开 revision 的 payload 写入。
2. **失败快照里的 revision 和失败判断出自同一时刻。** `canvas.task.bind` 在 `operations.Store.Run` 的事务里执行，先写入 op 记录拿到 SQLite 写锁，再在同一事务里读画布、判断拒绝；revision 由那次读取直接带出，不再另读一次。

## 测量方法

- 数据：用 `sqlite3 .backup` 从本机 `~/Library/Application Support/BeefTV/open_ai_canvas.db` 只读复制出副本（281 个成功任务、67 块画布），每次测量用一份新副本。真实目录没有写入；data directory 用临时目录，没有配置任何上游连接或凭据，不会提交任何生成。
- 运行：临时测试在副本上连续调用 24 次 `recoverPendingCanvasBindings(64)`（相当于 2 分钟的 5 秒扫描），统计本地 support trace 里 `canvas.bind` 的 start 事件。测量文件跑完已删除。
- 基线：每轮扫描前清空标记，等价于修复前每轮都重试。

| 运行 | 24 轮合计 | 每轮次数 | 结束时有标记的任务 |
| --- | ---: | --- | ---: |
| 基线（每轮都重试） | 286 | 10 16 11 17 4，之后每 5 轮循环一次 | — |
| revision 比对 | 58 | 10 16 11 17 4，之后全是 0 | 59 |
| revision 比对 + 第 12 轮编辑一次画布 | 88 | 前 5 轮同上，第 13–17 轮 5 8 1 5 11，之后 0 | 59 |

被编辑的那块画布上有 30 个被拒绝的任务，编辑之后正好多出 30 次，每个各一次。

## 测试

- `go test ./internal/app/ -run CanvasBindRecovery`：保留 #25 的回归测试（换任务后不再重试、指回原任务后重试一次并绑上、删除后不再重试、按原 ID 重建后重试一次并绑上、视频清空 content 后能绑上）。另加三条：失败之后画布又改过，标记必须用失败时的 revision；视频只把提交编号改回来（taskId 仍为空）也会重试并绑上；改了无关节点只重试一次，之后不再重试。
- `go test ./internal/operations/`：拒绝证据里的 revision 等于当时画布的 revision（换任务、删除两种）。
- `internal/task`、`internal/canvas`、`internal/taskbinding`、`internal/diagnostics`、`internal/repository` 全部通过。
- `internal/app` 全量有 47 个失败（缺少插件包 `.beeftv-plugin`、协议插件没安装等）。在 #25 分支原样（没有本次改动）上跑，也是同样的 47 个，和本次改动无关。

## 代价与没测的

- 经常被编辑的画布：每次保存都会让这块画布上被拒绝的目标各重试一次。重试次数只随编辑次数增长，不再每 5 秒一次。前端的视口保存也会让 revision 变（带延迟，镜头停下才保存）。
- 没有启动桌面客户端，没有做真实画面验收；没有测 PostgreSQL；没有做任何会提交到上游、可能扣费的操作。
- 扫描器仍然按游标遍历全部成功任务，那部分开销不在这次改动里。
