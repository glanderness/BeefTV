# 单次并行冷启动诊断准备

状态：**只准备，未运行 Go、客户端或实际捕获**。#95 仍占用采样窗口；只有 Chief 明确通知本轮补采样结束后，才能另行调用 `execute`。本轮准备完成即提交返回，不在工具中等待，不自行换模型或配置。

## 本回合中断的直接证据

[interruption-event.json](interruption-event.json) 来自本会话真实 Codex rollout：北京时间 15:33:52.943 开始，15:36:34.820 的 `task_complete.error.codex_error_info` 为 `server_overloaded`，错误说明模型满载。该回合只有进度文字，没有 final；它没有完成准备交付。

只保存脱敏事件、原始行号和截至结束事件的前缀 SHA-256，不复制聊天全文、凭据或其他任务日志。#39 关于 Todos 0.1.68 漏报错误的既有诊断仅作为平台表现的解释线索；本轮没有重做其九组模拟、截获平台请求、升级、重启或更改共享程序。本次上游中断原因由自己的结束事件确认，不是类推。

## 旧条件能恢复多少

5.588 秒失败的直接来源是 `850d89c1` 保存的 `revision/accepted-check/backend-all.json/txt`，不是更早的 `final-check`。后者另有 5.911 秒及其他业务失败，不能混作同一次。已保存条件的哈希、行号、恢复判断见 [source-conditions.json](source-conditions.json)。

| 条件 | 已有证据 | 本次采用及限制 |
| --- | --- | --- |
| 实际命令 | `go test ./... -count=1 -timeout=25m`，原 replay 的 `--full` 分支；本机旧 rollout 也记录同一调用 | 一次同样的 `./...` 包范围，附加只读依赖、JSON 观测及 `-exec` 回调；不循环、不另跑冷启动单项 |
| 包范围 | 实际输出 69 包，66 包有测试、3 包无测试，见 [original-packages.json](original-packages.json) | 保留这些包作为自然测试背景；不能挑几个重包后声称与旧现场相同 |
| 精确并发 | 没有逐包开始时间，输出按包归集 | 原时刻同时运行哪些包无法恢复；新命令记录各包 start/pass/fail/skip，区分包级和测试级事件，不用它倒推旧时间线 |
| `-p`、`-parallel` | 原显式命令均未指定；继承的 `GOFLAGS`、`GOMAXPROCS` 未保存 | 新命令也不手设两个参数，环境中不继承旧业务或 Go 配置。默认 `-p` 取 Go 进程的 GOMAXPROCS；原有效值未知，不能写成已知的 10。`-parallel` 不是跨包 `-p` |
| 工具链 | 原失败输出和元数据没有 `go version`，也没有可确认版本的工具链路径 | 准备时只定位现存 Go 1.26.3 路径并读二进制哈希，没有执行。执行前后另记实际版本和环境，不能把下午单项使用 1.26.3 当作中午失败的版本证明 |
| 源码与模块 | 原 1936 份输入指纹与固定 `850d89c1` 核对；Go 模块、冷启动测试与 Open 在 850/30ed 相同 | 当前产品固定 `30ed8d92`，与 850 有两处产品文件和一份新增测试文件的差异，详见下文；不是旧产品完全重演 |
| 协议包 | 原清单只含协议源码指纹，没有当时物化归档的哈希或目录环境 | 使用上一轮单项的同一批 86 个现有归档，按哈希复制冻结；不重新打包。不能证明与旧失败时的归档逐字节相同 |
| 数据盘 | 日志能确认源码在 ExternalWork，不能确认 `t.TempDir()` 的原位置；原脚本继承 `TMPDIR` | 新数据、缓存及源副本全部固定 ExternalWork，原临时盘位置不可恢复，不假装相同 |
| 历史夹具 | 原 replay 先用固定 6a155 创建 v26，再用 6d4 升级其副本为 v27，设置两个 REVIEW 变量 | 保留相同生成程序和两次 `go run` 准备输入；它们不是另一次测试或 N1 回归，且在唯一并行命令前结束 |
| 宿主依赖 | 原套件含 Node 宿主业务探针，不能只复制 backend 就运行 | 完整 Git 源码副本加现存 `agent-host/node_modules` 的任务内副本；package.json/bun.lock 与候选相同，不安装、不改共享依赖 |
| 机器负载、缓存 | 没有旧失败时的调度 trace、负载或缓存快照 | 只记现场，不施加 CPU/IO 压力；新进程、新 SQLite 也不等于清空系统缓存 |

## 一次捕获的实际范围和占机

原命令是整个后台的包集合。保留它就会运行 `app`、`handler`、`canvas`、`plugins`、`database` 等旧套件中的既有用例，包含已通过的相邻回归；这些是原并行背景的一部分，**不是新增的专项回归批次或重新验收**。原实际包名和耗时逐项列在 `original-packages.json`，不能隐去这一范围称为“只跑 bootstrap”。

旧命令总墙钟为 925.315 秒（15 分 25 秒），其中 app 报告 919.516 秒、bootstrap 163.275 秒。预计单次捕获连同夹具准备、编译和拷贝约占机 15–25 分钟，仅为估计；原 `-timeout=25m` 是每个测试二进制的预算，不保证整条命令在 25 分钟内结束。启动后由执行会话持续监控，不留后台等待或自动重试。

当前 `30ed8d92` 比 `850d89c1` 只变了 `image_submission.go`、`service.go` 和新增的 `step3_image_retry_after_refund_test.go`。前两项修正保留；新增 N1 测试源码也保留，但本次通过 app 的 `-test.skip` 排除以下两个新顶层用例及其子项：

```text
TestStep3ImageRefundRetryAfterResultConclusion
TestStep3ImageConclusionWithoutRefundDoesNotRequeue
```

独立 Opus N1 探针本就不在产品测试目录中，本次不叠加。没有单独运行 N1 或已通过回归，没有改变其实现。与旧范围的测试输入差异、候选产品差异及诊断开销均记录，不能把此次输出称为 850 的重验通过。

## 已准备的命令

准备只使用 Git 只读命令、Python 文件操作及现存工具文件，不执行工具链。实际准备输出与子进程审计见 [prepare-only.txt](prepare-only.txt)、[prepare-check.json](prepare-check.json)。[prepared.json](prepared.json) 是本轮准备记录，不是执行完成记录；[open-phases-trace.patch](open-phases-trace.patch) 和 [diagnostic-runtime.go](diagnostic-runtime.go) 可直接审阅。

后续接续时，在已挂载 ExternalWork 上使用尚不存在的任务目录重新生成相同材料。`STEP3_PARALLEL_INPUT` 指向上一会话仍在的源码/物化包目录：

```sh
STEP3_PARALLEL_INPUT=/Volumes/ExternalWork/todos/workspaces/01a18064-1402-7d75-9399-bb10bb3d06d2
STEP3_PARALLEL_WORK="$PWD/.local/cache/step3-parallel-once"
python3 docs/implementation/evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/capture_once.py prepare \
  --repo "$PWD" --workdir "$STEP3_PARALLEL_WORK" \
  --plugins "$STEP3_PARALLEL_INPUT/plugin-packages" \
  --host-deps "$STEP3_PARALLEL_INPUT/agent-host/node_modules" \
  --gomodcache /Volumes/ExternalWork/BuildCache/go-mod
```

**下面的 execute 本轮不运行。示例中的窗口说明不是已经收到通知。** 实际执行只填 Chief 释放本轮采样窗口的真实通知，按一次前台任务运行，不与 prepare 自动串联：

```sh
python3 docs/implementation/evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/capture_once.py execute \
  --workdir "$STEP3_PARALLEL_WORK" \
  --window-released "Chief释放本轮窗口的实际通知原文或时间"
```

执行时先生成两个历史库，再发出唯一的并行命令，不预编译全部测试来改变原来的编译/执行重叠：

```text
go test ./... -count=1 -timeout=25m -mod=readonly -json -exec=<本脚本 _exec 回调>
```

不指定 `-p` 或 `-parallel`。`-json` 和 Python 回调会改变观测开销；bootstrap 进程单独加 `-test.trace`，其他包不生成 trace。bootstrap 原输出直接按字节保存，并同步交给 Go 的 JSON 输出。app 只加上述两个新增 N1 用例的 skip。没有预置单项复跑或按失败自动重试的路径，同一工作目录的 `execute-once.json` 用排他创建阻止再次发起。

新环境使用独立 HOME/TMPDIR/GOTMPDIR/GOCACHE，固定现有 Go 模块缓存，禁用依赖下载和个人 GOENV，不继承真实密钥、业务配置或 `GOFLAGS/GOMAXPROCS`。这些与无法恢复的旧继承环境有差异，必须随结果保留。只复制已有宿主依赖和协议包，不修改原件。

## 四段和 trace 怎么配合判断

阶段位置与上一轮相同：数据库/迁移、NewLocal/插件、内置资源、组合/路由。临时 Open 增加 `runtime/trace` task 与四个 user region，`data_dir` 注记可以找到名字包含 `TestDesktopColdOpenBudgetAndNoIdleOutbound` 的那一次 Open，不能混入其他 bootstrap 用例的 Open。原测试文件、5 秒阈值、Start/Close 和无空闲外发断言完全不改。

计时先读 elapsed，再关闭 region 和输出日志，再开始下一段；阶段和不含全部 trace task/region/日志开销。原总 Open 还包括 `t.TempDir()`，通过日志输出的总毫秒会截断；发生预算失败时从原失败行读取总耗时。带 trace 的通过不能作为无插桩验收通过证明。

后续实际采到 trace 后可离线读取，不自动开浏览器或服务器。Go 1.26.3 的本机工具源码使用 `-d=parsed`，不是旧写法 `-d=1`：

```sh
go tool trace -d=parsed "$STEP3_PARALLEL_WORK/results/bootstrap.trace" > "$STEP3_PARALLEL_WORK/results/trace-parsed.txt"
go tool trace -pprof=sched "$STEP3_PARALLEL_WORK/results/bootstrap.trace" > "$STEP3_PARALLEL_WORK/results/sched.pprof"
```

应先按 task/region 找到冷启动四段的时间窗口，再看对应 goroutine 在 Runnable 等待、Running、阻塞/系统调用之间的转换。整个包的 scheduler profile 只能提示线索，不能直接归因到某个 Open 阶段。

- 若目标段变长且该段记录了明显 Runnable 等待，可以确认 Go 调度等待贡献了多少时间；仍不能只凭相关性断定是哪一个并发包造成。
- 若该段的 Running 墙钟变长而 Runnable 等待不明显，不能直接说计算工作增加。Go trace 不充分覆盖操作系统把正在运行的线程换出的时间，也不提供这一次阶段的精确 CPU 指令成本；需要另有 CPU/系统调度证据才可进一步区分，本次停在“该段耗时增加，原因未定”。
- 若未复现、trace 缺失/损坏、冷启动实例无法唯一定位、阶段不完整，或工具环境在准备后变化，就如实记录观测不足，不自动补跑、不改产品和阈值。

## 后续结束和证据交付

实际捕获结束后先核测试/编译及 Node 子进程，立即向 Chief 报告结束时间、退出码和残留情况，让 #95 知道窗口已释放，再整理长报告。保留原 suite 输出、bootstrap 原字节输出和二进制 trace、每个回调的参数/PID、Go 版本/环境、包和测试事件以及前后负载。用例失败仍保存材料，不以驱动退出或目录名推断通过。

复制结果到本目录的新结果子目录后，推送并从固定提交核文件、字节和哈希，再清理本任务临时副本、缓存和测试数据；不清理既有协议包、共享依赖、其他任务或正式客户端。本轮只有源码生成和静态核查，Go 格式解析、编译、真实 trace 读取和实际并发行为均未验证，不能写成已经跑通。
