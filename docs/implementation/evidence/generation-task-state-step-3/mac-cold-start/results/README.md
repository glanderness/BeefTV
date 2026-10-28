# Mac 冷启动最小对照实测

四次预编译及八次固定单项全部结束且通过。产品后台保持 `30ed8d92910fe928b84cf918d870b8d600923144`，旧 Mac 并行全套 5.588 秒失败的原因仍未定。详细判断、四阶段表和下一项建议见 [实施说明第 11 节](../../../../generation-task-state-step-3.md#11-mac-固定条件最小对照结果)。

## 固定输入与运行方式

- A：`6a155448096d2425aa07e81cc6016410091ad0be`；B：`30ed8d92910fe928b84cf918d870b8d600923144`。
- 只运行 `TestDesktopColdOpenBudgetAndNoIdleOutbound`，原 5 秒预算和空闲外发为 0 的断言不变。原版 A-B-B-A 后运行诊断版 A-B-B-A，没有全套、重跑或人工施压。
- 四次编译均使用 `go test -mod=readonly -c ... ./internal/bootstrap`，完成后才开始采样。Go 1.26.3 darwin/arm64、M4、10 核、24 GiB，macOS 26.6.2。实际环境及 86 个冻结包哈希见 [environment.json](environment.json)。
- 源码、测试数据、构建缓存和 Go 临时目录均在本任务 ExternalWork 目录。关闭依赖下载，保留原物化包及共享依赖；没有启动客户端或真实生成。
- 每次都为新进程和新工作区，没有清空系统缓存；数据位置不一定与旧全套相同。编译后的系统负载也未被证明为空闲，不能称完整重演旧现场。

## 逐次结果

| 组 | 顺序 | 版本 | Open（毫秒） | 空闲外发 | 退出码 |
| --- | ---: | --- | ---: | ---: | ---: |
| 原版 | 1 | A | 3253 | 0 | 0 |
| 原版 | 2 | B | 1303 | 0 | 0 |
| 原版 | 3 | B | 1296 | 0 | 0 |
| 原版 | 4 | A | 1212 | 0 | 0 |
| 诊断 | 1 | A | 1284 | 0 | 0 |
| 诊断 | 2 | B | 1441 | 0 | 0 |
| 诊断 | 3 | B | 1197 | 0 | 0 |
| 诊断 | 4 | A | 1288 | 0 | 0 |

独立逐名读回见 [verified-results.json](verified-results.json)：每份日志恰好一条指定测试 RUN/PASS，无 FAIL/SKIP，输出哈希与进程元数据相符。诊断版每次恰好四段，阶段合计及与总 Open 的残差区间另列；总 Open 的毫秒输出会截断，不能直接用显示值推算精确开销。诊断版不替代原版验收。

## 文件索引

| 文件 | 内容 |
| --- | --- |
| `driver-prepare.json/txt` | 准备命令、起止、退出码和原始输出 |
| `driver-execute.json/txt` | 实际执行命令、环境覆盖、起止、PID、退出码和原始输出 |
| `driver-inputs.json` | 脚本哈希、Python 版本、任务目录和已有协议包来源 |
| `prepared.json` | 四套源码的每文件 SHA-256、测试输入和固定顺序 |
| `base-diagnostic.patch`、`candidate-diagnostic.patch` | 两侧相同且与原材料一致的四段诊断补丁 |
| `build-*.json/txt` | 四次预编译的进程记录、二进制哈希与原始输出 |
| `original-[1-4]-*.json/txt` | 四次未插桩的原用例 |
| `diagnostic-[1-4]-*.json/txt` | 四次诊断副本运行原用例的输出 |
| `*-before/after-{uptime,processes,memory,disk}.txt` | 每次编译/用例前后的 96 份负载快照，命令、起止和退出码在对应进程 JSON 中 |
| `summary.json` | 驱动生成的顺序、观测及输入未变检查 |
| `verified-results.json` | 独立从原始日志核对的用例、退出、计时及输入结论 |
| `processes-after-tests.txt` | 测试完成后的进程核查，本任务编译/测试无残留 |
| `delivery-manifest.json` | 交付文件的预期字节数、SHA-256、Git blob，以及从 740 保留的文件记录；不包含清单自身 |

`.txt` 使用 `-text -eol`，保留原始 CRLF 和颜色码。四套测试二进制和临时数据库不提交。先核对本目录副本与原件，再推送并从固定 Git 树核查；固定树核查通过后清理本任务临时目录。原协议包、共享依赖、其他任务和正式客户端不清理。

测试于北京时间 15:20:43 结束，已立即通知 Chief 释放 #95 窗口，此后只整理文档，不运行 Go。未合入、未发布、未自行派评审。
