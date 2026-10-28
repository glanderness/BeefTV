# 生成任务状态重构：第 3 步实施说明

状态：产品候选保持 `30ed8d92`；既有 Linux 专项及第 11 节八次 Mac 单项通过记录保留。Chief 读回 `65a38475` 后明确撤销先准备限制，本轮已完成唯一一次并行捕获：suite/execute 退出 1，冷启动 Open 5.089262542 秒超过原 5 秒。trace 唯一定位的主 goroutine Runnable 等待仅约 1.539 毫秒，不能作为本次超时的主要解释；Running 与 Syscall 的具体原因仍未确定。材料漏放源码目录物化包也导致旁支失败，不能称旧 850 现场完整复演或全套验收通过。第 1–12 节保留历史状态，最新实际结果见第 13 节。未改产品、未重跑、未合入、未发布、零真实付费。

依据：`docs/architecture/generation-task-state.md` 第 3.1–3.7 节及本任务已确认范围。本文只记录本分支实际完成的后台能力，不把第 4–7 步的报价、用户确认、MCP/CLI 付费守门或前端改动写成已实现。

## 1. 本步边界

本步统一后台已有的失败任务查询、图片免费取回、重新生成入口和扣费投影事实：

- BeefAPI 直接读取响应中的 `usage_state` / `billing_state` 及字段是否存在；不按错误文案或派发状态推断是否收费。
- 第三方渠道没有可核实的扣费结论时，投影为需要用户确认；只有明确未发出或上游已明确失败且有 BeefAPI 未扣费证据时才允许直接重新生成。
- 图片异步任务只查询当前轮次保存的 job ID，下载结果；查询、下载和写回过程中不提交新的生成 POST。
- `/tasks/:id/retry` 接受 `clientOperationId`，同一用户、同一操作 ID、同一任务轮次的重试可回放；不同 payload 或不同轮次不能复用。
- 继续兼容已有 `/retry` 行为：成功但下载暂停、已有图片回执或当前轮次异步 job 可免费恢复时，仍先走免费恢复；这不是新计费状态机，也没有新增 `/recover` 接口。

## 2. 实际改动

| 位置 | 改动 |
| --- | --- |
| `backend/internal/model/models_channel.go`、`app/provider_http_client.go`、`app/provider_call_log.go`、`app/generation_runtime.go`、`generation/ports.go` | API 日志按 `RouteRun` 保存 provider 请求轮次、来源、原始 `usage_state` / `billing_state` 和字段存在性；读取响应头中的 `X-Image-Job-Id` 或 `/images/jobs/{id}` `Location`。字段只保存在后台记录，公共接口不暴露渠道内部字段。 |
| `backend/internal/model/models_task.go`、`repository/analytics.go`、`app/task_outcome.go` | 增加私有 `TaskBillingEvidence`，只接收当前轮次、正式 BeefAPI 日志的证据；旧任务没有任务列时从当前轮次日志兼容读取。任务读投影优先使用持久证据，再按同一轮次回查日志。 |
| `backend/internal/task/outcome.go` | `ComputeOutcome` 直接按 BeefAPI 原值计算 `regenerate`：失败/退款/明确未扣费为 `allowed`，空值或 `pending` 为 `blocked`，已结算/已扣费为 `confirm`；第三方缺少该证据保持 `confirm`。`RecoveryOutcome` 仍只回答结果是否可取回，不代替计费事实。 |
| `backend/internal/app/image_result_recovery.go`、`image_auto_recovery.go`、`repository/analytics.go` | 图片创建回执没有结果时，若当前 `RouteRun` 有 BeefAPI job ID，就查询 `GET /v1/images/jobs/{id}`；处理中保持失败任务等待，不落入冻结 POST 重放；成功后下载并物化图片，失败则保留恢复错误。旧轮次 job ID 不会被使用。查询后把当前轮次的扣费证据写回任务。 |
| `backend/internal/app/provider_task_recovery.go`、`repository/image_recovery.go` | 失败视频/超分按已有 provider request ID 查询，不创建新上游任务。Gemini Veo 在本地声明式包尚未物化时仅使用内置的 query-only `GET /v1beta/{operation}` 适配器；它不提供 `BuildCreate` 权限。缺失的 MiniMax、Ark 等显式官方插件仍 fail closed。 |
| `backend/internal/app/service.go`、`backend/internal/task/lifecycle.go`、`task/store.go`、`repository/local_runtime.go`、`handler/routes.go` | `/retry` 的免费恢复与付费重跑分支统一接入 `AgentOpRecord`。操作回执保存任务轮次和结果；冲突 payload 返回冲突，执行中返回冲突，成功后重放原任务。免费恢复失败会删除临时 `running` 回执，避免瞬时错误永久阻塞同一操作。重试时清除上一轮 `BillingEvidence`。 |
| `backend/internal/database/local_schema.go` 及迁移身份测试 | 追加 v27 `task-billing-evidence`，仅新增可空 `tasks.billing_evidence`，没有回填、默认值或旧 ledger 改写。 |
| `backend/internal/app/*_test.go`、`backend/internal/repository/*_test.go`、`backend/internal/task/outcome_test.go` | 增加扣费原值及字段存在性、图片异步 job 当前轮次 GET/下载零 POST、操作回执冲突/回放/清理、BeefAPI 与第三方 Outcome 分支测试。 |

## 3. 关键规则

### 3.1 扣费投影

- `source=beefapi` 且 `usage_state` 字段存在时，优先直接读取它：`failed`、`refunded`、`not_charged` 等明确未收费值允许重新生成；`pending` 或存在但为空时阻塞；`completed`、`settled`、`charged` 需要确认。
- 没有 `usage_state` 时才看存在的 `billing_state`；图片的 `refunded`、`failed` 或明确未收费值允许，空值阻塞，`settled` / `completed` / `charged` 需要确认。
- 字段缺失不能当作 pending。没有 BeefAPI 扣费字段的图片和所有第三方失败任务，取不回时保持 `confirm`。
- 任务已明确 `not_sent`、`rejected_no_job` 或没有上游请求号时，沿原有事实规则允许重新生成；这不是对第三方收费结果的推断。
- 计费字段按原字符串和存在性保存，不新增本地收费状态机，不根据错误文本猜测退款。

### 3.2 图片异步免费取回

- job ID 只从当前任务、当前 `RouteRun` 的 BeefAPI 图片创建日志取得；旧轮次日志不能让新轮次走恢复。
- 查询路径固定为 `GET /v1/images/jobs/{job_id}`。状态为 queued/pending/running 时返回“仍待查询”的空结果，不走冻结请求 POST；失败/取消/过期写恢复错误；有图片结果时再下载并转换成本地结果。
- job 查询与结果下载都使用原任务上下文，日志带 `task_id`、`routeRun` 和 `requestKind=poll/download`。已有的结果回执、资源入库和画布绑定继续复用旧实现。
- `recoverAcceptedImage`、后台图片扫描和 `/retry` 兼容分支都使用这一条查询优先路径；它们不会因为拿不到图片 job 结果就直接提交新的生成请求。

### 3.3 视频第三方恢复

- 有原 `ProviderRequestID` 的失败视频任务可以沿原协议查询，查询成功后复用已有下载、资源物化和任务投影。
- Gemini Veo 的兼容 fallback 只覆盖查询，使用正确的 Google API key Header 和 `/v1beta/{operation}` 路径；不改变生成入口，也不授权新的创建请求。
- 显式插件缺失的其他官方协议和已删除的自定义协议仍拒绝查询，避免用猜测的协议路径访问上游。

### 3.4 操作幂等

- `/tasks/:id/retry` 的 payload hash 包含操作类型、任务 ID 和调用时的 `routeRun`。同一 `clientOperationId` 跨轮次重用会冲突，而不是被误认为新购买。
- 付费重跑进入任务事务时由 `AgentOpRecord` 唯一记录保护；免费恢复先领取临时回执，成功写入结果，失败回收 `running` 记录。
- 重放返回持久化的原任务快照，不再次排队、不递增 `routeRun`。本步没有实现报价、`quoteId`、真人确认证明或外部客户端付费开关；这些属于后续步骤。

## 4. 验证

所有验证使用本机临时 SQLite、`httptest` 假上游、临时数据目录和假凭据；没有真实账号、真实用户数据库或真实付费生成。

前置：

```text
sh plugin-packages/build-packages.sh
```

该命令只生成本机被 `.gitignore` 忽略的官方协议包，供完整 app 测试加载；没有修改提交内容。

专项和基础包测试：

```text
go test ./internal/database -count=1                         通过
go test ./internal/repository -count=1                       通过
go test ./internal/task -count=1                             通过
go test ./internal/task -run '^TestComputeOutcome$'          通过
go test ./internal/app -run '^TestImageJobResultQueriesCurrentRouteWithoutCreating$' -count=1 通过
go test ./internal/app -run 'TestProviderBillingStates|TestImageJobIDFromHeaders|TestFailedHandwrittenVideoRecoveryQueriesOriginalTaskWithoutCreating|TestFailedThirdPartyVideoRecoveryRenewsOriginalTaskAndMaterializes' -count=1 通过
go test ./internal/repository -run '^TestRetryOperationReceiptIsIdempotentAndAbortable$' -count=1 通过
```

补齐测试依赖：

```text
cd agent-host && bun install --frozen-lockfile 通过
bun 1.4.2；121 个包已安装；未修改 agent-host/package.json 或 bun.lock
```

实际安装日志：`docs/implementation/evidence/generation-task-state-step-3/agent-host-bun-install.txt`。

app 包专项与最终全套中的结果：

```text
go test ./internal/app -run '^TestVideoProtocolUpgradeRecoversOriginalTasks$' -count=1 -timeout=15m 通过（约 6 分钟）
go test ./internal/app -count=1 -timeout=20m                         通过（722.649 秒）
```

`TestVideoProtocolUpgradeRecoversOriginalTasks` 曾在默认 10 分钟的整包运行中尚未轮到结束，因此第一次整包结果是 timeout；当时用 `-skip '^TestVideoProtocolUpgradeRecoversOriginalTasks$'` 只是定位用，不能作为最终全包结论。随后长用例单独通过，app 包完整运行也通过；本次 backend 全套复跑中 `internal/app` 同样通过（882.560 秒）。app 包最终摘要日志保留在 `app-package-final.txt`，专项测试原始日志保留在 `special-tests-rerun.txt`。

handler 7 组真实 host 集成复跑：

```text
go test ./internal/handler -run '^(TestDurableActualHostRestartsAgainstRealGoTurnAndUndo|TestNativeHistoryRealDefaultHostCanvasScopeAndSDKDeterministicFailure|TestNativeHistoryRealDefaultHostRestartsAfterBudgetFailure|TestDefaultDurableHostDispatchesActualNativeMediaBytes|TestFullAccessActualDurableCrossCanvasMoveCrashReplayAndGroupUndo|TestSelectedSkillsActualHostBusinessFlows|TestDurableTimelineDeliveryUsesRealGoWorkerAndCanonicalSubtitleLines)$' -count=1 -timeout=20m -v
通过，7 组全部通过，59.601 秒
```

实际复跑日志：`docs/implementation/evidence/generation-task-state-step-3/handler-real-host-rerun.txt`。日志中的 host 仅使用本机依赖和测试夹具，没有真实上游生成。

backend 全套复跑：

```text
go test ./... -count=1 -timeout=25m
通过，2026-10-27T22:06:00Z–2026-10-27T22:20:46Z，14 分 46 秒
```

实际全套日志：`docs/implementation/evidence/generation-task-state-step-3/backend-go-test-all-rerun.txt`。

第一次补依赖后的全套运行曾因 `TestDesktopColdOpenBudgetAndNoIdleOutbound` 达到 5.208 秒、超过 5 秒预算而失败；根因未定，没有证据足以归因为“机器抖动”。没有改动该测试或放宽预算，立即单独复跑为 1.064 秒并通过，随后第二次 `go test ./...` 全套通过。第一次失败原始日志保留在 `backend-go-test-all.txt`，单测复跑日志保留在 `bootstrap-cold-open-rerun.txt`，均在同一证据目录中。

提交树核对：推送提交 `f936deb453e7e860901594fd67b2ec1d1ea89d0d` 的 `git ls-tree -r --long` 已确认以下 7 个实际日志均进入提交；字节数和 SHA-256 从 `HEAD:<path>` 重新读取核对，而不是用工作区代替：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `agent-host-bun-install.txt` | 324 | `a1b29287819c0a92999f469597cd948f1c1cea1d7fff15dd6cfc98a500d152d2` |
| `app-package-final.txt` | 51 | `3b9779c5c6fc11ae125b8b088e4c1e6ed3bf17611d5ddf27113413e5dc1be062` |
| `special-tests-rerun.txt` | 286 | `6f1dfc7e932ed0e7c1c6143e1b5e946451436269dd3363d492d3cc5189d3eb62` |
| `handler-real-host-rerun.txt` | 5,735 | `ac38214e86d80c06127d34794953bab0c1ed8cfbea062cc874d7376d06da00a6` |
| `bootstrap-cold-open-rerun.txt` | 40,651 | `031016e240bacdd0eae197d3c08cd0affa893f6968a32b87f4e1f73352f60a16` |
| `backend-go-test-all.txt` | 1,850,015 | `d69919a291f5538ee6c891ba964a20e2c9601a1aa4d08c476673b4f29077650c` |
| `backend-go-test-all-rerun.txt` | 4,020 | `a3d8e67ef4dff0d209056f946feb0554a0d2986fd2a7874895c2c4363139b0f8` |

第三方视频恢复问题现状：**已解决**。原任务查询、Gemini Veo query-only fallback、禁止 POST/创建、结果下载及显式缺失插件 fail-closed 断言均通过。

图片异步任务现状：**已实现并有专项假上游验证**。当前轮次 job ID 只触发 `GET /v1/images/jobs/{id}`，随后只下载结果，假上游收到 POST=0；pending 不会落到生成重放，旧轮次 job ID 不会被采用，扣费字段会按当前轮次写入后台证据。

视频扣费现状：**已实现后台事实采集和 Outcome 投影**。视频 provider 响应中的 `usage_state` 会按当前 `RouteRun` 记录；失败、待结算、已扣费分别得到 `allowed`、`blocked`、`confirm` 的投影。第三方渠道没有可核实扣费字段时保持 `confirm`。本步没有实现前端按钮、费用报价或外部调用方确认协议。

## 5. 未测项、未实现与交接边界

- 本轮未做真实 BeefTV、真实第三方或真实付费生成；全部任务恢复和计费断言使用本机假上游、隔离数据和临时 SQLite。
- 未做真实桌面客户端或前端绘制验收；新增的是后台和服务端测试。Windows、web 前端及发布流水线由本轮 `backend/go test ./...` 之外的 CI job 负责，未在本机声称通过。
- 未新增 `/tasks/:id/recover`，未改 MCP/CLI 工具合同，未实现 `paid_confirmation_required`、报价、`quoteId`、用户同意记录、外部付费开关。
- 未新增计费状态转移或渠道退款规则表；BeefAPI 原值是证据，第三方仍交由用户确认。
- 未发布、未开 PR、未合入主线；本分支只作为独立后续实现交付，不回写发布流程，也不扩大到第 4–7 步。

## 6. 回退与风险

- v27 只追加可空列；回退代码不能把已升级数据库降回 v26。若必须回退，使用升级前完整工作区备份和匹配版本程序在独立目录打开。
- 旧任务没有 `billing_evidence` 时，读投影只接受当前轮次、正式 BeefAPI 日志中的扣费字段；日志缺失或字段缺失不会猜测为未扣费。
- 图片 job 查询失败时不会把任务当成已退款，也不会为了“修复”而自动 POST；结果不明仍按既有回执/用户确认规则处理。
- 本轮测试只证明本机假上游和临时数据库中的行为，不证明生产 BeefAPI 的新协议字段、视频生产去重开关或第三方保留期已改变。

## 7. 新会话接续与独立复查交接

### 7.1 固定输入和主线核对

2026-10-28 接续任务 #88 时，通过项目仓库工具重新 fetch `main`，读回 `6a155448096d2425aa07e81cc6016410091ad0be`。它与原候选基线、新会话工作区起点完全一致，没有新增主线差异需要合并或改变已确认行为。

| 输入 | 固定提交 | 本轮处理 |
| --- | --- | --- |
| 原实现及完整证据 | `cf22847c0ae5fff8eba8256dd18347fc3eca3ed2`，原分支 `tds/conv-01a17e9c-c7fd-7f9c-96a2-ae93f8e1ef81` | 重新 fetch 并核对提交；相对基线的 38 个文件完整复制，复制后逐字节一致 |
| 实现主体 | `32df618cf2526fb98917fcee08f683016b6289fa` | 随完整候选保留，不从旧方案或研究补丁重写 |
| #86 修订方案 | `bffc87f54625406ccb7b778e088e01d1e5165f01` | 重新 fetch 并核对提交，读取重构顺序、统筹记录及状态方案 3.11 |
| #83 研究 | `4b84a40d52e7f7da97397349adbb11a1bf7ff42b` | 重新 fetch 并核对提交，读取研究报告、组合行为反例及夹具要求；不复制实验补丁 |

修订方案的完整规则见 [#86 状态方案 3.11](https://github.com/glanderness/BeefTV/blob/bffc87f54625406ccb7b778e088e01d1e5165f01/docs/architecture/generation-task-state.md#311-第-3-步专项调整先固定操作再执行和投影)，研究与 16 项检查见 [#83 固定报告](https://github.com/glanderness/BeefTV/blob/4b84a40d52e7f7da97397349adbb11a1bf7ff42b/docs/research/generation-task-state-step-3-recheck.md)。研究的 5 过、11 失败针对旧 #68；不能当作本候选的测试结果，也不能当作本候选已经全部修复的证明。

### 7.2 本轮改动与证据

- 新分支为 `tds/conv-01a18064-1402-7d75-9399-bb10bb3d06d2`。从固定候选复制的 30 个后台源码及测试文件、7 份日志保持原字节；旧分支和固定提交不改动。
- 实施说明只更新当前接续状态、撤回未经证实的冷启动归因，并新增本节。原验证日志不重写、不摘要替换；原全套通过时间为北京时间 2026-10-28 06:06–06:20:46。
- [接续校验清单](evidence/generation-task-state-step-3/continuation-manifest.json) 保存原候选 38 个文件的 Git blob、字节数和 SHA-256，以及新分支对应文件的字节数和 SHA-256。除本文外，37 个文件必须完全一致。
- 本轮只执行复制一致性、文件清单、Git 收录和差异检查，没有新增运行验证、安装依赖或改变测试阈值。原有全套测试通过不等于真实桌面、跨平台、真实付费生成或完整行为验收已通过。
- 推送后以本轮固定提交的 `git ls-tree` / `git show` 复读每个文件，按清单核对 Git 对象、大小和哈希；提交号随交接消息提供，不用工作区文件代替提交树证据。

### 7.3 独立复查安排与后续权限

本实现会话只完成接续和自查，不自行派子任务或启动评审。交给大总管在单独会话按用户批准的 OpenClaw「[Mem云端·Claude Pro官方OAuth] Claude Opus 5.5」复查；精确模型为 `mem-claude/opus-5-5`，配置为 `pQiCsL4MCjIlonzbKPeV-`，不是 `mem-cloud/claude-opus-5-5` 代理。

复查对象是本轮固定提交相对主线的实际 diff；原测试日志是证据输入，本文的实现自述不代替评审结论。复查覆盖免费取回、扣费原值、防重复操作和数据库兼容，并按 3.11 与研究夹具核对完整请求行为和未覆盖时序。若发现问题，由本任务新会话承接获批范围内的必要修正，再运行相应验证。

本轮不提前第 4–7 步，不修改画布保存、悬停、连线或进度绘制，不恢复已停任务，不开 PR、不合入、不发布，不改 v2.0.5 发布记录。

## 8. Opus 复查后的必要修正

### 8.1 输入与证据口径

- 本轮从干净的 `6d4d13735569751a98126052055021a8a04549dd` 接续；重新 fetch 的 `main` 仍为 `6a155448096d2425aa07e81cc6016410091ad0be`。
- 已读 #97 固定报告 `977f86e678832c3e0566d94141a16dc1a1515f9d` 及 9 份测试/输出文件。报告中的 `review-tests.txt`、`mkv26.txt` 在同步时改变过字节，Mac 原件已删；本轮只把它们当复查记录，不称为逐字节原始日志。
- 本轮在 Git archive 导出的未改候选 `6d4d1373` 上加入测试，保存进程直接写出的新失败输出；没有加入 `probe_store_patch.go.txt`，不复制 #83 的实验补丁。新的原始输出在 [revision](evidence/generation-task-state-step-3/revision/) 中。
- 数据库夹具分别来自主线 v26 的真实迁移，以及该库经未改候选升级得到的 v27；另运行仓库自带的早期历史布局夹具。它们不等于所有历史版本的真实用户数据库。
- 所有请求均为假凭据、本机 HTTP 假上游；数据库和文件在临时目录。没有操作正式客户端、生产数据、真实模型或发布配置。

### 8.2 已复现反例与修正

| 问题 | 本轮失败证据与条件 | 实际修正及对应验证 |
| --- | --- | --- |
| P2：v26 升级漏 API 日志列 | `fixed-candidate-review-red.txt`、`upgrade-red.txt`：未改候选缺 6 列，日志写入报错，失败任务投影不可读 | 追加 v28，保留 v27 ledger；补齐 6 个可空日志列，历史缺表时创建日志表。v26/v27 升级后的写日志、读投影和旧请求重试已复放。缺列会阻止 Ready。 |
| P1：带编号付费重试 500 | `fixed-candidate-review-red.txt`、`paid-retry-red.txt`：公开 `/retry` 返回“任务服务不可用” | task store 的写端口名称与实际实现一致，并有编译期接口检查。回执查找及错误翻译集中在 app；仓储事务只为并发接纳再核对一次。公开 HTTP 用例验证成功、同编号并发仅入队一轮及不同任务返回中文 409。 |
| P1b：第一次成功后同编号冲突 | 未改候选被 P1 阻断，不能声称在原代码直接走到了此处。`paid-replay-red-after-adapter.txt` 是本轮先修正 store 接入后捕获的第二层失败；#97 的探针证据仍只属于临时实验条件 | 先按用户、编号、目标任务读回执，不再用任务当前轮次重算原回执指纹；返回原接纳身份和当前任务投影。公开入口、数据库重开及任务进入后续轮次后的重放均有验证。 |
| P3：免费恢复退出后卡 running | `fixed-candidate-review-red.txt`：未改候选领取后退出的同编号被永久拒绝 | 免费接纳及暂停解除在同一个短事务里提交，回执直接表示“已接纳”，网络执行复用现有任务、扫描和租约。新代码不创建长期 running 免费锁；旧候选留下的同轮 running 行可完成接纳。新测试用等价数据库行构造原退出状态，不依赖已撤除的 Begin/Complete/Abort API。 |
| P4：原轮次丢失 | `fixed-candidate-review-red.txt`：免费回执为 0/3 | 回执保存 `{taskId, action, originalRouteRun, acceptedRouteRun}`，不再序列化整份 Task。新增 `retryOperation` 只读返回原接纳身份。 |
| P4：旧快照回放 | #97 对此仅作代码阅读；本轮 `fixed-candidate-stale-replay-red.txt` 独立复现：交付阶段已改变，重放仍返回旧阶段和进度 | 每次命中回执后重读当前任务并投影。`TestStep3FreeReplayReadsCurrentTask` 同一用例修正后通过；原轮次和旧快照是两项分开的验证。 |
| 自动视频扫描没有接入口 | `fixed-candidate-background-red.txt`：实际 `StartWorker` 后没有查询失败视频；结算继续读取的有效失败证据为 `fixed-candidate-pending-red-fixture-corrected.txt` | 接入原交付恢复循环，继续复用原查询、租约和交付器，不新建计费 worker。无已知期限的 72 小时旧任务仍查询原 ID；已有结果结束结论但扣费 pending 的任务仍可入选，刷新至退款后停止该轮查询。 |
| 图片失败、过期和结果 JSON 未处理 | `fixed-candidate-billing-image-red.txt`：未改候选不保存终态，也没有读取 `result_url` 的结果 JSON | 人工与自动图片恢复共用实现。明确失败/取消保存 `no_result`；明确过期或结果端点 410 保存 `unrecoverable`；503、短响应及临时错误只退避。同步图片按原 job 再 GET 结果 JSON，配置 URL 带 `/v1` 也能正确查询；不生成新任务。 |
| 扣费仍以日志作第二来源 | `fixed-candidate-billing-image-red.txt`：仅有诊断退款日志也能改变购买结论；真实 DTO 路径与持久事实缺失 | 仅官方状态查询直接写任务观察，移除日志回查与日志反写任务。保存原值/存在性、轮次、路由/渠道、上游 ID、观察时间及 `reconcile_deadline`。写入核对轮次、路由、上游身份和冻结输入；迟到旧路由响应不能覆盖当前任务。 |
| 图片超分未被扫描 | `upscale-red.txt` 是本轮扫描修正中的追加失败，不能冒称未改候选输出：图片超分类型是 `canvas_image`，原查询条件漏选 | 扫描覆盖已有 4 个超分型号；使用原 `/media-upscale/tasks/:id/recover` 的合法查询 POST，再 GET 原任务。`upscale-green.txt` 证明没有调用创建接口、没有增加轮次。 |

视频与图片字段来自 BeefAPI 固定 `be8f70726a385e77d5bc0aae242f47ab92c7c7ab` 的 `dto/task.go`、`model/task.go`、`model/task_billing.go`、`controller/image_jobs.go` 和 `relay/relay_task.go`，不是按字段名猜测。视频 `usage_state` 只按 `failed/pending/completed` 映射；图片 `billing_state` 按 `refunded/settled/显式空值` 映射。未知值不会作为退款证明。解析仅识别文档化的根对象或 `code/data` 信封，不递归搜索媒体元数据中同名字段。

DTO 数字 `id` 是数据库行号，原上游身份是 `task_id`；原始供应商 `data` 不当成第二层状态信封。实时查询不含扣费字段或查询失败时，已存同轮观察不会被抹掉。第三方无可信扣费观察时仍需确认；没有新增计费状态机、费用报价或第 4–7 步的付费守门。

旧候选已经写出的任务快照回执仍可读取，用其中的任务号加载当前投影，不删除回执来放开再次入队。旧免费回执缺少的原轮次仍为 0，本轮不从当前轮次猜出历史值；新回执才完整保存两项轮次。

### 8.3 验证、失败与复放

- 原始失败与成功输出分别保留，没有覆盖原候选 7 份日志。运行输出均由对应进程直接写入 `.txt`；它们是否进入提交、字节数和 SHA-256 由本轮提交树清单核对。
- 首次推送 `c24dc28a5b2572faff5a464ccb3bf1cb5f1b072d` 后的提交树核对发现，根 `.gitattributes` 的 `text=auto eol=lf` 将 30 份新输出中的 CRLF 转为 LF，哈希与本机原件不符。本机原件始终保留，已在本轮证据目录用 `.gitattributes` 关闭 `.txt` 的文本/换行转换后补交原字节；不清洗颜色码、不重跑来替换输出。该规则不影响原候选 7 份日志。后续固定交付以补交后的提交树核对为准。
- `operation-green.txt`、`billing-image-green.txt`、`background-green.txt`、`upscale-green.txt`、`continuity-green.txt`、`targeted-all.txt` 保存本轮专项。`research-replay.txt` 为 #83 稳定夹具的正式适配：事实改存任务、暂停通过现有 `/retry` 兼容入口、扫描使用当前 Service 入口；原解析 helper 的 `result_url` 检查改由真实两次 HTTP 查询覆盖。未复制实验判定器。
- `fixed-candidate-background-red.txt` 中首次 pending 场景没有启动工作运行时，不能单独证明产品漏查询；修正夹具后在未改候选再次失败的输出保存在 `fixed-candidate-pending-red-fixture-corrected.txt`。实际 `StartWorker` 场景的失败不受这一夹具问题影响。
- 修正期间的 v28 先遗漏了“历史夹具没有日志表”这一情况，原有 `TestAgentProductReconcileHistoricalLedgers/product-v1` 实际失败，见 `historical-migration-red.txt`。已补建表分支并保留所有原迁移身份检查，只追加 v28 的期望记录；数据库包全套结果见 `database-all-green.txt`。
- 第一轮全套在上述失败确认后由本会话停止，日志为 `backend-all-attempt-1-stopped.txt`，元数据记录 `exit=-15` 和停止原因；它不是通过结论。随后一次完整运行保存为 [final-check/backend-all.txt](evidence/generation-task-state-step-3/revision/final-check/backend-all.txt)，2026-10-28 04:14:35–04:30:28 UTC 实际退出 1，不能计作通过。
- 这次完整运行发现两处本轮兼容回归：不完整图片回执的旧错误被吞掉，以及排空状态下空仓储路径崩溃；还发现一个旧视频下载续传夹具仍按旧查询路径断言。已恢复旧入口的回执报错与排空处理，并将夹具改为已核实的扣费查询路径。失败的“响应成功”不证明发生过新付费生成。`full-regressions-green.txt` 保存对应修正后的通过结果；其中旧库夹具因没有设置环境变量而跳过，由带真实旧库夹具的复放与全套另行验证。
- 冷启动本次完整运行记录 5.911 秒超过原 5 秒预算，原因未定；`cold-open-rerun.txt` 单项复跑实测 1.064 秒、空闲外发 0 并通过。没有修改测试或放宽预算，也不把该次失败归因为“机器抖动”。
- 上述修正后的完整重跑另存 [verified-check/backend-all.txt](evidence/generation-task-state-step-3/revision/verified-check/backend-all.txt) 及同名 JSON，2026-10-28 04:33:38–04:48:57 UTC 实际退出 1。这次只有 `TestWorkflowAcceptedNotRecordedMapsToUnknownBlocksRetryAndKeepsID` 失败：新增免费视频分支覆盖了旧 `submission_unknown` 阻断提示。已恢复 `/retry` 原有的提交未确认排除条件，没有放开这类任务重新生成；`workflow-regressions-green.txt` 保存修正后 RunningHub 与并发重试专项通过的输出。冷启动及其余包在该轮通过，不能因此把全套计为通过。
- 最后一次完整重跑保存在 [accepted-check/backend-all.txt](evidence/generation-task-state-step-3/revision/accepted-check/backend-all.txt) 及同名 JSON，2026-10-28 04:52:17–05:07:43 UTC 实际退出 1。仅 `TestDesktopColdOpenBudgetAndNoIdleOutbound` 失败：Open 实测 5.588227625 秒超过 5 秒（整项用例 6.22 秒）；app、handler、database、repository、task 及其余包通过。`accepted-check` 只是输出目录名，不表示通过。未修改冷启动用例或预算，也未证实并发负载是根因。
- [cold-open-final-isolated.txt](evidence/generation-task-state-step-3/revision/cold-open-final-isolated.txt) 为最后单独复跑，2026-10-28 05:08:31–05:08:36 UTC 退出 0，Open 982 毫秒、空闲外发 0。单项通过不替代上述全套退出 1；没有继续靠重复整套测试寻找绿灯。
- 最新全套的源码指纹为 `accepted-check/tested-source-files.json`，覆盖 1,936 个实际后台源码/测试、锁定的宿主依赖入口及协议包源码；测试开始后没有再改变这些文件。推送后从固定提交逐项核对，不用工作区文件代替提交树。38 个改动过的 Go 文件通过 `gofmt -l`，`git diff --check` 无错误。

复放脚本会从固定 Git 对象生成隔离的 v26 库和 v26→旧候选 v27 库，临时源码和 SQLite 在退出时清理。先红后绿复放（不加入探针补丁）：

```sh
python3 docs/implementation/evidence/generation-task-state-step-3/revision/replay.py --repo . --output .local/cache/step3-replay --red
```

完整后台验证使用 `--full`，仍为 `go test ./... -count=1 -timeout=25m`，不调整冷启动 5 秒预算。脚本使用现有 Go/Bun 锁定依赖和本机生成的协议包；首次准备命令与原第 4 节相同。输出目录可自行指定，避免覆盖本次证据。实际复放脚本结果保存在 `repro-check/`：未改候选 13 个测试失败，当前专项 26 个测试通过、无跳过；该复放不能代替后续包含兼容修正的最新全套结果。

### 8.4 当前交接状态

本轮仅后台修正、必要测试和对应数据库/API 文档；没有修改前端画布、模型配置、依赖锁文件或发布记录。只读结构自查确认本轮撤除了三处重复操作回读中的 task 域回读、免费 running 执行锁、任务快照回放以及日志扣费后备读取；自查不算独立复查。

[本轮提交树校验清单](evidence/generation-task-state-step-3/revision/delivery-manifest.json) 记录相对未改候选的交付文件、原 7 份证据及对应字节数、SHA-256 和 Git blob。完整测试源码清单单独保存在 `accepted-check/tested-source-files.json`；校验清单不包含自身，避免自引用。固定提交号随交接消息提供，推送后再从该提交树核对这些文件。

本轮 Go 重测试已实际结束，已经立即通知大总管 #95 可开始正式原生 FPS 采样；没有遗留外部后台作业。本轮新反例的专项及最新全套中的功能包通过，但完整命令仍为退出 1，不能把第 3 步标为已通过全部检查。独立复查仍由大总管安排指定的官方 OAuth `mem-claude/opus-5-5` 会话，核对本轮修正及尚未确定根因的冷启动失败。真实桌面、Windows 和真实付费生成未测；没有做真实进程强杀/断电测试，退出恢复是隔离数据库状态及连接重开的验证。

本轮生成的临时源码归档、隔离 SQLite 和进程核查临时文件已清理；锁定依赖与已生成的协议包保留供后续复核使用，没有保留额外客户端实例。

旧库迁移验证的通用教训已保存到项目记忆及 nmem `15bf81bf-157b-4722-bc55-613253d12b6a`，未另存本机笔记；任务运行状态仍以本说明及原始证据为准。

## 9. 第二轮 N1：已退款图片的重新入队

### 9.1 固定输入与已确认事实

- 从完整候选 `850d89c109b7e94a356834ee51eedba6dba019fb` 接续，不回退到更早实现。本轮重新 fetch 的主线为 `285c7dec8ee4f2ddc9c53b32076e664b9d8f813b`；相对原基线 `6a155448` 只新增 `docs/ops/2026-10-28-openclaw-launcher-repair.md`，没有后台代码冲突。本分支未合并该文档提交。
- 已读第二轮固定报告 `737816c038fd77b77961edde0e2f1f5eb00c01fa` 的 R2 和 `r2/` 原始用例/输出，33 项校验和匹配。随后补测已实际进入固定 `c7a0fb5b9d113816a98d9a83b9a05faf00d4abe4`；已读 R2-7、过期用例及冷启动对照，重核全部 48 项校验和匹配，包含 `followup/` 的 14 个文件和补测源码。不是仅根据聊天摘要推断补交完成。
- 第二轮独立复放确认首轮 P1/P1b/P2/P3/P4、并发与重开重放通过；Linux `full4` 66 个包通过、退出 0。这些结果属于固定 `850d89c1`，不能替代本轮候选的编译或测试。
- N1 原用例 `TestOpusR2ImageNoResultRetryCanRequeue` 在未改 `850d89c1` 上实际失败：免费查询后已存 `no_result`、退款原值，投影为 `regenerate=allowed`；无编号或新编号的 `/retry` 都只再查询旧 job，不增加轮次、不排队。过期变体的退款分支也实际失败。
- 原用例、补测用例及两份直接失败输出按原字节保存在 [r2-fix/input](evidence/generation-task-state-step-3/r2-fix/input/)。它们是 #97 已执行的独立反例，本轮没有在 Mac 重跑，也不把这些复制件称为本轮新运行的输出。`followup/n1-unrecoverable/command.txt` 是补交时重写的命令说明，不是遗留下来的原始命令文件。
- 补测文案把过期写成“410”，但原用例实际返回 HTTP 200、`status=expired`。其中 `billing_state=charged` 只验证未知值保持 `confirm`，不能当作真实图片 `settled` 协议的覆盖。本轮新增用例另列结果端点 HTTP 410 与正式 `settled` 字段，仍待执行。

行为依据仍为 #86 `bffc87f54625406ccb7b778e088e01d1e5165f01` 的第 3.11 节：持有 job 号不表示永远只能取回；明确 `no_result/unrecoverable` 后按扣费事实处理。没有新增产品选择或第 4–7 步的确认参数。

### 9.2 最小修正与新增用例

生产代码只改两个文件：

- `app/image_submission.go` 增加窄方法 `imageRecoveryAllowsRetry`：仅对失败图片和两项明确恢复结论，调用现有 `taskOutcomeFacts` 与唯一 `task.ComputeOutcome`，读取当前轮次的 `regenerate=allowed`。不另写退款字符串判断、不从日志授权、不信任旧回执快照。
- `app/service.go` 的图片免费分支使用该结果：已允许重新生成时交给原付费重试事务，不再先接纳成 `free_recovery`。旧编号查回执仍在分流和资格检查之前，原编号不变成新购买。
- 同一个窄方法用于图片的旧“已有 accepted 请求”校验，避免真实任务留有 route attempt/submission 时又被这道旧校验挡住。其余资格、审核、取消、排空及失败分类检查保留；付费入队、`routeRun+1`、清空旧观察和操作回执继续使用既有事务。

没有改恢复扫描、数据库结构、日志协议、旧回执未知轮次、公开返回字段、前端或发布记录。结算中、明确已扣费和缺键不因已有恢复结论而自动获得新轮次；确认重跑怎样携带同意仍属后续步骤，本轮不添加参数，也不声称已解决这一产品问题。

新增 `app/step3_image_retry_after_refund_test.go`（**尚未编译或执行**）：

- 通过现有 Service 入口验证失败、`status=expired`、结果端点 HTTP 410 三类退款结果；无编号与新编号各自独立验证重新入队，避免原 N1 用例中旧式重试成功后跳过新编号分支。
- 过期和 410 变体包含真实 accepted route attempt/submission 结构，检查旧保护不会继续锁住已允许重试的图片。
- 验证新编号重放只接纳一轮，原免费编号在前后都保持原身份和当前投影；再次重试不查询旧 job、不提交上游创建。
- 用正式 `settled`、显式空值和缺键检查未退款图片不被放开；只检查仍不入队，不为“反复查旧 job”增加新的行为承诺。

### 9.3 本轮验证分工与可复放命令

用户已调整验证分工：#95 正在 Mac 正式采样，本轮不启动 Mac Go 编译、测试或全套；由大总管复用 #97 的官方 Opus 云端会话，在独立临时副本执行。同一候选必要检查通过后才可能验收。本轮只运行 `gofmt` 格式化、文本差异检查和 Python/命令清单的静态检查；这些都不证明 Go 能编译或新用例通过。

[replay_n1.py](evidence/generation-task-state-step-3/r2-fix/replay_n1.py) 从 Git 对象解出两个临时副本：未改 `850d89c1` 与本轮完整固定提交。它只叠加保存的两份 Opus 用例和新增回归，不改 #97 原件或原测试目录；复用已物化的官方协议包。依次保存旧候选失败、修正候选 N1 与相邻 app/handler 回归的原始输出、退出码、起止时间和源码指纹。脚本未在本轮运行。

```sh
python3 docs/implementation/evidence/generation-task-state-step-3/r2-fix/replay_n1.py \
  --repo "$STEP3_N1_REPO" \
  --candidate "$STEP3_N1_CANDIDATE" \
  --plugins "$STEP3_N1_PLUGINS" \
  --output "$STEP3_N1_NEW_OUTPUT"
```

上述变量分别为含两个 Git 对象的仓库、本轮交接消息的完整 40 位 SHA、已有的官方协议包目录、尚不存在的新输出目录。只有该脚本中“旧候选失败、候选及相邻回归通过”都真正结束才可报告先红后绿；环境缺插件、编译失败或没有运行到用例不能算旧代码反例。脚本退出后清理自己的临时源码，不删除 #97 原件。

脚本在已叠加原用例的临时副本内运行以下 N1 命令，旧候选预期退出 1、修正候选预期退出 0：

```sh
go test ./internal/app -run '^(TestOpusR2Image(NoResult|Unrecoverable)RetryCanRequeue|TestStep3Image(RefundRetryAfterResultConclusion|ConclusionWithoutRefundDoesNotRequeue))$' -count=1 -timeout=5m -v
```

相邻 app/handler 回归命令（不自动运行全套、不重复数据库升级检查）：

```sh
go test ./internal/app ./internal/handler -run '^(TestRetryAcceptedImageUsesOriginalReceiptWithoutCreate|TestImageReceiptRecoveryRejectsAmbiguousAndFailedCreates|TestAutomaticImageRecoveryConclusions|TestImageSubmissionUnknownProviderCannotReplayOrRetryLostResponse|TestImageSubmissionCountErrorCannotErasePriorAcceptance|TestStep3ImageJobTerminalConclusionAndResultJSON|TestStep3FreeReplayReadsCurrentTask|TestStep3PaidRetryReplayAfterDatabaseReopenAndNewRun|TestReviewFreeRecoveryRunningReceiptAfterCrash|TestReviewFreeRecoveryReceiptRecordsRouteRuns|TestStep3ConcurrentRetryHTTPAndConflictingTask|TestReviewPaidRetryWithOperationIDRequeuesOnceAndReplays|TestWorkflowAcceptedNotRecordedMapsToUnknownBlocksRetryAndKeepsID)$' -count=1 -timeout=5m -v
```

这组回归覆盖正常免费取回、未知提交保护、旧回执重放、新编号去重、并发 HTTP 与 RunningHub 提交未确认保护。只用假上游、隔离 SQLite 和假凭据；未运行真实生成或正式客户端。

### 9.4 冷启动：已读证据与下一项最小区分验证

已读的 Linux 补测先预编译测试二进制、共用同一个官方插件目录，基线和 `850d89c1` 交替各跑 15 次单项，30 次全部通过；基线平均 245 毫秒、候选 249 毫秒。首次基线缺协议目录的 10 次失败不参与比较。它们不能替代 Mac 并行全套的 5.588 秒失败，也不能证明原因是机器抖动。

源码核对能确认：Open 计时包含临时目录创建、工作区锁、数据库/迁移、插件初始化、内置模板/技能和 HTTP 路由注册；不包含之前的 Go 编译，也不包含计时结束后 `Runtime.Start()` 才启动的后台任务循环。本轮的 `/retry` 分流及图片重试校验不在这段启动调用链内。新建空库先由 v1 创建当前模型，v27/v28 会检查已存在的列，不能假定这里一定执行了七次 ALTER。

**以下仅为后续建议，未实施、未运行，须等大总管协调 Mac 采样结束后的时段：**

1. 暂不再跑完整全套。先在 Mac 上为基线和候选各预编译同一个冷启动测试二进制，固定官方插件目录、输出位置、数据盘和环境。每次仍用新的隔离数据目录，保留原 5 秒阈值及空闲外发断言；记录实际工具链、环境和进程起止。
2. 只在临时诊断副本给 Open 的数据库/迁移、NewLocal 插件构造、内置资源初始化、路由注册四段加时间戳，基线/候选按 A-B-B-A 各两次单项。区分“候选某一固定阶段增加了稳定开销”与“同机空闲时无明显差异”。诊断计时不进入本次产品补丁，也不把带额外计时的结果替代原验收用例。
3. 若 Mac 单项仍无差异，就保留“并行全套条件下原因未定”，不要继续靠多次全套寻找绿灯。再由大总管决定是否安排一次带阶段/调度跟踪的原并行条件复现，或先缩小并发包组合；先看到慢在哪段再选择负载，不能拿随意制造的 CPU 压力当作原问题。`-parallel` 控制包内并行测试，不能当作跨包 `-p` 的替代。

本轮没有改变启动实现或冷启动阈值，也没有安排上述 Mac 验证。

### 9.5 本轮交付状态

本轮是**未做本轮编译验证**的小范围修正候选。固定提交、输入原件与交付文件的字节数、SHA-256 和 Git 对象见 [r2-fix/delivery-manifest.json](evidence/generation-task-state-step-3/r2-fix/delivery-manifest.json)；该清单不包含自身。原 7 份日志及第 8 节证据保持原字节，新增证据目录单独关闭文本转换。

本实现会话不自行派评审。候选与上述命令交回大总管安排既有官方 OAuth Opus 云端核验，结果返回后再处理必要修正。本会话没有启动或遗留 Go 编译、测试或外部后台作业，未合入、未发布。原 Linux 绿灯、Mac 失败及单项通过记录各自保留；没有把尚未执行的检查写成通过。

## 10. R3 结果确认与 Mac 对照准备

本节保留 `740e2544` 准备阶段的历史状态。更新后的 spec 已明确释放 Mac 窗口，本轮实际执行结果见第 11 节；不再等待重复通知。

### 10.1 R3 读回结果

已读取 #97 固定报告 `f557d147ab5760b5eb09c3a10cdadf5afd7cbe28` 的 R3，以及同目录 `r3/` 全部原始文件并核对校验和。产品候选仍是 `30ed8d92910fe928b84cf918d870b8d600923144`，本轮没有修改产品代码、N1 用例或 `replay_n1.py`，没有重跑已通过的项目。

[r3-confirmation/input](evidence/generation-task-state-step-3/r3-confirmation/input/) 按原字节保留该固定 R3 的 20 个文件，包括首次夹具错误、真实业务失败与通过输出；[verified-results.json](evidence/generation-task-state-step-3/r3-confirmation/verified-results.json) 记录本会话逐名读回的结果与输入来源。两个源码快照也从各自 Git 树复核：候选 1,673 个后台文件、未改 `850d89c1` 的 1,672 个文件均与复查记录匹配。本会话只读证据，没有把这些检查称为自己运行的 Go 测试。

| 对象 | 实际证据与结果 | 当前判断 |
| --- | --- | --- |
| 未改 `850d89c1` 的 N1 | `unchanged-850-n1.json` 退出 1；两项原用例和新退款用例的失败发生在未入队/重复查询等业务断言，不是编译或插件缺失 | 原反例有效 |
| `30ed8d92` 的 N1 | Linux Go 1.27.3，`candidate-n1.json` 退出 0；逐名核对四个顶层用例及所有子用例 PASS，无 FAIL/SKIP | 能编译，N1 已通过独立核验，可移出未完成项 |
| 同一候选的相邻回归 | `candidate-adjacent.json` 退出 0；app 11 项、handler 2 项，13 个顶层测试名均出现 RUN/PASS，无缺项或跳过 | 通过 |
| 跨轮次退款探针 | 最终输出中三种第 5 轮状态分别通过；旧第 4 轮退款不能令下一轮再次入队，也没有向上游提交 | 通过，探针保留在复查证据，未加入产品 |
| 探针前两次失败 | `probe-attempt1/2-fixture.txt` 分别为失败错误设成不可重试的 `x`、JSON 写入方式错误；最终夹具修正后通过 | 保留为夹具失败，不算产品回归 |

**计数更正：** R3/任务摘要写“N1 四项、20 个子项”，但 `candidate-n1.txt` 实际只有四个顶层和 14 个带 `/` 的子用例，共 18 条 RUN、18 条 PASS。两份原用例贡献两个子用例，新增退款与未退款用例各六个；没有缺失用例。这里按原始日志记为 **4 项 + 14 子项全部通过**，不沿用“20 子项”。该差异已告知 Chief，不影响 N1 通过结论，也不因此重跑。

R3 指出的 `replay_n1.py` 成功判断偏松如实保留。此次确认依据实际测试名、退出码、原始输出与源码指纹；不是仅依据脚本退出 0。本轮不为说明缺点另改脚本或产品。

### 10.2 仍未完成或未覆盖的检查

- `850d89c1` 的独立 Linux 全套通过属于旧候选；`30ed8d92` 本轮只做过上述编译与专项，没有新全套结果。
- 旧 Mac 并行全套 Open 5.588 秒超过原 5 秒、单项 982 毫秒通过的两项记录继续有效。Linux 基线/旧候选各 15 次单项通过，不能替代 Mac，原因仍未定。
- `30ed8d92` 的 Mac 编译、原冷启动单项、诊断计时均未运行；真实客户端、Windows、真实上游和真实付费生成仍未测。
- 结算中/需确认时有无编号的返回差异、旧回执未知轮次等既有未扩展行为不在本轮修正；未新增第 4–7 步的参数、规则或功能。

因此 N1 不再阻断，但不能据 Linux 专项宣布整个第 3 步已完成全部验收，更不能抹掉旧 Mac 全套失败。

### 10.3 已准备的 Mac 最小对照材料

材料及具体命令见 [mac-cold-start/README.md](evidence/generation-task-state-step-3/mac-cold-start/README.md)，脚本为 `prepare_and_run.py`，诊断差异可直接读 [open-four-phases.patch](evidence/generation-task-state-step-3/mac-cold-start/open-four-phases.patch)。脚本固定基线 `6a155448096d2425aa07e81cc6016410091ad0be` 和产品候选 `30ed8d92910fe928b84cf918d870b8d600923144`。

- `prepare` 仅解出四套源码副本、写诊断 diff 和输入指纹。它不调用 Go，不生成二进制，不启动测试。原用例、runtime.go、Go 模块锁定输入在两侧逐字节一致。
- `execute` 是另一个显式命令；**只有 Chief 明确通知采样结束后才可使用**。它冻结现有协议包和数据位置，先串行预编译四个单包测试二进制，再分别运行原版 A-B-B-A 四次、诊断版 A-B-B-A 四次。每次是新进程、新工作区，5 秒预算与空闲外发为 0 的原断言不变。没有自动全套、自动复跑或人为施压。
- 诊断仅修改临时副本 `bootstrap/runtime.go`：数据库/迁移、NewLocal/插件、内置资源初始化、组合与路由四段。插桩源码不进入产品，诊断版结果也不替代原版验收。两次样本只帮助选择下一项检查，不能证明统计稳定性或根因。

准备动作已在本任务 ExternalWork 临时目录实际校验，见 [prepare-check.json](evidence/generation-task-state-step-3/mac-cold-start/prepare-check.json) 和 `prepare-only.txt`：四套副本生成成功，原用例相同，两套诊断 diff 相同，诊断只改 `runtime.go`，`gofmt -l` 无输出。只做 Python AST 与 Go 格式解析，**没有 Go 编译、测试或实际时间测量**。校验用临时源码已清理，提交的脚本和差异可在窗口到来后重新生成相同材料。

测试数据与冻结协议包统一放在 ExternalWork，与旧全套临时数据位置不一定相同；这是固定条件 A/B，不能冒充旧并行环境的完整重演。若 Mac 单项未见明显差异，仍记录“原并行全套条件下原因未定”，先把四段数据交 Chief 决定下一项区分验证，不自动重跑全套。

### 10.4 本轮交付状态

产品候选保持 `30ed8d92`。本次提交只增加 R3 读回记录与 Mac 准备材料，原有证据保持原字节。固定提交清单见 [preparation-manifest.json](evidence/generation-task-state-step-3/preparation-manifest.json)，推送后从该固定提交核对文件、字节数、SHA-256 和 Git 对象；不以工作区哈希代替提交树。

准备完成即交回，不在工具中等待采样窗口。本会话没有启动或遗留 Go 编译、测试、真实客户端或后台作业；不自行派评审、不合入、不发布。后续执行仍等待 Chief 的明确通知。

## 11. Mac 固定条件最小对照结果

### 11.1 本轮实际范围

新会话先按 Git 原字节恢复 `740e25441e16791ac15d48c5344c81ba52ebe372` 的全部 165 个变更文件，保留原有产品、测试、文档和证据，以及当前主线额外的运维文档。本轮产品后台没有新增修改，仍与 `30ed8d92910fe928b84cf918d870b8d600923144` 一致；没有重做已通过的 Linux N1、相邻回归或跨轮次探针。

本任务新 spec 已明确通知 #95 的前一轮采样结束，因此直接执行已准备的 Mac 对照，不继续等待旧 README 中的通知。新工作区未物化协议包，使用上一会话已有的 86 个包冻结成一份只读输入，没有重新打包或修改原目录。四套源码、独立构建缓存、临时文件、数据和冻结包均位于已挂载的 ExternalWork。本轮关闭依赖下载，使用 `-mod=readonly`，没有安装或修改共享依赖。

只对测试材料补充了现场负载、实际 Go 环境、二进制哈希和逐名 RUN/PASS 记录；原测试与四段诊断插桩逐字节保持原材料。原版与诊断版分别按 A-B-B-A 各运行一次序列，每侧每组两次，四套二进制先串行预编译。没有全套、额外重跑、主动施压、真实凭据、真实生成或客户端操作。

### 11.2 实际结果和四段耗时

执行时间为北京时间 2026-10-28 15:18–15:20:43，Mac M4、10 核、24 GiB、macOS 26.6.2，Go 1.26.3 darwin/arm64。四次编译均退出 0。八份原始输出均实际运行且通过 `TestDesktopColdOpenBudgetAndNoIdleOutbound`，无 FAIL/SKIP，5 秒预算及空闲外发为 0 的原断言全部保留并通过；不是只看驱动退出 0。

| 原版顺序 | 固定版本 | Open（毫秒） | 用例退出码 |
| --- | --- | ---: | ---: |
| A | `6a155448` | 3253 | 0 |
| B | `30ed8d92` | 1303 | 0 |
| B | `30ed8d92` | 1296 | 0 |
| A | `6a155448` | 1212 | 0 |

诊断版仍运行原用例，只为观察阶段，不能替代原版验收。下表各阶段及合计保留三位小数，完整纳秒值见 [verified-results.json](evidence/generation-task-state-step-3/mac-cold-start/results/verified-results.json)。

| 诊断顺序 | 总 Open | 数据库与迁移 | NewLocal 与插件 | 内置资源 | 组合与路由 | 四段合计 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 1284 | 40.361 | 1168.711 | 56.711 | 18.066 | 1283.849 |
| B | 1441 | 46.076 | 1326.683 | 52.440 | 14.934 | 1440.133 |
| B | 1197 | 41.025 | 1077.736 | 57.903 | 20.659 | 1197.322 |
| A | 1288 | 35.502 | 1182.265 | 55.806 | 14.398 | 1287.970 |

单位均为毫秒。总 Open 是原测试截断到整数毫秒的输出；四段合计没有截断为整数，所以会出现 1197.322 大于显示的 1197。计入毫秒截断后，四段之外的剩余时间各在 0.151–1.151、0.867–1.867、0–0.678、0.030–1.030 毫秒区间内，包含 `t.TempDir()`、时间读取和诊断输出等，不能单独当作插桩开销。原版没有插桩，不把两组直接相减来估算产品退化。

### 11.3 能说明什么，下一项检查是什么

这批原版单项没有显示候选一致地慢于基线：基线首个样本为 3.253 秒，末个为 1.212 秒，候选两次约 1.30 秒。首样本为什么较慢没有阶段记录，不能归因于缓存或负载。新进程和新工作区不等于清空操作系统缓存，原版先运行、诊断版后运行也可能有顺序影响；各侧两次不能证明统计稳定性。

四个诊断样本中，NewLocal/插件阶段都是主要耗时，约 1.078–1.327 秒；数据库与迁移约 35.5–46.1 毫秒，没有观察到某个候选阶段两次都明显增加。用例前的系统一分钟 load average 约为 8.73–10.68，机器并非被证明处于空闲状态；负载均值也含先前编译的历史影响，不能据此认定旧失败是资源争用。96 份前后负载快照与每次起止保留供后续核查，本轮没有人为制造负载。

**旧 `850d89c1` Mac 并行全套的 5.588 秒失败原因仍未定。** 本轮统一外置卷位置、固定协议包且串行执行，不能冒充旧并行现场的完整重演，也不能用八次通过消除原失败。

建议交 Chief 决定的下一项最小检查：只对候选安排一次旧并行条件下的定点捕获，在临时副本保留四段时间戳，并给包含冷启动的 bootstrap 测试进程保存 Go 调度 trace；其余并发包、`-p`、工具链和数据盘先按可恢复的旧现场条件记录清楚。目标是区分“慢的那一段主要在等待调度”与“该阶段运行工作本身变长”，不再增加串行单项次数，也不先猜哪种人工负载能触发。诊断本身会增加开销，结果另列；若这一次未复现，仍保留原因未定。本轮没有执行该建议或任何全套。

### 11.4 证据、通知与清理

完整材料见 [mac-cold-start/results/README.md](evidence/generation-task-state-step-3/mac-cold-start/results/README.md)：原始编译/用例输出、实际测试名、起止、PID、退出码、96 份负载快照、四套源码指纹、冻结协议包哈希、诊断补丁和逐名核查结果。原始 `.txt` 禁止换行转换，不清洗 GORM 的 CRLF 或颜色码。`740e2544` 既有证据继续按原字节保留。

execute 于 15:20:43 退出 0；检查本任务测试/编译 PID 和进程路径均已结束后，立即通过 `message_chief` 通知 Chief 释放 #95 的补测窗口，没有等文档整理结束。此后不再运行 Go。没有遗留本任务后台作业，没有启动正式客户端，没有付费、合入、发布或自行派评审。

结果先逐字节复制到本轮分支；交付清单见 [results/delivery-manifest.json](evidence/generation-task-state-step-3/mac-cold-start/results/delivery-manifest.json)。清单列出提交前预期 Git blob、字节数和 SHA-256，用于提交后从固定 Git 树核对，不能单独冒称提交树已验证。临时原件保留至固定树复核成功再清理本任务源码、二进制、缓存、数据和冻结副本，不删除原协议包或其他任务目录。

## 12. 单次并行诊断：只准备，未执行

### 12.1 本回合中断核查

先只读本人上一个回合的原始 Codex 结束事件，确认北京时间 15:36:34.820 的 `task_complete.error.codex_error_info=server_overloaded`；回合开始于 15:33:52.943，没有 final。脱敏事件、原始行号和截至该事件的日志前缀哈希见 [interruption-event.json](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/interruption-event.json)。这证明本次也是上游满载中断，不把另一任务的诊断直接套用到本次。

本轮没有重做 #39 的九组模拟，没有升级或重启共享程序，没有切换模型、运行配置或权限。平台为何显示 review 的机制只引用 #39 既有诊断，没有新增平台请求证据。本轮保留原工作区并接续完成授权的材料准备，不将此前“会准备”的文字算作完成。

### 12.2 旧条件与一次命令的实际范围

详细材料和可执行命令见 [parallel-capture/README.md](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/README.md)，固定条件、差异和证据位置见 [source-conditions.json](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/source-conditions.json)。

- 5.588 秒失败来自 `revision/accepted-check/backend-all.txt/json`，不是更早的 `final-check`；输出 SHA-256、失败行 5284–5285 和退出 1 均已核对。其 1,936 项测试输入指纹全部匹配 `850d89c1` 固定树。
- 实际命令是 `go test ./... -count=1 -timeout=25m`，旧本机调用记录也确认使用 `replay.py --full`。实际结束输出为 69 个包，其中 66 个有测试、3 个无测试；完整包名和耗时列在 [original-packages.json](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/original-packages.json)。
- 能恢复命令、包集合、源码、模块锁文件及原两份历史库的生成方式；不能恢复旧的精确同时运行包、有效 `-p`、`GOFLAGS/GOMAXPROCS`、工具链版本、物化协议归档字节、测试临时盘或机器缓存/负载。不因机器有 10 核就把旧 `-p` 写成 10，也不把源码在外置卷当成测试数据同盘的证明。
- 为保留原命令的自然并行背景，拟执行一次 `./...`，会运行这些包中的既有回归；这不是新一批专项回归。原墙钟 15 分 25 秒，预计含夹具准备、编译及复制约 15–25 分钟，非承诺上限；原 25 分钟超时按测试二进制计算。正式执行前范围已在材料中明示，本轮未发出该命令。

当前产品固定 `30ed8d92`，与旧 850 相比只多两处产品文件修正和一份 N1 测试文件。产品修正保留，N1 源码不动；唯一并行命令通过 app 的 skip 排除 30ed 新增的两个 N1 顶层用例及子项，不叠加独立 Opus 探针、不单独复跑 N1 或已通过回归。旧套件中的其他用例作为原命令背景运行，与“只跑 bootstrap”不同，不能隐藏其占机范围。

### 12.3 已准备的诊断材料及其限制

[capture_once.py](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/capture_once.py) 明确分为 prepare/execute。prepare 只读 Git 和现存文件；execute 需要 Chief 确认窗口可用并接续本次捕获的真实通知，使用排他的一次执行记录，不自动追加尝试。本轮仅实际调用 prepare。

最新协调确认 #95 本轮补测已于 15:50 交付，两侧测试 App、假上游和 sink 均报告停止，#101 只读核验期间不会重新开启 Mac 采样，因此原等待的时段条件已满足。但同一通知要求继续只准备，先不启动 Go，待 Chief 读回固定材料后再衔接一次捕获。本轮据此只更新该状态，不执行诊断。

诊断源码仅放在证据材料与临时副本中，四段位置沿用第 11 节，同时增加 trace task、四个 region 和 data_dir 注记，帮助从整个 bootstrap 进程中辨认冷启动那一次 Open。原冷启动测试逐字节未改，5 秒与外发 0 不变。原测试的总 Open 与四段之和分别记录，不把额外 trace/日志开销当作产品退化，也不把带 trace 的通过当作无插桩验收。

未来唯一命令保留原包集合，不提前预编译全部二进制；附加 `-json/-exec` 记录新包时间线，只给 bootstrap 进程增加 trace，保存其原字节输出。原 replay 的两次历史库生成是输入准备，不是追加的测试。现有协议包冻结为上一轮同一批 86 个归档；宿主依赖复制到本任务副本，不安装、不改共享依赖。数据与缓存固定 ExternalWork，使用无真实凭据的隔离环境；这些条件与不可恢复的旧环境存在差异，不能称完整重演。

trace 若显示目标阶段存在明显 Runnable 等待，可以量化 Go 调度等待的贡献；仅看到 Running 墙钟增加，不能证明计算工作增加，因为还缺操作系统线程调度或 CPU 证据。未复现、阶段/trace 缺项或不能唯一定位目标 Open 时，结论停在“原因未定/观测不足”，不自动重跑、不改产品或阈值。具体判读方法和正确的 Go 1.26.3 `-d=parsed` 命令已写入材料；本轮没有调用它。

### 12.4 本轮实际验证与交付

实际准备输出及子进程审计见 [prepare-check.json](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/prepare-check.json)：Python AST、固定源码锚点、原测试/模块逐字节一致、宿主锁定输入一致均通过，准备的所有子进程都是 Git 只读操作。现存 Go 仅按文件路径与哈希记录，没有执行 `go version`、格式解析、编译、测试或 trace 读取；新诊断源码的编译与真实行为仍待窗口释放后验证。

交付前保留 `a184a716` 的所有产品、测试和原始证据字节，仅更新本说明并新增本节材料。清单见 [parallel-capture/delivery-manifest.json](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/delivery-manifest.json)，推送后从固定提交树核文件、字节、哈希和原件保留情况，再清理本轮临时准备副本。没有本轮执行结果，没有启动或遗留 Go、客户端或无人监控作业；准备完成即交回 Chief，不在工具中等待后续接续通知。

## 13. 单次并行捕获的实际结果

### 13.1 执行范围与结束通知

收到本轮 Chief 明确执行通知后，从完整准备提交 `65a38475c8a904f6c507e9d6706dd3b54fffb612` 接续，在已挂载 ExternalWork 的新任务目录准备并调用一次 execute。准备与执行的原始驱动记录、通知原文和输入指纹均见 [results-20261028](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/results-20261028/README.md)。没有重查模型中断，没有改变模型、共享程序或权限。

实际先生成两份原历史库，均退出 0；随后只运行一次已批准的 `go test ./... -count=1 -timeout=25m -mod=readonly -json -exec=...`。未手设 `-p/-parallel`，没有另跑冷启动、N1 或专项。原包集合 69 个包均开始并结束：58 pass、8 fail、3 无测试。新增两个 N1 顶层用例的 skip 出现在 app 实际 argv 中，输出没有这两项 RUN；N1 源码和产品未改。

Go 1.26.3 darwin/arm64；并行命令北京时间 16:06:58.994 开始、16:26:17.971 结束，墙钟约 19 分 19 秒，退出 1。execute 驱动于 16:26:18.216 退出 1。不是全套通过，也不是第二次尝试。

结束后核查进程时，首次 ps 文本含非 UTF-8 字符导致解码失败；首条通知中“已核无残留”说早了。16:27:34 改为按 ps 原始字节匹配任务路径、原进程组和全部记录 PID，实际确认 Go、测试、exec 回调和 Node 均无残留，并立即向 Chief 更正、报告窗口已释放。原始核查记录为 `processes-after-verification.json`。之后只作离线解码与文件核验，没有继续测试或启动客户端。

### 13.2 本次确实触发原 5 秒断言

原 `TestDesktopColdOpenBudgetAndNoIdleOutbound` 恰好一条 RUN、一条 FAIL，无跳过。失败为 `fresh local Open took 5.089262542s, budget is 5s`；原测试逐字节不变，空闲外发检查在预算检查之前，已通过外发 0 断言才到达本次预算失败。原代码只在通过时打印 `local_open_ms`，因此不能要求失败输出也包含该行，或把缺行当成未跑测试。

| 阶段 | 原计时（毫秒） | trace region（毫秒） | 主 goroutine Runnable（毫秒） | Syscall（毫秒） | Running（毫秒） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 数据库与迁移 | 461.182 | 461.184 | 0.190 | 434.443 | 26.526 |
| NewLocal 与插件 | 3686.161 | 3686.162 | 1.118 | 887.990 | 2796.995 |
| 内置资源初始化 | 899.257 | 899.258 | 0.223 | 873.524 | 25.512 |
| 组合与路由 | 42.514 | 42.514 | 0.009 | 11.577 | 30.929 |

四段原计时合计 5.089113833 秒，总 Open 比它多 0.148709 毫秒；该差值含 `t.TempDir()`、trace/日志等未计入四段的开销，不能全算作某一项。trace region 合计 5.089118720 秒，另有数据库/插件两段共 0.083776 毫秒 Waiting，完整纳秒值见 `cold-state-analysis.json` 和 `verified-observation.json`。

### 13.3 trace 可以确认什么

原始 trace 解码退出 0，按 data_dir 唯一识别到 `STEP3_OPEN` task 48、goroutine 15956，四段 region 和阶段 Log 全部齐全，与原输出的四段数值一致。按全局状态区间裁剪，以及每段从 Running 状态独立重新积分，两种方法逐段完全一致，没有状态时间缺口或不一致。可复算脚本为 [analyze_capture.py](evidence/generation-task-state-step-3/mac-cold-start/parallel-capture/analyze_capture.py)。

四段中该主 goroutine 合计：Runnable 1.539328 毫秒、Syscall 2207.533158 毫秒、Running 2879.962458 毫秒、Waiting 0.083776 毫秒。可确证的 Go 运行队列等待约占 0.030%，不足以作为本次 5.089 秒的主要解释。NewLocal/插件仍为本次主要阶段，但其中 Running 墙钟约 2.797 秒不等于实际 CPU 消耗；Syscall 也不等于已证实的磁盘争用。缺少操作系统线程调度、CPU 或具体系统调用归因证据，不能继续推断是“计算量增加”或“机器抖动”。

trace 起始 Sync 与 Go JSON 包时间窗交叉显示，冷启动约发生于 16:13:29.749–16:13:34.838；当时窗口覆盖 app、bootstrap、handler、operations、plugins 五包。JSON 时间有管道观测开销，这不是 OS 执行时间线；更不能据此倒推旧 850 同时运行哪些包。trace 起始 GOMAXPROCS 指标为 10，只描述新进程，不证明旧有效 `-p=10`。

### 13.4 实际材料缺口与其他失败

本次发现准备脚本遗漏：只把现有 86 个物化协议包冻结到环境指定目录，源码副本 `plugin-packages/` 实际为 0 个归档。protocol 单测及 app 的三项协议包测试直接读取相对源码目录，出现 `no such file or directory` 或本地包数量与运行时数量不符。它们是已复现的测试材料问题，不是已证明的产品回归；提前失败改变了部分并行背景。本轮没有在运行中补档，也没有修正后重跑。`capture_once.py` 保留固定 65a 的实际执行字节，不能原样宣称是完整旧现场复演模板。

另外五个非冷启动失败包为 cmd/beeftv（CLI 子进程被终止）、assistantruntime（宿主未按时就绪）、desktopnet（显式直连代理断言）、desktopupdate（重启夹具未运行）、generation（DNS 截止时间断言）。逐项原始输出保存在 `failure-evidence.json` 和完整 suite 输出中，本轮不扩展定位或修改产品，也不把它们一概归因于负载。

输入核对确认实际 1,673 个后台文件只在临时 `runtime.go` 增加四段/trace；原测试、模块与当前产品保持固定 30ed。86 个冻结包的哈希与前一轮单项相同，隔离 HOME、ExternalWork 临时盘、禁用个人 GOENV 和依赖下载等差异继续保留。旧有效 `-p`、工具链、物化归档和临时盘等本就无法恢复；再加上本次材料遗漏和 trace/JSON/exec 开销，**不能将这次 5.089 秒认作旧 5.588 秒的同因复现**，也不能宣布当前候选通过全套验收。

本次结论停在：一次捕获中预算确实超时，NewLocal/插件最慢，主 goroutine 的 Go 排队等待不是主要成本；剩余 Running/Syscall 的原因与旧失败原因仍未定。如后续需要继续区分，先修复单测物化包路径，再由 Chief 决定是否补 CPU/OS 调度证据，本轮不追加实验。

### 13.5 证据与清理

完整 suite 原输出、bootstrap 原字节、实际 argv/PID/起止/退出、包和测试事件、Go 环境及前后/持续监控负载均在新结果目录。原始二进制 trace 及选定事件文本用 gzip 无损保存，保存前核解压字节数和 SHA-256；选定事件明确是子集，不冒充全部解码输出。全量展开约 9.9 GB，只是原始 56 MB trace 的派生物，不纳入 Git；保留其解码命令、退出和完整输出哈希，可从原始 trace 复算。

固定提交前后的文件清单和原字节保留情况见新结果目录的 `delivery-manifest.json`。推送后从固定 Git 树复核原始日志及解压 trace 的字节、SHA 和实际退出信息，再清理本任务临时源码、缓存、数据及全量派生文本。旧所有原始证据保留，不改共享依赖、正式客户端或其他任务，不合入、不发布、不自行派评审。
