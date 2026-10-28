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

### 证据分类

下表把每条结论按证据来源分开。“未改候选”指候选 `6d4d1373` 的产品代码原样不动，只放入复查测试文件；“临时探针补丁”指额外加了 `tests/probe_store_patch.go.txt`，只为越过 P1 观察下一层，不是修法。

| 结论 | 证据来源 | 原始输出 |
| --- | --- | --- |
| P1 带编号付费 `/retry` 返回 500 | 未改候选，直接复现 | `review-tests.txt` 第 1–11 行 |
| P2 升级后 `api_call_logs` 缺六列、写日志失败、结论读不到 | 未改候选，直接复现；旧库路径只覆盖“基线 v26 → 候选 v27” | `review-tests.txt` 第 12–21 行，`mkv26.txt` |
| P2 补充：升级库上普通失败图片 `/retry`（不带编号）被挡住 | 未改候选，直接复现（同一 v26 → v27 库路径） | `review-upgrade-retry.txt` |
| P3 免费恢复中途退出后同编号卡在 `running` | 未改候选，直接复现 | `review-tests.txt` 第 22–32 行 |
| P4 免费恢复回执 `originalRouteRun=0` | 未改候选，直接复现 | `review-tests.txt` 第 33–49 行 |
| P1b 成功后同编号重放判成冲突（HTTP 400） | **仅在临时探针补丁下观察到**；未改候选会先被 P1 挡在 500 | `review-probe-paid.txt` |
| P4 后半（重放返回旧快照而非当前投影） | 代码阅读，未实测 | — |
| 第 4 节 1–7 | 代码阅读，未实测 | — |
| 第 5 节“成立的部分” | 代码阅读，加上作者已有测试的描述；本次未重跑作者测试 | — |

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
- 旧库升级实际只覆盖“基线代码建出的 v26 → 候选 v27”这一条路径；v25 及更早版本的数据库、带真实历史数据的库都没有测。
