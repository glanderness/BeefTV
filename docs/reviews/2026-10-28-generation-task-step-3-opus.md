# 生成任务第 3 步独立复查（Opus）

结论：**候选不能按现状进入第 3 步完成或合入。** 有 1 个会影响所有已有用户的数据库升级回归（旧库升级后 API 日志写不进去、失败任务的结论全部变成“读不到”、普通失败图片无法重新生成），以及 3 个让带操作编号的 `/retry` 无法使用或无法重放的问题。四项都已在隔离 SQLite 上实际复现，需要交回 #88 新执行会话修正。另有几处与 #86 第 3.11 节约定不一致、目前只经代码阅读确认的问题，列在后面。

## 1. 固定输入

| 项目 | 值 |
| --- | --- |
| 候选 | `6d4d13735569751a98126052055021a8a04549dd`（分支 `tds/conv-01a18064-1402-7d75-9399-bb10bb3d06d2`） |
| 比较基线 | `6a155448096d2425aa07e81cc6016410091ad0be`（主线） |
| 行为约定 | #86 `bffc87f54625406ccb7b778e088e01d1e5165f01` `docs/architecture/generation-task-state.md` 第 3.2、3.6、3.11 节 |
| 研究输入 | #83 `4b84a40d52e7f7da97397349adbb11a1bf7ff42b`（只作为反例线索，未复制实验补丁） |
| 复查模型 | 本会话运行在 `claude-opus-5-5`。平台把它作为用户指定的 OpenClaw「Mem云端·Claude Pro官方OAuth」配置派发；运行配置 ID 本会话无法自行读回核对。 |

`cf22847c` 在本机仓库中取不到对象，没有逐字节复核“候选与原实现一致”；本复查直接以 `6d4d1373` 相对基线的实际 diff 为对象。

## 2. 实际做了什么

- 逐行阅读候选相对基线的全部后台 diff（约 1,100 行，30 个源码/测试文件），对照第 3.11 节逐条核对。
- 编写 5 个复查测试，在团队 Mac（`sunnydeMac-mini-2.local`）的 `/tmp/s3rev-opus` 隔离目录里运行。全部使用临时 SQLite、`t.TempDir()` 数据目录、假凭据，没有上游请求，没有碰用户数据目录或正在运行的客户端。本工作区是 Linux 且无 C 编译器，SQLite 测试只能放到 Mac 上跑。
- 旧库夹具：用**基线代码**（`6a155448`）的 `MigrateLocalSchema` 建出 v26 数据库，再用**候选代码**升级。这是真实用户从 v2.0.5 升级时会走的路径。
- 一项探针用了临时补丁（`tests/probe_store_patch.go.txt`），只是为了越过问题 P1，观察下一层行为；它**不是**建议的修法，也没有进入任何分支。
- 没有重跑作者的全套测试，没有做桌面客户端、Windows、真实 BeefAPI 或付费验证。

证据目录：[`2026-10-28-generation-task-step-3-opus/`](2026-10-28-generation-task-step-3-opus/)。原始测试输出改用 `.txt` 后缀保存（仓库 `.gitignore` 会忽略 `*.log`）。取回本机时四份文件的 SHA-256 都与 Mac 原件一致；之后经工作区同步进入提交，含终端颜色码的 `review-tests.txt` 和 `mkv26.txt` 字节有变化，提交内的哈希与原件不再相同（见下表“提交内”一列）。Mac 原件已随临时目录删除，无法逐字节找回。两份文件里的测试名、失败行和错误文字与当时屏幕输出一致，结论不受影响；需要严格的原始证据时，可按下面的复现方法重跑。

| 文件 | 内容 | Mac 原件 SHA-256 | 提交内 SHA-256 |
| --- | --- | --- | --- |
| `review-tests.txt` | P1–P4 首轮输出 | `8913c496310f6b13eb29c135bfb2d5825535fbbcb3b721ea8f3a4bec99ddd49c` | `e1307b003feb7339644d0b08bd3214c017b4d61a9a71ec7b7a50f8895b1c3025`（不同） |
| `review-upgrade-retry.txt` | P2 补充：升级库上普通失败图片重试 | `26ceb98197f56cfc0856d8b0d7385e2beef19c36e98cbee45048fcfe886dd11f` | 相同 |
| `review-probe-paid.txt` | 探针补丁下的同编号重放 | `a76bbbf7493915bc93bd428e9021444a7c0c0f89ce2fab3505e2ae1f98b5369e` | 相同 |
| `mkv26.txt` | 基线建 v26 库的输出（只有一条“默认工作区不存在”的查询日志，退出码 0） | `f38b73cebb7090f34e72a0dd40d9356fae221b9cd7237aa1575e015c93c3b338` | `3da101f12087730f4451a5fa9afd99555275fa25f74a693bff560b9a75cc9eca`（不同） |
| `tests/*.go.txt` | 复查测试源码、建库程序、探针补丁 | 与取回时一致 | 相同 |

复现方法：把 `tests/review_opus_step3_*_test.go.txt` 去掉 `.txt` 放进候选的 `backend/internal/app` 或 `internal/handler`；用基线代码运行 `tests/mkv26_main.go.txt` 生成 v26 库；然后执行 `REVIEW_V26_DB=<v26.db> go test ./internal/handler ./internal/app -run TestReview -count=1 -v`（需要 cgo）。

## 3. 需要 #88 修正的问题（已实测）

### P2（最严重）旧数据库升级到 v27 后，API 日志写入失败，任务结论全部读不到

- 位置：`backend/internal/model/models_channel.go` 给 `ApiCallLog` 新增 `route_run`、`usage_state`、`billing_state`、`usage_state_present`、`billing_state_present`、`image_job_id` 六列；`backend/internal/database/local_schema.go` 的 v27 迁移只给 `tasks` 加 `billing_evidence`。`api_call_logs` 只在 v1 由 `AutoMigrate` 建表，已有数据库不会再补这些列。
- 实测（`review-tests.txt`，`TestReviewUpgradedV26DatabaseKeepsLogsAndOutcomeReadable`）：基线 v26 库升级后六列全部缺失；`LogAPICall` 报 `table api_call_logs has no column named route_run`；`taskOutcomeFacts` 对失败任务给出 `Unreadable=true`。
- 实测（`review-upgrade-retry.txt`）：升级库上一个没有任何回执的普通失败图片任务，旧客户端式 `/retry`（不带编号）直接失败，返回“图片结果尚未确认，已停止自动重发；请保留任务记录并联系支持查询结果”。原因是 `LatestBeefAPIImageJobIDForTask` 查不存在的 `route_run` 列出错，`imageJobResult` 把这个错误当成“已处理”。基线对同一任务按代码会进入正常重新排队。
- 影响：所有从 v2.0.5 升级的用户。`recordProviderRequest` 忽略 `LogAPICall` 的错误（`_ = service.LogAPICall`），所以生成本身不报错，但创建回执、上游任务号日志、本步新增的扣费原值和图片 job ID 都悄悄丢失；后台图片扫描对每个失败图片每轮都报错，`rejected_no_job` 的“明确没建任务”结论也因此走不到（job 查询位于该判断之前）。
- 作者全套测试为什么没发现：测试都在新建数据库上跑，v1 的 `AutoMigrate` 会带上新列。
- 修正方向：v27（或新增 v28）同时用 `ensureSQLiteColumn` 补齐 `api_call_logs` 六列，并加一条“基线版本库升级后写日志、读结论”的回归。

### P1 带 `clientOperationId` 的付费 `/retry` 一律返回 500“任务服务不可用”

- 位置：`backend/internal/task/lifecycle.go` 用类型断言要求 store 实现 `RetryTaskWithOperation` 和 `RetryOperationResult`；`backend/internal/task/store.go` 的 `repoStore` 只新增了名为 `RetryWithOperation` 的方法，两项都不满足，断言失败后返回 `unavailable()`。
- 实测（`review-tests.txt`，`TestReviewPaidRetryWithOperationIDRequeuesOnceAndReplays`）：`POST /api/tasks/:id/retry` 带 `{"clientOperationId":"op-paid-1"}`，HTTP 500，任务仍是 `failed`、`routeRun=0`，没有写操作回执；不带编号的同一请求在既有测试中能正常排队。
- 当前用户影响：前端 `web/src/services/api/task-center.ts:340` 的 `/retry` 不带请求体，所以现有客户端暂时不受影响；但第 3.11 节 3A“同编号并发、完成后重放、数据库重开后重放”的付费分支实际上完全没有生效。候选的 repository 层测试直接调用 `Repository`，绕开了这一层。

### P1b 修好 P1 后，同编号在成功后重放会被判成“编号冲突”

- 位置：`backend/internal/app/service.go` 的 `retryTask` 用调用时的 `task.RouteRun` 计算 payload hash。付费重跑成功后 `routeRun` 已加 1，客户端因网络丢失响应而用同编号重发时，hash 不同，命中 `ErrRetryOperationConflict`。
- 实测（`review-probe-paid.txt`，仅在探针补丁下运行）：第一次 200、排队、`routeRun=1`、回执 1 条；同编号第二次返回 HTTP 400，正文 `retry operation id reused with a different payload`。
- 这正是第 3.11 节要防的情形（“同编号回读必须先于任务当前状态……命中就返回原接纳身份”）。查回执应该只按用户和编号，然后再比对“原轮次”，不能用当前轮次重新算 hash。
- 顺带：这条英文内部错误原样返回给了调用方，`reason` 是 `invalid_argument`，HTTP 400；不属于 `AppError` 的 `ErrRetryOperationConflict`/`ErrRetryOperationInProgress` 在 app 层没有翻译成冲突错误。

### P3 免费恢复中途进程退出后，同一操作编号永久卡在“正在执行”

- 位置：`service.go` 免费分支先 `BeginRetryOperation` 写 `running`，只有返回错误时才 `AbortRetryOperation`，成功时才 `CompleteRetryOperation`。两者之间进程退出，`running` 记录就一直留着；没有租约、超时或启动时清理。
- 实测（`review-tests.txt`，`TestReviewFreeRecoveryRunningReceiptAfterCrash`）：模拟前一进程领取后退出，新 Service 用同编号调用，返回 `retry operation is already in progress`，回执状态仍是 `running`。
- 与约定的差距：第 3.11 节要求“首次带编号的 `/retry` 在网络恢复前就固定选中的动作”“回执的 succeeded 指本地操作已经接纳”“记录回执后必须确实留下这条可继续的路径”。候选把 `running` 当执行锁、把成功放在网络恢复之后，正是约定否定的做法。

### P4 免费恢复回执不记原轮次；重放返回的是旧快照

- 实测（`review-tests.txt`，`TestReviewFreeRecoveryReceiptRecordsRouteRuns`）：暂停下载的任务 `routeRun=3`，免费恢复回执里 `originalRouteRun=0`、`acceptedRouteRun=3`。`CompleteRetryOperation` 没有传原轮次。
- 代码阅读：回执里直接存整份 `model.Task` 快照，重放时返回这份快照（`RetryOperationResult`），没有按第 3.11 节返回“任务当前投影 + 可选 `retryOperation`”。本次测试里两次调用间任务阶段没变，所以没有观察到快照与当前状态不一致，这一点只是代码阅读结论。

## 4. 与第 3.11 节不一致、只经代码阅读确认的问题

这些没有单独写复现测试。是否必须在第 3 步内修，需要 Chief 按 3A/3B/3C 完成标准判断；我的建议写在每条后面。

1. **自动视频恢复和“结算中继续读取”没有接上。** `repository.FailedVideoTasksForRecovery` 与 `FinishProviderRecoveryWait` 是新增但没有任何调用方的代码；它的查询条件还排除了已写 `recovery_outcome` 的任务。第 3.11 节要求“已写 no_result/unrecoverable 但扣费仍 pending 的任务，继续在既有恢复循环读取扣费结论”。现在视频只在人工 `query-provider` 时恢复。实施说明第 4 节写“视频第三方恢复：已解决”，只对人工查询成立。建议算 3C 未完成。
2. **图片 job 明确失败/过期后永远不下结论。** `imageJobResult` 对 `failed/cancelled/expired` 和下载失败都返回同一种 `imageRecoveryError`；`recoverFailedImage` 遇到这种错误时 `outcome` 为空，只退避重试（最长 15 分钟一次），永不写 `no_result`。约定要求“上游明确终态、原结果确实过期和暂时无法访问要分别处理”。建议在 3C 修。
3. **扣费判断仍然有两份来源。** 投影先读 `tasks.billing_evidence`，没有时回查 `api_call_logs`（`TaskProviderBillingEvidence`）；`captureTaskBillingEvidence` 也是从日志反写任务。约定写明“日志……不能成为第二份扣费判断来源”，并要求按“任务、轮次和该次派发身份”条件更新。候选只按 `route_run` 条件更新，`ReconcileDeadline` 字段从未写入。建议在 3B 修。
4. **扣费映射用了跨渠道白名单。** `task.ComputeOutcome` 对 `usage_state` 和 `billing_state` 用几乎相同的字符串集合（`billing_state=failed` 也算未扣费）；`app.billingEvidenceConfirmsNoCharge` 又另算一遍 `ConfirmedUncharged`。约定要求两者“分别按协议映射，不用一个跨渠道字符串白名单”。有没有实际错判取决于 BeefAPI 真实取值，本次没有真实响应夹具，属于未验证。
5. **`providerBillingStates` 递归扫描整个响应体。** 遇到嵌套对象里同名的 `usage_state` / `billing_state` 时，取哪一个取决于 Go map 遍历顺序（不固定）。只有真实响应里出现嵌套同名字段才会出错；本次没有真实夹具，属于风险提示。
6. **操作回执在三处各读一遍。** `app.retryTask`、`task.retry`、`repository.retryTaskWithOperation` 都调用 `RetryOperationResult` 并各自比对 hash，错误翻译也分散在两层。约定明确要求“不要在 app 和 task 域各读一遍操作回执、各翻译一遍错误”。P1/P1b 都出在这种分散上。这是结构问题，修 P1 时一并收拢最省事。
7. **`freeRetryPath` 与实际分支可能不一致。** 有 job ID 的失败图片在 `freeRetryPath` 里判为免费并先写 `running`；如果 `recoverAcceptedImage` 实际没处理，会落到付费 `RetryWithOperation`，在同一事务里撞上自己刚写的 `running` 记录，返回“正在执行”。目前图片 job ID 只要存在，`recoverAcceptedImage` 都会处理，所以暂时走不到；P1 修好后这个时序需要再看。

## 5. 核对后认为成立的部分

- 图片 job 查询只读取当前 `RouteRun` 的 BeefAPI 创建日志，查询路径固定 GET，pending 时不落入冻结 POST 重放（在新建数据库上）。作者专项测试覆盖了这一点，代码阅读与之一致。
- Gemini Veo 兼容适配器只覆盖 `BuildPoll`，不授权 `BuildCreate`。
- 付费重跑在 `withImmediateTransaction` 里把 `routeRun+1`、入队、回执写在一起，并清空上一轮 `billing_evidence`（P1 修好后才会被用到）。
- `RecoveryUnrecoverable` 不再强制 `confirm`，改为沿用扣费结论，符合约定“不能覆盖退款或结算中的结论”。
- v27 只新增可空列，没有回填或改写旧账本。问题是范围不够（见 P2），不是破坏旧数据。

## 6. 问题归属

| 编号 | 归属 | 理由 |
| --- | --- | --- |
| P2 | #88 必须修，且发布前必须修 | 影响所有升级用户的日志、回执和失败图片重新生成 |
| P1、P1b、P3、P4 | #88 必须修才能算 3A 完成 | 当前前端不带编号，现有用户暂时不受影响；但 3A 验收项实际没有生效 |
| 第 4 节 1、2 | 建议 #88 在 3C 修 | 约定内的完成条件，没有扩大范围 |
| 第 4 节 3、4 | 建议 #88 在 3B 修 | 约定内的完成条件 |
| 第 4 节 5、6、7 | 修 P1 时一并处理即可；5 需要真实响应夹具才能定 | 风险或结构建议 |

以上都在已批准的第 3 步范围内，不需要第 4–7 步的新决定。没有发现需要改变已确认用户结果的分岔。

## 7. 没有验证的范围

- 没有重跑作者的全套测试；冷启动 5.208 秒超时的原因没有调查。
- 没有用真实 BeefAPI 视频 DTO 或图片 `result_url` 响应夹具验证扣费字段解析（候选里也没有这类夹具，第 3.11 节 3B 要求有）。
- 没有测试并发同编号、数据库重开后的付费重放：被 P1/P1b 挡住，修好后需要补测。
- 没有做真实桌面客户端、Windows 或付费生成验证。
- P2 只验证了“基线 v26 → 候选 v27”这一条升级路径，没有测更早版本的数据库。

---

# 第二轮复查：固定候选 `850d89c1`（Opus）

结论：**首轮 P1、P1b、P2、P3、P4 已修好，独立复放全部通过；最新候选在独立 Linux 环境的后台全套测试退出 0。但发现 1 个新的具体行为问题（N1）：上游明确失败且已退款的图片任务，经 `/retry` 永远不能重新生成，每次只会再查一次上游。** N1 属于第 3.11 节已批准行为，建议交回 #88 Sol 执行线修正后再判第 3 步完成。冷启动在 Mac 上全套超时的根因仍未定。

## R2-1. 固定输入与运行环境

| 项目 | 值 |
| --- | --- |
| 候选 | `850d89c109b7e94a356834ee51eedba6dba019fb`（分支 `tds/conv-01a18064-1402-7d75-9399-bb10bb3d06d2`） |
| 对照 | 基线 `6a155448`、首轮审查候选 `6d4d1373`、首轮报告 `977f86e6` |
| 行为约定 | #86 `bffc87f5` 第 3.11 节 |
| 运行机器 | Mem 云端 Linux 工作区 `ws-06gmbh7hyht2k5t0g4bq3fr9k8`（x86_64、8 核、Go 1.27.3、gcc 可用）。**不是团队 Mac**，没有占用 #95 采样时段。 |
| 源码 | `/tmp/s3r/cand` 为 `git archive 850d89c1`；`backend/` 与固定提交逐文件比对无差异；`agent-host/package.json`、`bun.lock` 与提交逐字节一致。`plugin-packages` 由仓库脚本生成协议包文档（`prior-session/plugin-build.txt`）。复查用例放在单独副本 `/tmp/s3r/rev`，与 `cand/backend` 的差别只有 4 个复查测试文件。 |
| 旧库夹具 | v26：基线 `MigrateLocalSchema` 新建（`tests/mkv26_main.go.txt`），schema 26；v27：该 v26 库再经首轮候选 `6d4d1373` 升级，schema 27，`api_call_logs` 缺 6 个新列。与作者 `replay.py` 的生成方式等价，但不是同一份文件。 |
| 费用 | 只用假上游（`httptest`）、临时 SQLite、假凭据；零真实付费，没有碰生产或用户客户端。 |

## R2-2. 中断接续核对

上一轮会话在 13:36（+08）因 8 分钟无输出被平台终止。本轮第一步核对 `/tmp/s3r`，在同一台 Linux 工作区上：

- `prior-session/full-run-1.txt`（05:19:25–05:27:12Z，exit 1）：**运行环境不完整，不能算产品失败**。当时还没生成 `plugin-packages` 文档，插件、协议、管理员渠道等 40 多个用例全部因“官方插件未加载”失败。
- `prior-session/full-run-2.txt`（05:27:52Z 开始）：只写出前 5 个包的结果，没有退出文件；本轮接续时（05:39Z）机器上已无任何 `go test` 进程。**这是随会话一起被终止的未完成运行，没有结果**，不计通过也不计失败。
- `prior-session/r2-targeted.txt`、`r2-image-no-result.txt`（05:22Z）是上一轮已跑完的复查用例输出，下面 R2-4 用本轮重新运行的输出作结论依据，旧文件只作参照保留。
- 以上原件按原字节复制保存（未清洗颜色码），哈希见 `r2/SHA256SUMS`。

## R2-3. 后台全套测试

| 运行 | 时间（UTC） | 退出 | 说明 |
| --- | --- | --- | --- |
| `r2/full3/` | 05:40:06–05:50:05 | 1 | 只有 handler 包中 7 个“真实 Durable 宿主”用例失败，原因是测试机没装 `agent-host` 依赖（`Cannot find package '@earendil-works/pi-coding-agent'`）。作者流程中这一步是 `bun install --frozen-lockfile`。**环境准备缺口，不是产品失败。** 其余包通过，含 bootstrap 冷启动。 |
| `r2/full4/` | 05:50:33–06:00:41 | **0** | 按锁文件安装依赖（`r2/agent-host-bun-install.txt`，锁文件未变）后重跑。命令与作者相同：`go test ./... -count=1 -timeout=25m`，带 `REVIEW_V26_DB`/`REVIEW_V27_DB`。66 个包全部 `ok`，包括 `internal/bootstrap`（含 `TestDesktopColdOpenBudgetAndNoIdleOutbound`，5 秒预算未改）、`internal/app`（595 秒）、`internal/handler`。 |

关于冷启动：

- 能独立确认的：在这台 8 核 Linux 上，同一固定候选的完整并行全套通过，冷启动没有超过 5 秒。
- 不能确认的：作者在 Mac 上最新全套 exit 1（Open 5.588 秒）的原因。本轮没有在 Mac 上复跑（按分工不占 #95 采样时段），没有逐次记录 Linux 上的 Open 毫秒数（非 `-v` 运行），也没有做基线与候选同条件的 A/B。
- 相关历史（只是线索，不是归因）：基线所在主线已多次在并行全套中出现同一用例超时，例如 `docs/refactor/progress.md` 记 5.295 秒、`docs/refactor/agent-media-harness-integration.md` 记 5.064 秒、`docs/release-evidence/v2.0.5-free-acceptance/verification.txt` 记 10.26 秒，单项复跑都在 1 秒左右。本轮候选未改冷启动用例和 bootstrap 代码，新增迁移 v27/v28 只是加列。这些让“#88 引入冷启动回归”的可能性偏低，但没有同条件对照，不能下结论。
- 影响判断：按项目要求，Mac 上最新全套仍是 exit 1，不能写成“全套通过”；能写的是“独立 Linux 环境全套通过一次”。要关掉这个缺口，需要在 Mac 空闲时段对基线和候选各跑若干次完整全套并记录 Open 毫秒数，由 Chief 安排。

## R2-4. 首轮问题复放（`r2/targeted/review-r2.txt`）

命令见 `r2/targeted/command.txt`：`go test ./internal/app ./internal/handler -run ^TestOpusR -count=1 -timeout=10m -v`，06:00:51–06:00:59Z，整体 exit 1（只因 N1）。复查用例源码在 `r2/tests/`。首轮四个文件的改动只有函数改名，以及 P3 用例里把已删除的 `BeginRetryOperation` 换成插入等价的 `running` 回执行；没有使用首轮的探针补丁。

| 首轮问题 | 本轮用例 | 结果 |
| --- | --- | --- |
| P2 v26 升级后日志列缺失、结论读不到 | `TestOpusR1UpgradedV26DatabaseKeepsLogsAndOutcomeReadable`、`TestOpusR1UpgradedDatabaseLegacyImageRetry` | 通过：升级后写日志成功、失败任务结论可读、不带编号的旧式图片 `/retry` 正常重新排队 |
| P2 补充：首轮候选写出的 v27 库再升级 | `TestOpusR2UpgradeFromCandidateV27` | 通过：升到 v28，日志可写、结论可读；首轮候选格式的旧快照回执能重放且不重新排队；旧式图片 `/retry` 正常排队 |
| P1 带编号付费 `/retry` 500 | `TestOpusR1PaidRetryWithOperationIDRequeuesOnceAndReplays`（公开 HTTP 入口） | 通过 |
| P1b 成功后同编号重放判冲突 | 同上用例的重放部分 | 通过：返回原接纳，不再入队 |
| 同编号并发 | `TestOpusR2ConcurrentSameOperationRequeuesOnce` | 通过：12 个并发调用全部拿到同一接纳（原轮次 2 → 接纳轮次 3），只入队一轮、回执 1 条 |
| P3 免费恢复中途退出卡在 running | `TestOpusR1FreeRecoveryRunningReceiptAfterCrash` | 通过 |
| P4 回执丢原轮次 | `TestOpusR1FreeRecoveryReceiptRecordsRouteRuns` | 通过 |
| P4 旧快照回放 / 后续轮次与重开 | `TestOpusR2FreeReceiptReplayAfterNewRunAndReopen` | 通过：免费回执在任务进入下一付费轮、数据库重开后重放，返回原身份（6/6）和当前投影（queued、轮次 7），不再接纳；同编号用于另一任务返回中文 409，另一任务未被入队 |
| 首轮第 4 节 3：扣费原值缺 `reconcile_deadline` | `TestOpusR2VideoDTOReconcileDeadlinePersisted` | 通过：视频 DTO `code/data` 信封里的 `usage_state=pending` 和 `reconcile_deadline` 原值都存进任务 |

另经代码阅读确认：首轮第 4 节 1（自动视频扫描）、2（图片明确终态）、3（日志第二来源）、5（递归扫描同名字段）、6（三处读回执）已按作者第 8 节说明改动；作者对这些项有先红后绿用例，本轮没有逐项独立复放，只确认图片后台扫描对已写结论的任务只在扣费仍 `pending` 时继续读取（`repository/image_recovery.go` 的 `FailedImagesForRecovery`）。

## R2-5. 新问题

### N1 上游明确失败且已退款的图片，经 `/retry` 永远不能重新生成

- 直接复现（`r2/targeted/review-r2.txt`，`TestOpusR2ImageNoResultRetryCanRequeue`）：一张有 BeefAPI 图片 job 号的失败图片，上游返回 `status=failed`、`billing_state=refunded`。免费恢复后任务写入 `recovery_outcome=no_result`，`outcome.regenerate=allowed`（即界面告诉用户可以重新生成）。之后：
  - 不带编号的 `/retry`：无报错，任务仍是 `failed`、轮次仍是 4，又向上游查询了 1 次；
  - 带新编号的 `/retry`：被接纳成 `free_recovery`（4/4），任务仍是 `failed`，又查询 1 次上游；
  - 对照组：同样的失败图片但没有 job 号，`/retry` 正常重新排队。
- 原因（代码阅读）：`backend/internal/app/service.go` 的 `freeRetryPath` 对视频要求 `RecoveryOutcome` 为空才走免费取回，图片分支没有这项判断——只要有 job 号或 2xx 创建回执，就永远走免费取回；`recoverAcceptedImageContext` 同样不看已有结论。
- 与约定的差距：第 3.11 节第 3 条“持有上游 ID 也不等于永远只能取回：已有明确 `no_result/unrecoverable` 时按扣费事实处理，不再盲目重复查询”；第 5.1 节第 8 条“没有永久锁死的分支”。
- 实际影响（代码阅读，未做界面验证）：任务中心的“重试”（`web/src/pages/tasks/index.tsx` → `retryGenerationTask`）和外部 MCP/CLI 的 `/retry` 对这类图片点了没反应、只重复查上游。画布图片节点的“重新生成”走新建任务（`use-canvas-generation-retry.ts` → `runBackendCanvasGenerationTask`），不经过 `/retry`，不受影响。没有多扣费风险，问题是用户被锁住且结论与按钮不一致。
- 修正交 #88 Sol 执行线；本复查不提供补丁。已有 `unrecoverable`（410 过期）的图片按同一代码路径应有相同表现，本轮没有单独复放。

### 次要观察（不阻断）

- 首轮候选格式的旧快照回执重放时，返回体里的 `retryOperation` 是空动作、轮次 0/0（`TestOpusR2UpgradeFromCandidateV27` 日志）。作者第 8.2 节已说明旧回执不猜历史轮次；空 `action` 是否应省略整个 `retryOperation`，由 Chief 判断，旧前端会忽略此字段。

## R2-6. 本轮能确认 / 不能确认

能确认：首轮五个已实测问题都修好；同编号并发、成功后重放、重开后重放、跨轮次重放、免费接纳后中断都不产生新生成，回执轮次正确；v26 和首轮 v27 旧库都能升到 v28；视频扣费原值含截止时间被保存；独立 Linux 全套 exit 0。

不能确认 / 未测：Mac 全套冷启动超时的根因；Mac 上的全套是否会再次通过；更早于 v26 的真实用户数据库（只有作者的历史布局夹具）；真实 BeefAPI 响应（只用了按字段构造的假上游）；真实桌面客户端、Windows、真实进程强杀、付费生成；N1 的 `unrecoverable` 变体和界面表现。

推翻条件：若 Chief 认定任务中心/MCP 对 `no_result` 图片不应提供 `/retry` 重新生成（例如只允许新建任务），N1 降为文案/结论一致性问题；若同条件 A/B 显示候选在 Mac 上冷启动显著慢于基线，冷启动应改判为本步回归。

证据目录：`2026-10-28-generation-task-step-3-opus/r2/`，`SHA256SUMS` 为提交前的本机原件哈希；该目录用 `.gitattributes` 关闭文本转换，保持原字节。

## R2-7. 补测：过期图片（N1 `unrecoverable`）与冷启动 15+15 对照

本节补交 R2-6 发出后在同一台 8 核 Linux 上完成的两项补测，固定源码不变（候选 `850d89c1`，基线 `6a155448`）。原始输出在 `r2/followup/`，用例源码在 `r2/tests/opus_r2_n1_unrecoverable_test.go.txt`。上面 R2-5、R2-6 保留原文，下面的结论覆盖其中“N1 `unrecoverable` 变体未复放”和“没有同条件 A/B”两句。

### 过期图片（`r2/followup/n1-unrecoverable/`）

- 运行 06:05:11–06:05:19Z，exit 1；两个用例都按预期失败，失败就是问题复现。`command.txt` 是交付时补写的命令（暂存区没留下原文件），输出头尾可对照。
- `TestOpusR2ImageUnrecoverableRetryCanRequeue`：有 job 号的图片，上游查询返回过期（410）。免费恢复后写入 `recovery_outcome=unrecoverable`，`outcome.regenerate` 在已退款时是 `allowed`，扣费时是 `confirm`。之后：
  - 不带编号的 `/retry`：无报错，任务仍是 `failed`、轮次 4，又查了 1 次上游；
  - 带新编号的 `/retry`：被接纳成 `free_recovery`（4/4），任务不变，又查了 1 次上游。
  - 已退款和已扣费两种情况表现相同。
- 同一次运行里 `TestOpusR2ImageNoResultRetryCanRequeue` 再次失败，结果与 R2-4/R2-5 相同。
- 结论：N1 同样出现在 `unrecoverable`（过期）情况，修正范围应同时覆盖 `no_result` 和 `unrecoverable`。没有多扣费，影响仍是任务中心和 MCP/CLI 的 `/retry` 会把用户锁住。界面表现未测。

### 冷启动对照（`r2/followup/cold-ab/`）

- `attempt1-base-env-gap/`（06:04:34–06:05:00Z，基线和候选交替各 10 次）：基线 10 次全部失败，原因是 `未找到官方插件目录 plugin-packages；请设置 CANVAS_OFFICIAL_PLUGIN_DIR`（基线只检出了 `backend/`），属于环境缺口，**不能用作对照**；候选 10 次都通过。原件保留，只作记录。
- `run/`（06:06:19–06:06:48Z，`run2.sh`）：两边使用同一官方插件目录，各自预编译测试二进制，交替单项运行 `TestDesktopColdOpenBudgetAndNoIdleOutbound` 各 15 次，5 秒预算未改。

| 版本 | 次数 | 通过 | `local_open_ms` 平均 | 最小 | 最大 |
| --- | --- | --- | --- | --- | --- |
| 基线 `6a155448` | 15 | 15 | 245 | 193 | 295 |
| 候选 `850d89c1` | 15 | 15 | 249 | 207 | 292 |

- 能确认：Linux 上单项冷启动在基线和候选之间没有可见差异，都远低于 5 秒。
- 不能确认：这是单项交替运行，不是并行全套；Mac 上全套 5.588 秒的根因仍未查明，Mac 上没有做对照。对照结果让“候选让冷启动本身变慢”的可能性更低，但 Mac 全套 exit 1 的记录仍然有效，不能写成“全套通过”。

### 本节证据核对

`r2/SHA256SUMS` 已按本次提交前的工作区原件重算。除补写的 `followup/n1-unrecoverable/command.txt` 外，其余文件与云端暂存清单 `SHA256SUMS.new` 一致；`attempt1-base-env-gap/exit.txt` 是暂存清单漏列的原件，一并提交。测试二进制没有提交。

## R3. N1 修正候选 `30ed8d92` 核验

固定候选 `30ed8d92910fe928b84cf918d870b8d600923144`（#88 分支 `tds/conv-01a18064-…`），对照未改的 `850d89c1`。同一台 8 核 Linux、Go 1.27.3，复用已有官方协议目录 `/tmp/s3r/basefull/plugin-packages`（只读）。全部是假上游、临时 SQLite、假密钥，零付费调用；没有动 Mac、没有跑全套、没有改候选代码或断言。原始输出在 `r3/`，校验和见 `r3/SHA256SUMS`。

### 先核对输入

- 候选生产改动只有 `image_submission.go`（新增 `imageRecoveryAllowsRetry`）和 `service.go`（免费分支先看它）两处，共 14 行，和第 9.2 节描述一致。放行条件是：图片任务、已失败、恢复结论是 `no_result` 或 `unrecoverable`、并且同一个 `ComputeOutcome` 算出 `regenerate=allowed`。
- 脚本叠加的两份原用例 `opus_r2_test.go.txt`、`opus_r2_n1_unrecoverable_test.go.txt` 与本报告 `r2/tests/` 原件 SHA-256 相同，没有被改。
- 脚本自己的检查偏松：先红只认 `NoResult` 一项失败，绿灯只看出现过 `=== RUN` 和退出码，空选择或部分选择也可能放过。所以下面每个测试名都是逐条从原始输出里核对的，不只信脚本的成功提示。

### 复放结果（`r3/replay/`，06:39:40–06:40:19Z，脚本退出 0）

| 步骤 | 退出码 | 实际结果 |
| --- | --- | --- |
| 未改 `850d89c1` 跑 N1 四项 | 1（预期） | 两个原 N1 用例失败；新退款用例 6 个子项全失败；未退款用例 6 个子项通过 |
| 候选跑 N1 四项 | 0 | 4 项、20 个子项全部通过 |
| 候选跑相邻 13 项（app 11 + handler 2） | 0 | 13 项全部 PASS，没有缺项 |

850 的失败都落在业务断言上（例如"legacy /retry … did not requeue … upstream re-queried 1 times"，"new operation id … admitted as free_recovery"），不是编译失败、缺插件或夹具前置条件，所以算原反例的真红灯。

按实际场景区分（更正 R2-7 的写法）：

- R2-7 里写的"过期（410）"不准确：原用例上游实际返回 HTTP 200、`status=expired`；其中"扣费"一支用的是 `billing_state=charged`，这是未知值，只证明它停在 `confirm`，不等于正式 `settled`。
- 本轮新用例真正覆盖了：`status=failed`+退款、`status=expired`+退款且带已接受的提交记录、结果端点 HTTP 410+退款且带已接受的提交记录。三种情况不带编号和带新编号都重新排队到第 5 轮，新编号重放只接纳一次，原免费编号前后都还是 `free_recovery` 4/4，重试不再查旧 job、不向上游提交。
- 未退款：正式 `settled`（停在 `confirm`）、`billing_state` 为空（`blocked`）、缺键（`confirm`）三种，不带编号和带新编号都不排队、不提交。

### 独立补充检查（`r3/probe/`）

脚本没有覆盖的风险：第 4 轮退款放行以后，第 5 轮再失败时，会不会沿用第 4 轮的退款事实又绕过保护。我写了一个探针用例，从第 4 轮退款重新排队开始，再把第 5 轮改成三种失败：

1. 第 5 轮有已接受的提交、没有恢复结论：`blocked / image_recovery_pending`，不排队；
2. 第 5 轮有 `no_result` 结论、计费未知：`confirm`，不排队；
3. 同上，再把第 4 轮的退款证据原样写回：仍是 `confirm`，不排队（计费证据按轮次过滤）。

三种情况不带编号和带新编号都没有排队、没有向上游提交，退出 0。同时确认重新排队会清空 `recovery_outcome` 和 `billing_evidence`。`probe-attempt1/2-fixture.txt` 是我夹具写错的两次失败（失败原因写成不可重试的 "x"、写 JSON 字段方式不对），与产品无关，原样保留。候选两个改动文件和新用例 `gofmt -l` 无输出。

### 结论

- 候选能编译；N1 先红后绿在 Linux 上成立，相邻 13 项通过，没有发现需要 Sol 修改的编译或行为问题。
- 顺带看到但不属于本轮问题：第 5 轮处于 `blocked`/`confirm` 时，带新编号的 `/retry` 返回无报错但不排队（不带编号时会报"图片结果尚未确认"）。这是候选之前就有的行为，未退款时怎样确认重跑仍属后续步骤，本轮不提修改。
- 没测：Mac 编译和测试、Linux 全套、Mac 冷启动 5.588 秒问题（第 9.4 节仍只是建议）、界面和真实客户端、真实上游。Linux 通过不能代替 Mac 结果，候选也还没有合并或发布。
