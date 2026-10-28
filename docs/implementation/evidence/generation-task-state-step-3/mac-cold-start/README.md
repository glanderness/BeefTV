# Mac 冷启动最小对照材料

状态：已按本任务更新后的 spec 执行。该 spec 明确通知 #95 已释放 Mac 窗口，满足原材料的通知条件。四次串行预编译及八次单项均已结束且通过；原始输出、负载、输入指纹与逐名核查见 [results/README.md](results/README.md)。没有运行全套或客户端，旧 Mac 并行失败原因仍未定。

固定比较对象：基线 `6a155448096d2425aa07e81cc6016410091ad0be`（A）与产品候选 `30ed8d92910fe928b84cf918d870b8d600923144`（B）。产品文件不改；诊断仅写独立归档副本。

## 准备命令

在本任务仓库根目录设置两个任务变量，目标必须为 ExternalWork 上尚不存在的新目录：

```sh
STEP3_COLD_REPO="$PWD"
STEP3_COLD_WORK="$STEP3_COLD_REPO/.local/cache/step3-cold-start-mac"
python3 docs/implementation/evidence/generation-task-state-step-3/mac-cold-start/prepare_and_run.py prepare \
  --repo "$STEP3_COLD_REPO" --workdir "$STEP3_COLD_WORK"
```

`prepare` 仅用 Git 对象生成 A/B 两套原版与两套诊断版，共四个源码副本，记录源码指纹与两份诊断 diff；不调用 `go`。它检查两侧冷启动用例、`runtime.go`、`go.mod`、`go.sum` 逐字节相同，固定使用同一用例和原 5 秒预算。它不新建 Git 分支或 worktree，不改任何正常源码目录。

准备阶段可在临时目录校验后清理，日后收到窗口通知再从相同固定提交重新生成。勿把后续 `execute` 的命令连在本命令后面自动运行。

## 执行命令与约束

以下是复现命令，不是继续执行指令。本轮已经执行完毕，不额外重跑。协议包使用现有、已物化的 `*.beeftv-plugin`；执行时复制到专用冻结目录，两个版本只读同一份字节，不改原协议包目录：

```sh
python3 docs/implementation/evidence/generation-task-state-step-3/mac-cold-start/prepare_and_run.py execute \
  --workdir "$STEP3_COLD_WORK" --plugins "$STEP3_COLD_PLUGINS"
```

- 只在 Mac 执行。先串行预编译四个 `internal/bootstrap` 测试二进制，依赖只读；编译日志独立保存，不计入 Open 耗时。没有全套、客户端构建或实际模型调用。
- 再运行原版 A-B-B-A 四次单项，之后运行诊断版 A-B-B-A 四次单项。每一侧在每组各两次，不额外复跑失败项。每次为新进程及新的隔离 SQLite，两个版本共用同一个 ExternalWork 数据父目录和冻结协议目录。旧目录和失败输出不覆盖。
- 保留原测试的 5 秒预算、启动/关闭及空闲外发为 0 的断言。原版源文件没有插桩；诊断版仍用相同原测试，结果单列，不替代原版验收。
- 子进程不继承 `CANVAS_*`、`BEEFTV_*` 业务配置与本任务列出的团队密钥；脚本设置冻结协议目录及独立 `TMPDIR`，不改用户配置文件。工具链、CPU 数、Go 相关环境、输入哈希、PID、命令、起止、退出码与原始输出哈希记录在 `results/`。
- `STEP3_COLD_PLUGINS` 指向已有物化包目录；当前新工作区只有协议源码，本轮使用上一会话仍在的 86 个包，未重新打包。精确来源、命令和环境覆盖见 `results/driver-inputs.json`、`driver-execute.json`。构建缓存和 Go 临时目录单独放在本任务目录，关闭依赖下载，`-mod=readonly` 保持依赖不变。
- 本轮只补充脚本的观测记录：每个编译/用例进程前后保存 uptime、无命令参数的进程列表、内存和磁盘快照，记录实际 Go 环境、编译二进制哈希，并逐名核查 RUN/PASS。快照采集在被测进程外，四段插桩和原测试没有改动。
- 运行结束逐项检查实际测试名、退出码、`local_open_ms` 和外发为 0 的输出；诊断还须有四个阶段各一条记录。缺项或失败保留原件并返回失败，不自动放宽或重跑。仅返回码 0 不代表解释了旧并行失败。

本对照固定测试数据与协议包在 ExternalWork。旧全套的临时数据位置未完整记录，不能把本次换盘后的单项结果当作旧环境的完全重演。此处“冷启动”沿用原用例，指新进程/新工作区，不宣称清空了操作系统文件缓存。

## 四段时间戳的实际含义

诊断副本在同一 `Open` 入口增加四个边界，单位为纳秒，输出前缀为 `STEP3_COLD_PHASE`；不改逻辑或测试断言。

| 阶段 | 实际范围 |
| --- | --- |
| `database_and_schema` | Open 入口到迁移完成，包括默认配置、数据目录、工作区锁、数据库和连接池 |
| `service_and_plugins` | repository 创建、重启深度任务处理、NewLocal 及插件加载 |
| `builtin_initializers` | initializeService 中运行时验证、模板、工作流、技能和技能包初始化 |
| `composition_and_routes` | provider/workspace/localapp、凭据与宿主对象、HTTP 路由构建，到 Open 返回 |

每段通过 `time.Since` 记录，写时间戳后才开始下一段。原测试的总 Open 计时还包含调用前的 `t.TempDir()`、诊断输出等开销；四段和不要求等于原测试总值。不得把日志开销直接解释成产品退化，也不把原版与诊断版的数值直接当作同一测量。

只有两次样本用于找下一条线索，不能据此声称统计稳定性或定位根因。若 A/B 单项无明显差异，保留“原 Mac 并行全套条件下原因未定”，将阶段数据交 Chief 决定下一项能区分的检查；不自行制造负载、不连续跑全套寻找绿灯。

## 原始材料和清理

`results/` 的 `.gitattributes` 关闭 `.txt` 换行转换。日志由进程直接写二进制文件，保留颜色码和 CRLF；提交结果后从固定 Git 树核对原字节。

准备校验阶段产生的临时源码可以安全清理；实际执行后先保存并核对 results、prepared.json、两份诊断 diff，再清理本任务创建的源码/二进制/隔离数据。不要清理其他任务、正式客户端、共享依赖或原插件目录。尚需后续分析的文件须保留并注明位置。
