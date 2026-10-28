# 单次并行捕获结果

唯一一次并行命令已完成，退出 1。冷启动 Open **5.089262542 秒**超过原 5 秒，主 goroutine 的 Go Runnable 等待合计仅 **1.539328 毫秒**。NewLocal/插件阶段约 3.686 秒，但现有 trace 不能区分其 Running 墙钟中的真实 CPU 工作和 OS 线程调度等成本；旧 5.588 秒失败的原因仍未定。

## 实际执行

- 材料固定 `65a38475c8a904f6c507e9d6706dd3b54fffb612`，产品固定 `30ed8d92910fe928b84cf918d870b8d600923144`。`capture_once.py` 的执行字节未改，trace 仅改临时 Open，原预算和外发断言不变。
- Chief 本轮明确允许执行并撤销只准备限制。只有一次 execute、一次并行 suite；原历史库输入准备两次 `go run` 均退出 0，没有单独重跑专项或人为施压。
- Go 1.26.3 darwin/arm64。suite 北京时间 16:06:58.994–16:26:17.971，约 19 分 19 秒；suite 与 execute 均退出 1。
- 实际 69 包：58 pass、8 fail、3 无测试。app 实际 argv 含两个新增 N1 的 skip，日志无这两项 RUN。
- 结束后的首次 ps 解码失败，不能算核查成功；16:27:34 重新按原始字节核任务路径、进程组及所有记录 PID，确认测试/Go/exec/Node 无残留，并向 Chief 更正通知、释放窗口。没有重跑测试或启动客户端。

## 阶段与调度

| 阶段 | 原计时（毫秒） | 主 goroutine Runnable（毫秒） | Syscall（毫秒） | Running（毫秒） |
| --- | ---: | ---: | ---: | ---: |
| 数据库与迁移 | 461.182 | 0.190 | 434.443 | 26.526 |
| NewLocal 与插件 | 3686.161 | 1.118 | 887.990 | 2796.995 |
| 内置资源 | 899.257 | 0.223 | 873.524 | 25.512 |
| 组合与路由 | 42.514 | 0.009 | 11.577 | 30.929 |

唯一目标为 task 48、goroutine 15956。四段 log 与 trace 对应，逐阶段独立积分与全局区间裁剪相同，无状态缺口。完整纳秒与 Waiting 时间见 `cold-state-analysis.json`，独立核对见 `verified-observation.json`。原计时和 region 边界有微秒级观测差异，不能直接当作产品开销。

Runnable 等待约占四段的 0.030%，不足以解释本次超时的大头。Running 不是 CPU profile，Syscall 不是磁盘争用证明。trace 起始 GOMAXPROCS 为 10，不代表旧 `-p` 已恢复。时钟映射显示冷启动约在 16:13:29.749–16:13:34.838，包事件窗口覆盖 app、bootstrap、handler、operations、plugins；JSON 窗口不是 OS 调度证据。

## 材料缺口必须保留

脚本冻结了 86 个包供运行时读取，但源码副本 `plugin-packages/` 没有物化归档。直接读取相对源码路径的 protocol/app 单测因此失败或数量不符，部分并行背景改变。原脚本保留作为本次输入证据，不在运行中修补，没有第二次捕获。

其余失败还包括 CLI 被终止、宿主就绪超时、代理断言、重启夹具未运行、DNS 截止时间断言。本轮只保留具体输出，不扩展定位，不将它们自动归为产品回归或机器负载。全部失败事件见 `failure-evidence.json`，包结果见 `actual-suite-summary.json`。

旧工具链、有效 `-p`、物化包归档、TMPDIR 和并发时间线等不可恢复；候选版本、隔离环境和诊断开销也不同。因此这是本次条件下的超时观测，不能声称旧 850 同因复现、无插桩验收通过或全套通过。后续如继续验证，应先补齐测试资源路径，再由 Chief 决定是否需要 CPU/OS 调度证据，本次不追加尝试。

## 文件索引与复算

| 文件 | 证据 |
| --- | --- |
| `prepared.json`、`execute-once.json`、`driver-*.json/txt` | 固定输入、唯一执行通知、真实命令及驱动退出 |
| `fixture-*.json/txt`、`go-version.*`、`go-env.*` | 历史库准备与实际工具版本 |
| `parallel-suite.json/txt` | 唯一并行命令及完整原始 JSON 事件流，不是摘要 |
| `exec-*.json` | 各测试二进制实际参数/PID，含 app skip 和 bootstrap trace 参数 |
| `bootstrap-raw.txt`、`bootstrap-claimed.json` | bootstrap 原字节输出与唯一回调记录 |
| `bootstrap.trace.gz` | 原始 56,322,005 字节二进制 trace 的无损压缩，原 SHA-256 为 `32fe5232b7261e8827761d25f2e23bdf0ee5d15f8ce1ce7ceac12ca437b1bf45` |
| `cold-selected-events.txt.gz` | 完整解码输出中目标 goroutine/task 的原字节事件及堆栈子集，明确不是完整展开输出 |
| `cold-state-analysis.json`、`cold-state-transitions.json` | 目标实例、region、主 goroutine 状态积分和转换 |
| `verified-observation.json` | 独立积分、原输出/trace 一致性和原阈值核查 |
| `clock-and-package-overlap.json` | trace Sync、起始 GOMAXPROCS 原事件及新包时间窗 |
| `compiled-inputs.json` | 实际 1,673 个后台文件指纹，唯一差异为临时 runtime 诊断 |
| `actual-suite-summary.json`、`package-test-events.json`、`failure-evidence.json` | 实际包/测试事件与失败上下文；failure 包含子项，不能当作顶层测试数 |
| `before-*`、`after-*`、`monitor-*` | 前后及持续监控的负载/进程/内存/磁盘 |
| `processes-after-verification.json` | 实际完成的无残留核查和第一次解码失败说明 |
| `trace-decode.json/txt`、`trace-decode-stderr.txt` | 解码命令、版本来源、退出与完整派生输出的哈希；没有名为 `trace-decode.txt` 的全量文本文件 |
| `artifact-storage.json` | 无损压缩的原长度/哈希与实际存储长度/哈希 |
| `delivery-manifest.json` | 固定提交树核对用清单；不含清单自身 |

完整展开约 9.9 GB，临时 gzip 为 351 MB，是原始 trace 的可复算派生物，不提交该大文件；提交原始二进制 trace、选定事件子集、完整展开哈希与分析脚本。gzip 不是重新编码 trace，解压后逐字节相同。原 `.txt` 禁止换行转换，保留 CRLF、颜色和 test2json 控制字节。

在独立目录解压原 trace 后，可按记录的同一 Go 1.26.3 工具命令生成完整展开，再用 [analyze_capture.py](../analyze_capture.py) 读取 gzip 展开；脚本本身不运行 Go 或测试：

```sh
gzip -dc bootstrap.trace.gz > bootstrap.trace
go tool trace -d=parsed bootstrap.trace | gzip > trace-parsed.txt.gz
python3 ../analyze_capture.py --decoded trace-parsed.txt.gz --output analysis
```

若只核已保存的目标事件，可以读取 `cold-selected-events.txt.gz`，但不能把它替代全部原始 trace 来检验目标唯一性。本次已用全量展开确认唯一。正式证据在分支中保留，固定 Git 树复核成功后清理任务临时源码、缓存、数据和大派生文件；不清理原协议包或共享依赖。
