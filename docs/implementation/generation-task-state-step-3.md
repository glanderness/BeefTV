# 生成任务状态重构：第 3 步实施说明

状态：本轮实现和本机回归已完成；改动仍停在独立分支，未合入主线、未发布，也没有调用真实付费生成。

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

通过的专项和包测试：

```text
go test ./internal/database -count=1                         通过
go test ./internal/repository -count=1                       通过
go test ./internal/task -count=1                             通过
go test ./internal/task -run '^TestComputeOutcome$'            通过
go test ./internal/app -run '^TestImageJobResultQueriesCurrentRouteWithoutCreating$' 通过
go test ./internal/app -run 'TestProviderBillingStates|TestImageJobIDFromHeaders|TestFailedHandwrittenVideoRecoveryQueriesOriginalTaskWithoutCreating|TestFailedThirdPartyVideoRecoveryRenewsOriginalTaskAndMaterializes' -count=1 通过
go test ./internal/repository -run '^TestRetryOperationReceiptIsIdempotentAndAbortable$' -count=1 通过
```

最终 app 包回归：

```text
go test ./internal/app -run '^TestVideoProtocolUpgradeRecoversOriginalTasks$' -count=1 -timeout=15m 通过（约 6 分钟）
go test ./internal/app -count=1 -timeout=20m                         通过（约 12 分钟）
```

`TestVideoProtocolUpgradeRecoversOriginalTasks` 曾在默认 10 分钟的整包运行中尚未轮到结束，因此第一次整包结果是 timeout；为定位曾先用 `-skip '^TestVideoProtocolUpgradeRecoversOriginalTasks$'` 跑其余 app 用例并通过。随后该用例单独通过，最后整包在 `-timeout=20m` 下也通过。跳过不是功能失败，也不再是最终验证缺口。

额外执行 `go test ./... -count=1 -timeout=25m` 时，除 app 外的 Go 包基本通过，但 `internal/handler` 的 7 组真实 agent-host 集成场景失败，全部是测试启动的 Node 进程找不到本机依赖 `@earendil-works/pi-coding-agent`；错误发生在 `agent-host/server.mjs` 或对应 probe 的模块加载阶段，不涉及本步改动。按范围没有安装或改动该依赖。排除这些真实 host 场景后，`go test ./internal/handler` 通过；因此不能把 `go test ./...` 写成全量通过，真实 host 集成仍保留为环境阻塞。

第三方视频恢复问题现状：**已解决**。原任务查询、Gemini Veo query-only fallback、禁止 POST/创建、结果下载及显式缺失插件 fail-closed 断言均通过。

图片异步任务现状：**已实现并有专项假上游验证**。当前轮次 job ID 只触发 `GET /v1/images/jobs/{id}`，随后只下载结果，假上游收到 POST=0；pending 不会落到生成重放，旧轮次 job ID 不会被采用，扣费字段会按当前轮次写入后台证据。

视频扣费现状：**已实现后台事实采集和 Outcome 投影**。视频 provider 响应中的 `usage_state` 会按当前 `RouteRun` 记录；失败、待结算、已扣费分别得到 `allowed`、`blocked`、`confirm` 的投影。第三方渠道没有可核实扣费字段时保持 `confirm`。本步没有实现前端按钮、费用报价或外部调用方确认协议。

## 5. 未实现与交接边界

- 未改 `web/`，未做真实桌面客户端或前端绘制验收；新增的是后台和服务端测试。
- 未新增 `/tasks/:id/recover`，未改 MCP/CLI 工具合同，未实现 `paid_confirmation_required`、报价、`quoteId`、用户同意记录、外部付费开关。
- 未新增计费状态转移或渠道退款规则表；BeefAPI 原值是证据，第三方仍交由用户确认。
- 未调用真实 BeefAPI、真实第三方或任何付费生成；未发布、未开 PR、未合入主线。
- v2.0.5 已公开且发布流程成功，本分支只作为独立后续实现交付，不回写发布流程，也不扩大到第 4–7 步。

## 6. 回退与风险

- v27 只追加可空列；回退代码不能把已升级数据库降回 v26。若必须回退，使用升级前完整工作区备份和匹配版本程序在独立目录打开。
- 旧任务没有 `billing_evidence` 时，读投影只接受当前轮次、正式 BeefAPI 日志中的扣费字段；日志缺失或字段缺失不会猜测为未扣费。
- 图片 job 查询失败时不会把任务当成已退款，也不会为了“修复”而自动 POST；结果不明仍按既有回执/用户确认规则处理。
- 本轮测试只证明本机假上游和临时数据库中的行为，不证明生产 BeefAPI 的新协议字段、视频生产去重开关或第三方保留期已改变。
