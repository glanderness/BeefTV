# 生成任务「取回 / 重新生成 / 扣费」由后台判定：重构方案

状态：第 4 轮原方案已由用户确认（2026-10-27「没问题了 开干吧 Codex 用pi」）。本次仅修订第 3 步及其依赖的扣费事实读取，修订建议与最小实验见第 3.11 节；不表示正式实现完成或获准发布。第 4–7 步保持原范围。
依据：main `3632485`；PR #263（`tds/conv-01a1766b-…`）、#16 精简版（`tds/conv-01a17704-…`）及其四轮检查记录；Codex 两轮评审；三份调研（见第三节开头）；架构师 #30 报告 `docs/research/paid-permission-and-regenerate.md`（分支 `tds/conv-01a17917-…`，下称〔#30〕）。

**第 4 轮改了什么（用户 2026-10-27 01:05、01:09）：** 「其实我们beefapi很容易知道能不能重新跑 任务是什么状态 但是第三方渠道就不一定 所以我们应该有一个用户确认要重新跑的按钮？」「别又多造状态机了」。据此：
- BeefAPI 渠道的「能不能重新生成」**直接照读 BeefAPI 返回的扣费结论**（视频 `usage_state`、图片 `billing_state`），BeefTV 不自己推断、不另建计费状态（第 3.1 节）；
- 第三方渠道（用户自带 Key）不再逐个渠道、逐种错误登记「收不收费、退不退款」，失败且取不回时统一由用户确认重跑（第 3.1、3.4 节）；
- 删掉上一版「按派发记录推断计费」「渠道协议声明里写退费规则」「审核失败按是否计费另判」那一套，以及〔#30〕第三节的退款合同表；
- 保留〔#30〕第四、五节里的持久回执、一次同意只用一轮、结果不明只走原渠道重发、外部程序付费开关（第 3.5、3.6 节）。

## 一、结论

1. **值得重构，不是收尾 #16 就够。** 「提交成没成、结果在不在、点了扣不扣钱」现在由前端约 30 个文件、后端约 18 个文件分别推断（清单见第二节）。同一个后端接口 `POST /tasks/:id/retry` 内部有三种走法（继续下载 / 按回执免费重建 / 重新提交并扣费），前端事先不知道会走哪条，只能靠自己的推断去猜。今天四轮检查查出的问题全部出在「前端猜错了后台会怎么做」。
2. **做法一句话：后台给每个任务算一个「下一步」结论，前端只照着显示和调用。** 和 Stripe PaymentIntent 的 `status + next_action` 同一思路（〔状态〕4.1）。这个结论不是新的状态机，是在后台已有的 `taskdelivery.Project`（它已经算出 `resultState`）旁边多算几个字段，输入全部是后台已经持久化的事实。
3. **免费取回放到后台自动做。** 后台已有每 5 秒运行的取回循环（`startGenerationDeliveryRecovery` → 下载结果 → `recoverPendingCanvasBindings` 把结果写进画布节点）。只要在循环里加上「失败、可能已被上游接纳的图片任务按回执重建，重建不了就写明原因」这一步，客户 A 这类节点会被后台自动修好、写回画布，前端不需要任何自动取回代码。#16 里前端的自动取回扫描就不再需要。
4. **能不能重新生成，按渠道分两种来源，不新增状态：** BeefAPI 渠道照读 BeefAPI 返回的扣费结论——已退款就直接重新生成，还在结算就等，已扣费成功就先取回；第三方渠道失败且取不回时显示「重新生成」，点了先确认「这个渠道无法确认上次是否已扣费，重新生成可能会再扣一次」（第 3.1 节）。
5. **免费和扣费拆成两个接口：** `POST /tasks/:id/recover` 结构上不可能提交上游；`POST /tasks/:id/retry` 和带 `retryOf`、对着一个已有节点的 `POST /tasks` 是唯一会扣费的入口。可能重复扣费时，后台先返回费用预览、这次不提交；调用方在**它自己的界面**问用户（BeefTV 弹确认框，Codex / Claude Code 等外部 MCP/CLI 在它们的界面问，内置助手要用户确认过的制作方案），同意后带同一份报价和同一个 `operationId` 再提交。后台用一条数据库唯一约束保证一次同意最多提交一次，并写明：后台无法证明调用方真的问过人，能保证的是不明确声明同意就绝不扣钱。
6. **节点上 7 个字段收成 1 个**（`taskOutcome`，从任务抄过来，前端不写），另加只在「任务号还没拿到」时才存在的 `taskClientOperationId` / `generationSubmissionState` 两个字段。
7. **已带 `Idempotency-Key` 且核实上游会去重的渠道（BeefAPI 图片、超分；BeefAPI 视频待确认生产开关），「提交未确认」用同一个键、经原渠道原样重发，不算再扣钱、不问用户**（第 3.7 节）。
8. **#16 的前端改动不合并；后端的 `result_unrecoverable` 改法和全部回归测试拿来复用**（见第六节）。

## 二、盘点：现在谁在推断

数法：`rg` 搜 `submission_unknown|submission_uncertain|generationSubmissionState|resourceReloadAvailable|shouldBlockManualRetry|blockManualRetry|isKeptGenerationResultCode|taskRetryBlocked|imageSubmissionUnknown|canvasGenerationRetryBlocked`，前端（不含测试）命中 37 个文件、139 处；后端用对应词搜命中 22 个文件、66 处。下面只列真正在做判断的地方。

### 2.1 后端：一个接口多种含义

| 位置 | 判断什么 | 问题 |
| --- | --- | --- |
| `app/service.go` `RetryTask` | 成功但暂停下载 → 继续下载；失败且有回执 → 免费重建；否则 → 进入扣费重试 | 免费和扣费共用 `/retry`，调用方事先不知道走哪条 |
| `app/image_result_recovery.go` `recoverAcceptedImage` | 回执能不能用 | 只在用户手动 `/retry` 时才跑，后台从不自动跑；读库失败和回执确实不能用返回同一句话（#16 才加了 `reason`） |
| `app/image_submission.go` `validateImageTaskRetry`、`shouldDeferImageRecovery` | 派发状态 `accepted/submission_unknown` 时禁止重试；自动重发窗口 23 小时、最多 12 次 | 窗口过后任务永久卡在「失败 + 禁止重试」 |
| `app/generation_failure.go` `persistedFailureErrorCode`、`persistedFailureBlocksRetry` | 按 stage 和**错误文案**重新分类 | 靠文案分类 |
| `app/task_domain_adapter.go` `taskFailuresAdapter`、`task/lifecycle.go` `retry` | 能不能重试、拒绝时给哪句话 | 拒绝只给文案，前端只能匹配文案 |
| `app/task_terminal.go` | 何时把任务标成 `submission_unknown` | — |
| `app/task_output.go` `safePersistedFailureMessage`、`correctPersistedVODParameterFailure` | 读的时候再纠正一次分类 | 读时纠正，前后两套口径 |
| `app/task_route_executor.go`、`modelcatalog/route_attempt.go` | 派发状态 `not_sent/accepted/submission_unknown/rejected_no_job` | 这是事实来源，保留 |
| `app/media_upscale.go` `RecoverMediaUpscale` | 超分「取回原结果」：成功就交付；`not_sent` 就**调 `RetryTask` 扣费重试**；否则查上游 | 名叫取回，其中一条分支会扣费 |
| `app/provider_task_recovery.go` `QueryFailedVideoTask` | 视频/超分查上游 | 只能手动触发，图片不支持 |
| `app/task_delivery_control.go`、`handler/routes.go` `/cancel` | 对成功任务调 `/cancel` = 暂停下载 | `/cancel` 也一口两用 |
| `app/canvas_workflow_run.go` | 工作流重试失败步骤直接调 `RetryTask` / `RecoverMediaUpscale` | 又一个扣费入口 |
| `task/delivery.go` `ResultState`、`taskdelivery/project.go` | 结果是否已入库 | **已经是后台算好给前端的投影**，本方案在它上面扩展 |
| `handler/business_catalog.go` | 把 `/tasks`、`/tasks/:id/retry` 标为外部调用会计费 | 保留 |

### 2.2 前端：各自重新推断

| 位置 | 推断什么 |
| --- | --- |
| `lib/generation-error.ts`（1180 行）`explainGenerationError`、`shouldBlockManualRetry` | 把任务的错误文案**再分类一遍**，得出 `uncertain` / `blockAutomaticRetry` / `blockManualRetry`；和后端 `generation/provider_error.go`（1607 行）做的是同一件事 |
| `lib/vod-image-error.ts` | VOD 错误码 → 「提交未确认」，和 `fixtures/vod-image-errors.json` 重复 |
| `pages/canvas/canvas-generation-failure.ts` | `isKeptGenerationResultCode`、`canvasGenerationFailureMetadata`（写 `resourceReloadAvailable`）、`canvasGenerationRetryBlocked`、`canvasImageGenerationHasPendingResult`、`imageSubmissionUnknown`（同时看 3 个字段）、`canvasGenerationTaskNodes`（算暂停/保留取回/是否完成） |
| `lib/generation-task-display.ts` | 按 stage 判断「提交待确认」「待取回」 |
| `lib/canvas/canvas-generation-task-sync.ts` `generationTaskCanReloadResource` | 能不能继续取回 |
| `lib/canvas/canvas-ai-upscale-task.ts` | 超分有没有挂起的付费任务、失败后写 `resourceReloadAvailable` |
| `lib/canvas/canvas-depth-capture.ts` `canvasNodeFailureExplanation` | 深度任务覆盖 `blockManualRetry` |
| `lib/canvas/canvas-project-generation.ts` | 写 `generationSubmissionState`；`canvasNodeNeedsGenerationRecovery` |
| `lib/canvas/canvas-node-task-state.ts` `isCanvasNodeGenerating` | 节点算不算生成中 |
| `lib/canvas/canvas-image-batch-retry.ts` | 批次重试时搬运 `resourceReloadAvailable` |
| `pages/canvas/use-canvas-generation.ts` | 加载时恢复扫描；查不到任务时**客户端自己写** `generationSubmissionState: "unknown"`；`applyGenerationTaskResult` 写 `resourceReloadAvailable` |
| `pages/canvas/use-canvas-generation-retry.ts` | 视频直接调 `/retry`；其他按 `canvasGenerationRetryBlocked` / `shouldBlockManualRetry` 决定是否带 `retryOf` |
| `pages/canvas/use-canvas-generation-executor.ts` | 提示词面板「生成」前查挂起提交；重复内容确认框 |
| `pages/canvas/canvas-image-generation-executor.ts` | 用户停止等待时写 `resourceReloadAvailable: true` + `generationSubmissionState` |
| `pages/canvas/use-canvas-resource-handoff.ts` `reloadCanvasNodeResource` | 「继续取回」：先查任务，暂停下载就调 `/retry` |
| `pages/canvas/use-canvas-media-tools.ts` | 深度任务失败时**客户端写** `taskStage: "submission_unknown"`；超分取回调 `/media-upscale/.../recover` |
| `pages/canvas/use-canvas-upscale-batch.ts` | 写 `generationSubmissionState` |
| `pages/canvas/canvas-generation-orchestration.ts`、`use-canvas-generation-batches.ts` | 批次里哪些子节点可重试 |
| `components/canvas/canvas-node-content.tsx` `ErrorContent` | 错误卡上「重新生成」按 `uncertain` 隐藏，「继续取回」按 `resourceReloadAvailable` 显示 |
| `components/canvas/canvas-node.tsx` | 批次子节点按钮按 `shouldBlockManualRetry` 判断——和错误卡**来源不同**（#16 说明里已指出） |
| `components/canvas/canvas-node-prompt-panel.tsx`、`components/generation/generation-failure-notice.tsx` | 缺提交标识、是否显示重试 |
| `pages/tasks/task-shared.tsx` 及 `index.tsx` 等 4 个文件 | 任务中心 `taskRetryBlocked`、单条与整组扣费重试 |
| `pages/canvas/canvas-project-status-dialogs.tsx`、`services/api/task-center.ts` `canRetrieveVideoResult` | 视频能否查上游 |
| `pages/create/creation-workspace.tsx` | 创作页是否显示重试 |
| `services/api/generation-submission.ts` `submissionAcceptanceUnknown` | 按 HTTP 状态猜提交成没成 |
| `services/canvas-generation-consumer.ts` | 哪些入库错误算永久失败 |

节点元数据里同时描述成败的字段：`status`、`generationErrorCode`、`resourceReloadAvailable`、`generationSubmissionState`、`taskStatus`、`taskStage`、`taskErrorCode`，其中 `generationErrorCode`、`resourceReloadAvailable`、`generationSubmissionState`、部分 `taskStage` 由前端自己写。

`git log --since=2026-08-01` 里标题含「取回 / 恢复 / 未确认 / 重复 / 扣费 / 重试 / 回执」等词的提交有 86 个（粗数，含发布回执、助手等无关项）；逐个打开核对过的同类修复见第五节。

## 三、设计

本节在第 3 轮按三份调研修改。引用简称：

- 〔状态〕= 生成任务状态与取回调研，`docs/research/generation-task-prior-art.md`（分支 `tds/conv-01a1789f-2760-…`）；
- 〔外部〕= 外部 MCP/CLI 确认扣费调研，`docs/research/mcp-paid-confirmation.md`（分支 `tds/conv-01a1789f-2e99-…`）；
- 〔防重〕= 付费防重调研，`docs/research/paid-retry-idempotency.md`（分支 `tds/conv-01a1789f-36b0-…`）。

调研里标「推断」的，下面照样标【推断】；标「未核实」或经搜索摘要转述的，标【未核实】。本轮我自己读代码或原文核对过的，标【已核】。

### 3.1 后台给出「下一步」：`task.outcome`

在任务的读接口（`GET /tasks/:id`、列表、订阅推送、`by-operation`）上增加一个字段，和现有的 `resultState`、`outputs` 在同一个投影函数里算：

```go
// backend/internal/task/outcome.go（新文件，纯函数，表格测试）
type Outcome struct {
    Phase      string `json:"phase"`      // running | fetching | ready | retrievable | failed
    Regenerate string `json:"regenerate"` // allowed | confirm | blocked
    Reason     string `json:"reason"`     // 机器原因，前端只用来选文案
}
```

上一版的 `retrieve: auto | manual` 已删掉。依据〔状态〕5.2 第 3 条、5.3 第 1 条：看过的商用 API 和开源工具都没有「需要人工继续取回」这种状态，结果要么还能查到，要么过期没了。`manual` 只是因为上一版的退避有固定上限才出现的；改成按渠道保留期一直自动查（第 3.2 节）后，`retrievable` 就只剩自动这一种【推断，〔状态〕】。形状和 Stripe PaymentIntent 的 `status + next_action` 一样小（〔状态〕4.1）。

| phase | 含义 | 用户看到的 | 能做什么 |
| --- | --- | --- | --- |
| `running` | 排队、生成中，或后台在按回执/查上游自动取回 | 现有进度条 | 只能取消 |
| `fetching` | 已生成，后台在下载/入库 | 现有「正在取回结果」+ 大小、速度 | 停止取回 |
| `ready` | 结果已入库 | 成片 | — |
| `retrievable` | 结果大概率还在，后台在保留期内自动取回 | 「正在取回」 | 不用点，界面上不放取回按钮（第 4 轮：免费取回自动做、不需要按钮）。`/recover` 接口保留给 MCP/CLI 和排障用（第 3.2 节） |
| `failed` | 确定没有可取回的结果 | 失败原因 | 按 `regenerate` 决定 |

`regenerate` 回答的问题是「**这个节点的结果还没到手时**，再新建一个付费任务会不会重复花钱」。结果已经到手（`ready`）后用户主动再生成，不归它管。

第 4 轮起，「扣没扣钱」不再由 BeefTV 推断，按渠道分两种来源（用户 2026-10-27：「beefapi很容易知道能不能重新跑 任务是什么状态 但是第三方渠道就不一定」）：

**(1) BeefAPI 渠道：照读 BeefAPI 的扣费结论。** 判断是不是 BeefAPI 渠道用现有函数：视频 `generation/video_options.go` 的 `IsBeefAPIVideoConfig`，其他用 `generation/url.go` 的 `IsBeefAPIHost`，不另写一套。BeefAPI 已经返回下面这些字段，BeefAPI 不用改代码【已核，BeefAPI `codex-enhance` `b9343cb`】：

| BeefAPI 返回 | 出处 | BeefTV 的 `regenerate` |
| --- | --- | --- |
| 视频 `usage_state = failed`（结算为失败或已退款） | `model/task.go` `TaskUsageDisplayOf`：已结算且任务失败或 `billing_state = refunded` 时为 `failed` | `allowed`：直接重新生成，不弹「可能重复扣费」 |
| 视频 `usage_state = pending`（还没结算） | 同上，未结算一律 `pending`；同时返回 `reconcile_deadline` | `blocked`：不让重新生成，显示「BeefTV 正在核对上次提交，预计 {时间} 前有结论」（时间取 `reconcile_deadline`），后台照常轮询 |
| 视频 `usage_state = completed`（成功并扣费） | 同上 | 先取回（`retrievable`）；结果已到手后用户想再来一版，是 `ready` 后的正常新生成 |
| 图片 `billing_state = refunded` | `controller/image_jobs.go` `GetImageJob`；取值见 `model/task_billing.go` | `allowed` |
| 图片 `billing_state = settled` | 同上 | 先取回；到手后再来一版是正常新生成 |
| 图片 `billing_state` 字段存在但值为空（BeefAPI 支持查询、还没结算） | 同上，`ImageRecovery` 非空时 `resp["billing_state"]` 一定写入，空串即未结算 | `blocked`，同视频 `pending` |
| 图片拿不到 job id，或 `GetImageJob` 返回体里**没有** `billing_state` 这个键（BeefAPI 不提供这类图片的扣费查询） | 见下面「图片要先拿到 job id」 | 不当作「未结算」，按 (2) 第三方处理：取不回就 `confirm` |

依据 BeefAPI 运维手册 `docs/runbooks/video-submission-hardening.md` 第 18、20 行【已核】：上游明确拒绝（400/401/402/403/404/413/422/429）或出网前失败，沿原任务退款一次；已经开始发送、结果不明的转入核对，不自动重放。所以 BeefAPI 报 `failed / refunded` 就是钱已经退回或没扣，BeefTV 不用再分析错误类型。

读取这些字段要注意两点【已核】：
- **视频要换查询路径。** BeefTV 现在查 BeefAPI 视频走 `GET /v1/videos/{id}`（`generation/video.go` 第 127、261 行，`generation/video_task_query.go` 第 51 行）。BeefAPI 对这个路径走 OpenAI 兼容格式（`relay/relay_task.go` 第 689、702 行 `isOpenAIVideoAPI` → `ConvertToOpenAIVideo`），返回体里**没有** `usage_state`、`reconcile_deadline`。同一个任务用 `GET /v1/video/generations/{id}` 查，走第 732 行起的 `TaskModel2Dto`，才带这几个字段。两条路由都在 `router/video-router.go`，GET 不选渠道、不经提交去重（`middleware/distributor.go` 第 1186–1202 行，`middleware/video_submission.go` 第 77 行只拦 POST），是只读查询。实施时 BeefTV 读扣费结论改用后一个路径，现有下载流程不动。
- **图片要先拿到 job id，而且只有一部分图片支持扣费查询。** `billing_state` 只在 `GET /v1/images/jobs/{job_id}` 里返回，而且只对走了「可恢复同步图片」的任务返回（`image_jobs.go` 第 246–248 行要求 `ImageRecovery` 非空）。原方案核实的这类任务是腾讯 VOD 同步图片（`service/sync_image_recovery.go` 的 `IsDurableSyncImage`：`APITypeTencent`、Key 以 `vod|` 开头、非 playground、有 token、无自定义计费）；其他同步图片未必有 job id，普通异步图片即使有 job id，`GetImageJob` 也不带 `billing_state`。job id 由 BeefAPI 在原响应头 `X-Image-Job-Id` / `Location` 里给出，处理中、失败的错误体里也带 `task_id`。第 3 步复核：BeefTV `e08b6bea` 已保存响应头中的身份到 `ApiCallLog.ImageJobID`，并增加手动 job 查询；还没有完成当前轮次扣费事实存储和自动恢复复用，不能继续列作“尚未读取响应头”。
  判定规则对新旧任务一样，只看 BeefAPI 实际给了什么：**有 job id 且成功查询的返回体里有 `billing_state` 键**，才按上表照读（空值 = 未结算，`blocked`）；**没有 job id，或成功响应没有这个键**，按不提供此类扣费查询处理，不能当成「未结算」一直等。图片可恢复同步任务的查询响应还可能只有 `result_url`，需要再 GET 该结果端点并解析 JSON 图片结果，不能把这个 JSON 端点当作图片地址。

  **第 3 步复核更正：**视频 `TaskDto.usage_state` 没有 `omitempty`，不代表整个接口每个分支都有这个键。BeefAPI `be8f7072` 的 `tryRealtimeFetch → realtimeTaskResponse` 可以提前返回不含扣费字段的响应；原方案引用的 `b9343cb` 已有同一分支。正常 DTO 还包在 `{code,data}` 中。应按实际响应读取，不能只改 URL。成功查询但缺键按未提供事实处理；网络失败不是“字段不存在”，保留同轮已有事实等待下次查询，没有已有事实时保持未知。来源与夹具见[第 3 步复核](../research/generation-task-state-step-3-recheck.md)。

结果不明的 BeefAPI 图片仍按第 3.7 节用同一个 `Idempotency-Key` 经原渠道重发，那是取回，不是重新生成。

**(2) 第三方渠道（用户自带 Key、插件、直连火山 / 可灵 / Runway 等）：失败且取不回就由用户确认。**
- 有上游任务号的，后台先按任务号查（第 3.2 节）；查到还在跑或有结果，`blocked`，不给重新生成。
- 查完确定取不回（上游返回失败、过了保留期、没有任务号也查不了）：`confirm`。错误卡上显示「重新生成」，点了先确认：「这个渠道无法确认上次是否已扣费，重新生成可能会再扣一次」。不再按渠道、按错误码区分收不收费、退不退款。
- 唯一例外是请求根本没离开 BeefTV（派发状态 `not_sent`、`request_not_sent`）：`allowed`。这是 BeefTV 自己记的事实，不是对上游计费的推断【本轮判断，请架构师确认是否保留】。

| 任务状态 | `regenerate` |
| --- | --- |
| `running` / `fetching` / `retrievable` | `blocked`：结果可能还在，先取回 |
| `ready`（已有成片） | `allowed`：用户主动再生成是新的一次生成。现有「已有图片原位生成、保留旧版本」（`canvas-image-generation-executor.ts`）和「相同内容再次生成」确认框（`use-canvas-generation-executor.ts`）照旧 |
| `failed`，BeefAPI 渠道 | 照上面第一张表 |
| `failed`，第三方渠道，请求没发出 | `allowed` |
| `failed`，第三方渠道，其余 | `confirm` |
| `failed`，BeefAPI 报已扣费（`completed` / `settled`）但结果确实取不回 | `confirm`，文案写「上次已扣费，但结果拿不回」 |

上一版这里的「确认未计费的三种情况」「渠道协议声明里写退费规则」「审核失败按是否计费另判、比较内容指纹」都删掉。审核未通过的任务：BeefAPI 渠道照读它的结论（上游 4xx 拒绝它会退款，`failed` → `allowed`）；第三方渠道和其他失败一样是 `confirm`，用户改不改输入都要确认一次。这样不再需要内容指纹。

对着已有节点的新提交（包括 `/retry`、带 `retryOf` 的提交、提示词面板的「生成」）一律按节点当前任务的 `regenerate` 判，改没改输入都一样：`blocked` 拒绝；`confirm` 必须带用户同意（第 3.4 节），否则不提交；`allowed` 放行。后台守门照旧，因为 2026-10-26 查出提示词面板能绕过前端确认框（#16 第 1 轮 P1）。

输入全部是已持久化的事实：任务 `status/stage`、`routeRun`、最近一次 `RouteAttempt.DispatchState`（只用来判断「请求没发出」和「结果不明能不能同键重发」）、图片创建回执、`ProviderRequestID`、`outputs` 的入库状态，以及 BeefAPI 返回的 `usage_state` / `billing_state` / `reconcile_deadline` 原值，加已有的 `recovery_outcome`（第 3.2 节）。扣费事实作为当前任务的一份可空结构保存，包含字段是否存在及所属生成轮次、上游任务身份；不从“这个任务号的最新一条日志”反查授权依据。具体写入与替换规则见第 3.11 节。计算不读错误文案。

这不是第二个状态机：没有新的状态转移，`Outcome` 是对已有事实的只读函数；`resultState` 并入 `phase` 的计算，过渡期两个字段都返回。ComfyUI `/api/jobs/{id}` 也是每次读取时从队列和历史现算状态（〔状态〕3.1、4.1）。

### 3.2 免费取回：后台自动做

在现有取回循环 `startGenerationDeliveryRecovery`（每 5 秒）里加一步「失败但可能可取回的任务」：

- 图片：扫描范围是**所有**「`failed` 且可能已被上游接纳」的图片任务，不要求回执完整，也不要求有路由记录。判定「可能已被接纳」的依据，满足任一条即可：最近一次派发状态是 `accepted/submission_unknown`；`stage = submission_unknown`；存在任何一条图片创建回执（包括没有路由记录的历史任务，`TestRetryAcceptedImageUsesOriginalReceiptWithoutCreate` 就是这种，必须继续能恢复）。对每个任务调 `recoverAcceptedImage`：回执完整就重建，成功后任务变成 `succeeded`，后面完全走已有的下载 → `recoverPendingCanvasBindings` 写回画布；回执缺失或不完整就按下面的分类写结论，不会被扫描漏掉、停在没有出口的状态。
- 视频 / 超分：`failed` + 有 `ProviderRequestID` → 按退避调 `queryFailedVideoTask`。这是查询请求，不创建上游任务。**截止时间按渠道的结果保留期定**，不再统一 24 小时，见下表。
- 已有的「成功但未入库」继续走原逻辑。

截止时间改动依据〔状态〕2.4、5.2 第 1 条：渠道返回的结果保存时间不同，不能统一设为 24 小时。第 3 步修订建议：在现有协议声明中区分“结果本身不可取回的期限”和“下载链接失效时间”；只有核实过的前者可用于写 `recovery_outcome = unrecoverable`，后者先重新查询原任务。扫描不能用时间 WHERE 把任务直接过滤掉，必须先处理到期结论；未知期限保持现有退避查询，不凭摘要填一个默认期限。下表是历史调研线索，不是已生效的配置，也不能直接作为各视频渠道的验收合同：

| 渠道 | 保留期 | 来源与核实情况 |
| --- | --- | --- |
| OpenAI 后台任务（Responses `background`） | 约 10 分钟（`store=true` 才更久） | 〔状态〕2.4 原文引用 |
| Replicate | 1 小时后输入输出被删除 | 〔状态〕2.4 原文引用 |
| 火山方舟视频 | `video_url` 24 小时有效；任务记录 7 天后清除，只能查最近 7 天；`execution_expires_after` 默认 48 小时（可设 1–72 小时），超时状态变 `expired` | 〔状态〕标「经搜索摘要转述」。本轮再查：官方页面正文抓不到，搜索结果仍是对官方三页（[查询任务](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)、[创建任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)、[任务列表](https://docs.volcengine.com/docs/ark/list-video-generation-tasks-api?lang=zh)）的摘要，**仍未逐字核对原文**【未核实】 |
| 可灵 | 生成的图片/视频 30 天后删除 | 〔状态〕标「经搜索摘要转述」。本轮再查：官方页面抓取只拿到标题，搜索摘要称 [Omni 旧版](https://kling.ai/document-api/api/video/o1/video-omni/legacy)、[文生视频](https://kling.ai/document-api/apiReference/model/textToVideo)、[图生视频](https://kling.ai/document-api/apiReference/model/imageToVideo) 的 `url` 字段都写了 30 天，**仍未逐字核对原文**【未核实】 |
| Runway | 输出链接「will expire within 24-48 hours of accessing the API」；没写文件本身保留多久 | 〔状态〕只写了「临时」。本轮直接读到 [Outputs](https://docs.dev.runwayml.com/assets/outputs/) 页面原文【已核】；状态集合和轮询建议仍来自搜索摘要【未核实】 |
| fal.ai | 按用户的媒体过期设置；过期后永久删除 | 〔状态〕2.4 原文引用 |

火山方舟这类「链接 24 小时、任务 7 天可查」的，重新查询能不能拿到新链接文档没写，要先实测再定截止按哪个算（〔状态〕2.4【推断】）。BeefAPI 自己的图片回执保留 24 小时（BeefAPI 仓库 `service/image_receipt.go` 的 `ImageReceiptRetention = 24 * time.Hour`【已核】），BeefTV 现有 `imageRecoveryLifetime = 23h` 正是为它留的余量。

每次尝试用已有的 `ClaimFailedTaskProviderRecovery` 租约，多处同时触发也只有一个执行。结果分四种写回，其中「拿不回」细分成两种，因为对用户意味着不同的事：

- 取回成功：任务变 `succeeded`；
- **确定上游没有结果**（上游明确返回失败、明确拒绝、确认没接纳）：写 `recovery_outcome = no_result`，`phase = failed`。「没有结果」不等于「没扣钱」，`regenerate` 按第 3.1 节判：BeefAPI 渠道照读它的 `usage_state` / `billing_state`，第三方渠道除「请求没发出」外一律 `confirm`；
- **系统无法取回**（回执缺失、回执不完整、多条冲突回执、过了渠道保留期；上游可能已经生成并计费，只是这边拿不到）：写 `recovery_outcome = unrecoverable`。`phase = failed`；`regenerate` 同上：BeefAPI 渠道报已退款（`failed` / `refunded`）的是 `allowed`，报未结算（`pending` / 明确返回空 `billing_state`）的是 `blocked`、不论等多久，报已扣费的是 `confirm`；第三方渠道和 BeefAPI 不提供扣费字段的任务按第 3.1 节 (2) 是 `confirm`。`confirm` 时文案写明「上次可能已生成并扣费，但结果拿不回」，并保留「查看原任务」；
- 暂时失败（读库出错、锁冲突、存储配额、网络）：什么都不写，下次再试，直到过了保留期。

只有前两类拿不回的持久化事实能让 `phase` 变成 `failed`。#16 后端打 `result_unrecoverable` 的几处，按上面拆成这两类写入。`recovery_outcome` 只回答「结果还在不在」；「扣没扣钱」BeefAPI 渠道读 BeefAPI，第三方渠道不判断、交给用户确认（第 3.1 节），两者分开存、分开判。超时只能决定「不再等」，不能决定「结果不存在」（〔状态〕3.4 midjourney-proxy 的反面例子）。

BeefAPI 渠道在同一个循环里顺带刷新扣费结论：任务 `failed` 或停在结果不明时，按第 3.1 节的只读路径（视频 `GET /v1/video/generations/{id}`、图片 `GET /v1/images/jobs/{job_id}`）读一次 `usage_state` / `billing_state` / `reconcile_deadline` 存进任务；`pending` 时按退避继续读，变成 `failed` / `refunded` 后 `regenerate` 自然变成 `allowed`，不需要用户做什么。没有 job id、返回体里没有扣费字段的任务不进这个轮询，直接按第三方处理。

`POST /tasks/:id/recover`：留作「立即再查一次」的入口（例如本地存储满了、用户清理后想马上取，〔状态〕5.2 第 3 条；BeefTV 界面不放按钮，给 MCP/CLI 和排障用），做同一件事并重置退避，不是常规操作。这个处理函数里**不引用** `store.Retry` / `RetryTask` / 任务接纳，在代码结构上就不可能新建任务。验收不按 HTTP 方法判断——现有免费取回本身就会用 POST：超分 `RecoverUpscaleResult` 调原任务的 `/recover`（`generation/upscale.go`），RunningHub 查结果也是 POST。测试断言的是：上游 mock 只收到查询/取回类请求（按协议声明的 request kind 是 `poll`/`query`/`recover`，没有 `create`）；上游任务号始终是原任务的 `ProviderRequestID`；本地任务表没有新增任务，原任务的 `routeRun` 不变。它合并现在分散的三个入口：`/retry` 里的继续下载和回执重建、`/tasks/:id/query-provider`、`/media-upscale/tasks/:id/recover` 里的取回分支。

**重启时不把执行中的任务改成取消。** 依据〔状态〕3.2、5.2 第 4 条：InvokeAI 启动时把 `in_progress` 一律改成 `canceled`，是因为它的计算在本进程里；BeefTV 的上游任务在别人的服务器上，重启后可能还在跑、甚至已出结果，不能照搬。现在的代码【已核】已经是这么做的：
- `repository.go` 的 `ClaimNextTask` 领取条件是 `status = queued` 或「`status = running` 且租约已过期」，重启后旧租约（默认 45 秒）一过期，`running` 任务就被重新领取，状态不改成取消；
- 重新领取后，`modelcatalog/route_attempt.go` 的 `DecideExistingAttempt` 按最近一次派发记录决定：有上游任务号就 `AttemptReuseAccepted` 接着查（`generation/executor.go` 里 `ResumedProviderRequestID` 非空时不进入 create 分支）；`submission_unknown` 且没有任务号就停在「上一次提交结果不明确，为避免重复创建上游任务已停止自动重发」，不重发；图片有 `ImageSubmission` 记录时按原字节、原键恢复。
方案保持这个行为，只把它写成显式约束，并在第 1 步的表格测试里加「重启后 `running` 任务不变成 `cancelled`」一条。

### 3.3 扣费入口：后台守门

会新建上游任务的只有三条路：`POST /tasks/:id/retry`、带 `metadata.retryOf` 的 `POST /tasks`、对着已有画布节点的 `POST /tasks`。〔外部〕第 2 节指出，business tools 直接暴露了 `/tasks`、`/tasks/:id/retry`（`handler/business_catalog.go`），只改 `canvas.generation.submit` 不够，这三条路都要过同一道检查。后台统一检查：

1. 先找出**目标节点当前的任务**：任务表里「目标为这个画布、这个节点」的最近一个任务（任务输入里已有目标节点，见 `TargetBindingFromInput`，实施时加成可索引的列）。批次和多输出提交按 `outputNodeIds` 展开，每个目标节点都要查。不依赖前端或画布文档告诉后台节点以前生成过什么。
2. 带了 `retryOf`（或走 `/retry`）时，`retryOf` 必须**等于**目标节点当前的任务，且这个任务的目标节点就是本次的目标节点；不一致就拒绝（409，返回当前任务的 `outcome`）。这样旧快照指着失败任务 A、节点其实已经提交了任务 B 时，调用方没法拿 A 绕过 B 的检查。
3. 按第 3.1 节的表判当前任务的 `regenerate`：
   - `blocked` → 409，返回最新的 `outcome`，前端照着刷新显示；
   - `confirm` → 请求里必须带有效的同意（第 3.4 节），否则返回 `paid_confirmation_required` 和费用预览，**这次不提交上游**；
   - `allowed` → 放行。
4. 第 1–3 步的读取和核对、同意记录的写入，与新任务的接纳**放在同一个事务里**（现有 `retryTask` 已用 `withImmediateTransaction`，接纳新任务也要放进同一种写事务）。两个并发请求不会都看到「当前任务是 A」然后各建一个新任务。依据〔防重〕2.2 AWS Builders' Library 原话：记录幂等 token 和所有变更必须是一个 ACID 操作。

**`/retry` 被重复提交（双击、网络重试）返回上一次的结果，不返回 409。** 依据〔防重〕4.2 第 ① 条、Google AIP-155「If a duplicate request is detected, the server should return the response for the previously successful request」。现状【已核】：`repository/local_runtime.go` 的 `retryTask` 用 `WHERE status IN (failed, cancelled)` 条件更新，第二次点击匹配 0 行，返回 `ErrTaskNotRetryable`（`lifecycle.go` 里转成 `RetryNotRetryableMessage`）——不会多扣钱，但用户看到一次失败。改法：`/retry` 和所有对着已有节点的付费提交都**必须**带 `clientOperationId` 和它看到的 `(taskId, routeRun)`（〔#30〕4.2 节「稳定操作 ID 是所有新收费接纳的必填项，不限 `confirm`」）。后台按「同一用户、同一提交标识」查持久回执（第 3.6 节），第二次带同一标识时直接返回那一轮的任务（含它当前的 `outcome`）。缺这两个字段的付费提交，守门生效后（第四节第 5 步）一律拒绝，返回 `operation_id_required`，提示刷新页面或升级，不执行、不扣钱；后台不替旧客户端生成操作 ID，也不靠「`routeRun` 恰好大 1」去猜是不是重发——一轮很快结束后旧客户端的网络重发会被猜成新购买。免费取回不受这条限制。

另外三处随之调整：
- `/retry` 不再做回执重建和继续下载（已挪到 `/recover`），只做扣费重跑。旧客户端的「继续取回」也调 `/retry`，所以过渡期的处理见第四节，不能直接删。
- `RecoverMediaUpscale` 里 `not_sent → RetryTask` 的分支删掉，改为 `outcome.regenerate = allowed`，由用户走扣费入口。
- 工作流「重试失败步骤」（`canvas_workflow_run.go`）同样先过这道检查。

提示词面板、悬浮工具条、错误卡、批次子节点、任务中心、内置助手、外部 MCP/CLI——不管哪个入口，过的都是同一道检查。

### 3.4 用户同意：谁来问、后台存什么

上一版要求「确认只能在 BeefTV 桌面上申请，外部程序一律 403/409」，本轮删掉。用户原话（2026-10-26）：「要是有人想用mcp调用beeftv beeftvcli呢 肯定是他们的页面上面确认啊 比如说codex调用beeftv codex就会寻求用户的确认」。依据〔外部〕结论第 1、4 条、7.1 节：MCP elicitation 本来就是服务端经客户端向用户询问的机制，Codex、Claude Code 都支持；现有 `canvas.generation.submit` 也已经写明「外部 MCP/CLI 由调用方审批」（`operations/generation_submit.go`）。

**流程（三类调用方共用同一个后台合同）：**

1. 调用方发起会扣费的提交。节点当前任务是 `confirm` 而请求里没有有效同意时，后台返回 `paid_confirmation_required`，附一份**费用预览**，并明确告诉用户「这次还没有开始生成」。
2. 调用方在**它自己的界面**问用户：
   - BeefTV 自己的界面：错误卡上的「重新生成」按钮就是这个确认入口（用户 2026-10-27：「我们应该有一个用户确认要重新跑的按钮」），点了弹现有的确认框，文案按第 3.1 节：第三方渠道写「这个渠道无法确认上次是否已扣费，重新生成可能会再扣一次」，BeefAPI 渠道已扣费但拿不回的写「上次已扣费，但结果拿不回，重新生成会再扣一次」。不新增其他按钮；
   - 外部 MCP / CLI（Codex、Claude Code 等）：在它们的界面上问，方式见第 3.5 节；
   - 内置助手：照旧要用户确认过的制作方案（`SubmitAuthorizedGeneration` 只认用户确认过的方案，#261），**助手不能自己签**。方案卡里包含 `confirm` 节点时，方案卡要显示这些节点的费用预览，用户确认方案即视为对这几个节点的同意。
3. 用户同意后，调用方带着**同一份报价**（`quoteId`）和**同一个 `operationId`**（即 `clientOperationId`）再次提交。后台在接纳事务里核对报价没被换、没涨价、输入没变，写入同意记录、接纳新任务。

**费用预览**的内容依据〔外部〕6.1 节，扩展已有的 `canvas.generation.propose`（它已返回模型、节点、`proposalId` 和两个版本号，但没有金额，〔外部〕第 2 节【已核于该调研】）：

- 原任务、画布、全部目标节点、生成数量、模型、渠道（给用户看时显示渠道的显示名，不显示渠道 ID；BeefAPI 预置渠道的显示名本来就是「BeefTV」，`providerpreset` 测试里断言 `DisplayName == "BeefTV"`【已核】）；后台保存完整输入指纹；
- `willSubmitUpstream`、`mayChargeAgain` 由后台计算，不能由调用方或模型自填；
- 费用：单位（积分 / 人民币 / 上游币种分开，不假设兑换比例）、预计值、能否硬限上限、价格来源和版本。**不确定就写「未知」并写明计费依据，不能写 0**；只有估算不能叫「最高扣费」；
- 写明「原任务可能已经扣过一次」，但不写成「已确定扣过」（BeefAPI 返回 `completed` / `settled` 的除外，那是已确定扣过）；
- 报价的有效期、画布与模型配置版本、原任务的 `routeRun`、`operationId`、调用者。

报价 `quoteId` 只证明「报价没被换掉」，**不能单凭拿到它就视作用户已同意**（〔外部〕结论第 5 条、6.1 节）。

**后台能保证什么、不能保证什么**（依据〔外部〕结论第 3 条、6.5 节，这一段要原样写进 business tools 说明）：

- 后台**无法证明**调用方真的问过人。标准 MCP 没有可验证的「真人已确认这笔金额」证明；form 的 `accept`、CLI 的 `--confirm`、调用方的同意声明都来自调用程序。Claude Code 的 elicitation hook 甚至可以程序化地直接回答 `accept`（〔外部〕4.2 节）。
- 后台**能保证**的是：**调用方不明确声明同意，就绝不扣钱**；一次同意最多接纳一次约定的生成操作；同一操作重放返回原结果；换输入、换报价、涨价，原同意失效。
- 后台把外部同意记录成「调用方报告已取得用户同意」，不记成「服务端独立核实了人工点击」。只读令牌不能靠请求体里的 `confirmed` 获得写权限（〔外部〕6.5 节）。
- 如果以后要求「即便调用方恶意也绝不能擅自消费」，那是更强的需求，要用独立认证的确认页面或可信签名凭据，或者干脆不给该客户端付费权限（〔外部〕6.5 节）。本方案不做。

### 3.5 MCP 工具和 CLI 怎么暴露「这次会再扣钱」

依据〔外部〕第 6 节，以下为建议，未实现。现状【已核】：`cmd/beeftv/main.go`、`business.go` 注册 MCP 工具时只填了 `ReadOnlyHint`，没有 elicitation 调用、没有费用确认对话、没有 `structuredContent`。

**工具分开**（〔外部〕6.2 节）：

| 工具 | 行为 | 标注 |
| --- | --- | --- |
| `task.get` / 费用预览 | 返回事实、`outcome`、费用和报价，不发生成请求 | 真正纯读才标 `readOnlyHint=true`；签发报价若产生用户可见状态，按实际副作用标 |
| `task.recover`（建议名称） | 只取回原结果，绝不转成新生成 | 免费不等于只读，标 `readOnlyHint=false` |
| `canvas.generation.submit` / `task.regenerate`（后者为建议名称） | 带报价与稳定 `operationId` 的付费执行，过第 3.3 节的检查 | `readOnlyHint=false`；Claude Code 加 `_meta: {"anthropic/requiresUserInteraction": true}` |
| business 直连工具、原始 HTTP | 过同一道费用和授权检查 | 不能因为没走新工具就免确认 |

MCP 标准注解（`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`）规范原话是「all properties in ToolAnnotations are hints」，**不是付费审批开关**，也没有金额字段（〔外部〕3.2 节）。工具说明里直接写「新建生成，按所选渠道收费；原任务可能已经收费」；每次的金额放在报价、elicitation 信息和执行参数里，不靠修改 `tools/list` 冒充逐笔报价。

**各客户端怎么问**（〔外部〕第 4 节、6.3 节）：

- **Claude Code**：对付费执行工具加 `anthropic/requiresUserInteraction: true`，官方说明这会让每次调用都要人工审批，普通 allow 规则和 `auto` / `bypassPermissions` 都跳不过（〔外部〕[A1]）。这是 Anthropic 私有扩展，不是所有 MCP 客户端的合同。
- **Codex**：安装说明里给用户一个配置示例，对付费执行工具设 `approval_mode = "prompt"`（〔外部〕4.1 节），不能静默替用户改配置。Codex 源码在「需要审批但审批策略为 never」时拒绝调用而不是放行（〔外部〕[C6]）。
  ```toml
  [mcp_servers.beeftv.tools."task.regenerate"]
  approval_mode = "prompt"
  ```
- **支持 form elicitation 的客户端**：执行付费工具时，后台用冻结的报价组一条 form，金额和风险是展示文字，回答只用一个布尔值，不预选同意。只有 `action=accept` **且** `confirmed=true` 才算同意；拒绝、取消、超时、断线都不算。`2025-11-25` 用 `elicitation/create`，`2026-07-28` 用 `inputRequests` / `inputResponses`，两种由协议适配层承载，业务合同只有一份（〔外部〕3.3 节）。当前 `go-sdk v1.8.0` 对新版的兼容性未验证【未核实，〔外部〕】。
- **没有 elicitation 的客户端**：返回结构化的 `paid_confirmation_required`（同时给 `structuredContent` 和等价文本），给用户读的文字写「这次还没有开始生成」；调用方用自己的对话或审批界面问用户，再带同一报价、同一 `operationId` 和同意声明提交。拿不到同意就停，不自动改成已确认。`paid_confirmation_required` 是 BeefTV 业务原因，不冒充 JSON-RPC 标准错误码（〔外部〕6.3 节）。
- **Cursor、Claude Desktop**：URL 模式、`2026-07-28` 支持情况未找到官方承诺，列为待实测，先按「没有 elicitation」的路径兜底【未核实，〔外部〕第 4 节】。
- 同时开 form elicitation 和 `requiresUserInteraction` 可能问两遍；按客户端选一种，并写明由调用方承担取得同意的责任（〔外部〕6.3 节）。

**CLI**（〔外部〕6.4 节，命令为建议，现在不存在；现有 `ops call` / `business call` 照样要过后台检查）：

```sh
beeftv task regenerate task_example --preview --json                            # 只预览
beeftv task regenerate task_example --quote q_example --op-id op_example         # 人在终端：显示报价后在 TTY 里问
beeftv task regenerate task_example --quote q_example --op-id op_example --confirm --json  # 外部助手已在自己界面取得同意
```

- 人用终端时显示模型、数量、费用（或「未知」）、原任务可能已收费，再明确问；回车不默认成同意。
- 非交互环境默认返回需确认的 JSON 和非零退出码，不等待 stdin，不自动接受；沿用现有 precondition 退出码 `5`（`cmd/beeftv/main.go` 的 `exitPrecondition = 5`【已核】）。
- `--confirm` 表示**调用方声明已经取得本次同意**，不是 BeefTV 核实了终端前有人。不做一个全局 `--yes` 解锁以后所有消费。
- 网络失败后保留同一 `operationId`、报价和输入，先查原接纳结果，不换成另一次购买。

**外部程序单独一个「允许发起付费生成」开关，默认关。** 依据〔#30〕第五节（用户已看过，未反对），替代第七节原第 5 条的两选一：
- 每个登记客户端加 `canSubmitPaidGeneration`，界面叫「允许发起付费生成」，新旧登记缺省都是关；只在 BeefTV 桌面设置里开关，外部客户端不能给自己打开。现有登记只有 `read-only / read-write`（〔#30〕2.2 节），普通可写不再顺带包含付费。
- 开关关着：所有会新建付费任务的请求返回 403 `paid_generation_not_permitted`，请求里带 `confirmed=true` 也不放行；可以查任务和费用预览。
- 开关开着：仍按第 3.3 节守门，`confirm` 照样要带本次同意。开关管「这个客户端能不能替用户花钱」，同意管「这一次花不花」，两者不互相替代。
- 免费取回不需要这个开关（照普通读写权限）；后台自动取回不需要任何按钮。
- 关掉开关只拦之后的新提交，已接纳的任务照常跑完、取回。首版不做累计额度。
- MCP、CLI、business 直连、工作流进到后台后都要带着服务器核实过的登记 `clientId`，不能借内置助手的身份再提交（〔#30〕5.2 节）。

### 3.6 一次同意只扣一次：一条唯一约束

上一版用「确认 ID + 10 分钟过期 + 桌面专用鉴权 + `POST /tasks/:id/regenerate-confirmations` 接口」，本轮简化。依据〔防重〕3 节 Q2、4.3 第 ① 条：业界没有服务端「发确认令牌」的通用做法，Stripe / AWS / Google 靠的是请求自带身份 + 同事务记账；这个接口实际想证明的「界面真的弹过框」服务端本来就证明不了（〔外部〕6.5 节）。

改成一张表、一条唯一约束，在接纳新任务的同一事务里写入并消费：

```sql
-- 示意，列名实施时定；依据〔防重〕第三节 Q2 的示例【推断，〔防重〕】
CREATE TABLE regeneration_consents (
  user_id            TEXT NOT NULL,
  target_node_id     TEXT NOT NULL,
  original_task_id   TEXT NOT NULL,
  original_route_run INTEGER NOT NULL,
  client_operation_id TEXT NOT NULL,   -- 本次付费提交的 operationId
  input_fingerprint  TEXT NOT NULL,    -- 本次请求的生成内容指纹（提示词、参考素材、模型、参数），只用来核对「报价后输入没变」
  logical_model_revision_id TEXT NOT NULL, -- 同意绑定的前台模型版本；换渠道不影响，换模型或版本失效
  quote_id           TEXT NOT NULL,
  charge_snapshot    TEXT NOT NULL,    -- 报价里的费用：单位、预计值、上限、价格版本
  caller             TEXT NOT NULL,    -- desktop_ui / assistant_proposal / external:<登记 clientId>
  consented_at       DATETIME NOT NULL,
  consumed_task_id   TEXT NOT NULL,
  consumed_route_run INTEGER NOT NULL, -- 这次同意实际用掉的那一轮；/retry 复用任务号，只记任务号分不清是哪一轮
  UNIQUE (user_id, target_node_id, original_task_id, original_route_run)
);
```

**一次同意只用于一轮**（〔#30〕4.2 节）：唯一键里有 `original_route_run`，同意用掉后记下 `consumed_route_run`；这一轮又失败了，再重跑就是新的一轮，要重新确认，旧同意不能再用。

**每次重跑都有持久回执**（〔#30〕4.2 节）：`/retry` 复用原任务号、只把 `routeRun` +1（`repository/local_runtime.go` 的 `retryTask`），一个可变的任务行存不下多次重跑各自的操作 ID。所以每次付费接纳都写一条 `(用户, operationId) → 请求指纹、调用者、任务 ID、这次的 routeRun`，复用现有 `AgentOpRecord`（`Store.Run`，和业务变更同一事务）的做法，不另建执行引擎。同一 `operationId` 重放只返回这条回执对应的那一轮，不把任务再排一次队；回执不随报价过期或任务清理删掉。`allowed` 的重跑同样要写，不只 `confirm`；因此所有付费提交都必须带稳定 `operationId` 和预期的 `(taskId, routeRun)`，缺了就拒绝（`operation_id_required`，第 3.3 节），不为旧客户端放宽。

**第 3 步修订：免费取回不写付费同意记录、不要求这两个字段；但 `/retry` 请求一旦带了 `clientOperationId`，即使选中免费取回，也要保存操作接纳回执。**原文“免费取回不写这条回执”把同意与操作去重混为一件事，与过渡期 `/retry` 的同编号重放约定冲突。接纳回执记录本次选中的动作和生成轮次，不代表已生成或已退款；免费取回和付费重跑都复用 `AgentOpRecord`。独立 `/recover` 仍无须操作编号。

- 不发确认 ID、不设 10 分钟过期、不搞桌面专用鉴权。同意随付费提交一起带上：`consent: { originalTaskId, originalRouteRun, quoteId, operationId }`。
- 接纳事务里先核对：报价存在、属于本调用者、没过报价有效期；本次请求的内容指纹、前台模型版本、费用、`operationId` 与报价一致；费用没有上涨、计费单位没变。任一不符返回 `paid_confirmation_required` 和新报价，**不提交上游**。
- **同意绑定的是模型（前台模型版本）和输入，不绑定渠道。** 用户 2026-10-26 原话：「怎么会有更贵的渠道？ 我们模型都是唯一定价啊 除非换模型」。BeefTV 里同一个模型只有一个价格，换哪个渠道去跑都按这个模型的价格算；`ChannelModel` 上没有价格字段（`modelcatalog/types_route.go` 里价格 `videoPricing` 挂在模型目录项上）【已核】。
- 因此同一模型内自动换备用渠道照常进行，不需要重新确认：原渠道明确拒绝（`rejected_no_job`）后，`task_route_executor.go` 第 113 行 → `nextRouteAttemptAfterFailure` → `modelcatalog/route_attempt.go` 第 174 行 `SwitchTaskToNextRoute` 只在 `task.LogicalModelRevisionID` 对应版本的路由里选下一个渠道，不换模型，同意不失效。
- **但结果不明的那次提交，原样重发只能走原渠道。** BeefAPI 的去重范围是 `market:userID:tokenID:key`（〔#30〕4.1 节，BeefAPI `middleware/video_submission.go`，图片复用同一范围）：同一个键换了渠道、换了 Key，BeefAPI 当成新请求，会再生成、再扣一次。所以 `submission_unknown` 时不换渠道、不换账号或 Key 重发；只有上一次明确没被接纳（`not_sent`、`rejected_no_job`）才换备用渠道。
- 只有模型变了才让同意失效、需要重新确认，包括前台模型版本变了。接纳事务里核对：本次提交解析出的前台模型和前台模型版本，与报价、同意记录里的一致；不一致就返回 `paid_confirmation_required` 和按新模型算的新报价，不提交上游。
- 核对过现有代码，**没有任何自动路径会换到别的模型**【已核】：
  - 换备用渠道：`SwitchTaskToNextRoute` 读取 `task.LogicalModelID` 和 `task.LogicalModelRevisionID`，版本不属于该模型就报错，路由只从这个版本的 `LogicalModelRoutes(revision.ID)` 里选；
  - 图片限流重试：`app/image_submission.go` 第 135 行把上一次的 `LogicalModelID`、`LogicalModelRevisionID`、`RouteID`、`ChannelID` 原样抄给新尝试，连渠道都不换；
  - 重启后恢复：沿用原任务的派发记录和路由（第 3.2 节），不重新选模型；
  - 任务接纳：`task/admission.go` 第 146–147 行把用户选的模型和版本写进任务，之后执行器不改。
- 有两处会改到模型或版本，但都是用户主动发起、不是自动路径，方案里照上一条处理：
  - 用户点重跑（`/retry`）：`PrepareLogicalTaskRetry`（`route_attempt.go` 第 286 行）按 `task.LogicalModelID` 重新解析**当前**快照，第 319 行把 `task.LogicalModelRevisionID` 改成当前版本——前台模型如果在原任务之后发过新版本，这次重跑用的是新版本。模型没换，但版本可能变，按上一条视为「模型变了」，同意失效、重新报价。模型已归档时走 `ResolveArchivedTaskRoute`，保留原版本。
  - 工作流节点换模型：`app/canvas_workflow_models.go` 的 `selectWorkflowModel` 按工作流里用户选的模型选项改写配置。这是用户在工作流里改了选择，等于一次新提交，同样按模型核对。
- 然后 `INSERT`。插入成功 = 这一次额度到手，同一事务写入新任务；违反唯一约束 = 这次 `confirm` 已经用过，返回当前 `outcome`，不建任务。
- 同一个 `operationId` 重放（双击、网络重试）先由现有 `(user_id, client_operation_id)` 唯一索引和 `admitExisting` 返回原任务，根本走不到插入；即使报价后来过期，已接纳的同一操作重放仍返回原任务，不变成新购买（〔外部〕6.6 节）。
- 原任务的 `routeRun` 变了（被重跑过），唯一键自然换一组，旧同意不再匹配。
- 批次：一次同意覆盖用户明确看见数量和总费用的一个批次，每个目标节点一行；部分接纳后的重放不重做已接纳项（〔外部〕6.6 节）。

**同意失效用 `routeRun` 判断，不用 `updatedAt`。** 依据〔防重〕4.2 第 ③ 条，代码【已核】：`backend/internal/repository/repository.go` 的 `UpdateTaskProgress`（第 380 行）和 `UpdateTaskProgressForLease`（第 387 行）每写一次进度、阶段都设 `updated_at: time.Now()`；`ReleaseTaskProviderRecovery` 释放租约时也会改。用户看确认框的几秒内一次无关写入就会把同意作废。要防的是「确认期间结果被取回了」——那是 `phase` / `regenerate` 变了，接纳事务里重算一次 `Outcome`、发现不再是 `confirm` 就拒绝即可；`routeRun` 只在重跑时 +1（`local_runtime.go` 第 361 行 `route_run + 1`【已核】），用它做同意的版本。

用 `routeRun` 加接纳事务里重算 `Outcome` 已经够用，**不加 `outcome_version`**（〔#30〕4.2 节）。另外所有对着已有节点的新提交都带上它看到的 `(taskId, routeRun)`，事务里对不上就拒绝并返回当前事实，不悄悄改成对最新任务再买一次（〔#30〕4.2 节「两个不同操作 ID 的并发点击」）。

后台能保证的措辞固定为「**一次操作最多接纳一次约定的生成**」（〔#30〕4.3 节），不说「不会重复扣费」，也不说「只发一次 HTTP 请求」——结果不明时同键重发会有多次 HTTP 请求，但不另建上游任务。第三方渠道的钱扣在用户自己的 Key 上，BeefTV 做不到「账上不可能扣两次」，只能做到「不可能接纳两次」。

### 3.7 上游已带 `Idempotency-Key` 的渠道：核实结果

依据〔防重〕4.2 第 ② 条、第五节：上游按同一个键去重的渠道，用同一 attempt 的同一个键原样重发，上游只执行一次，「提交未确认」不必升级成「让用户确认」。〔防重〕第六节第 3 条说明它没有逐家核实上游行为，要求先核实。本轮逐家核对的结果：

| 渠道 | BeefTV 发送端 | 上游是否按键去重 | 结论 |
| --- | --- | --- | --- |
| BeefAPI 图片（`/v1/images/generations`、`/v1/images/edits`） | `app/image_submission.go` 把 `Idempotency-Key` 存进加密的 `ImageSubmission` 原请求，同键原字节重发；只在 `/models` 响应头声明 `X-Image-Submission-Protocol: idempotency-key-v1` 时启用（`generation/image_recovery.go`）【已核】 | **是**。BeefAPI 仓库（`codex-enhance` 分支 `39ea36f`）`middleware/image_submission.go` 的 `ImageSubmissionGuard`：同键同体返回保存的响应并带 `Idempotency-Replayed: true`；同键异体返回 409 `idempotency_conflict`；处理中返回 409 `image_submission_pending`；超过 10 分钟仍无结果返回 `image_result_unknown`；回执超过 24 小时返回 410 `image_result_expired`，「This key will not generate another image」。`router/relay-router.go` 第 113 行的 `/v1/models` 发出协议声明【已核】 | 原样重发**不算会扣钱**，不必问用户。`image_result_unknown`、`image_result_expired` 两种情况上游不再生成，BeefTV 落到 `unrecoverable`，能不能重新生成照第 3.1 节判：有 job id 且返回了 `billing_state` 的，`refunded` 直接重新生成、`settled` 要确认、空值（还没结算）先等；没有 job id 或返回体里没有这个字段的（目前非腾讯 VOD 同步图片都是），按第三方处理，确认后可重新生成 |
| BeefAPI 视频（`/v1/videos`） | `generation/video.go` 只对 BeefAPI 视频配置用 `PostJSONWithSubmissionKey` 设 `Idempotency-Key`；键按 `taskID:attemptID` 派生（`provider_submission.go`）【已核】 | **有条件是**。BeefAPI `middleware/video_submission.go` 的 `VideoSubmissionGuard` 同样按键去重并返回原回执，但只在环境变量 `VIDEO_SUBMISSION_GUARD_ENABLED=true` 时生效，**默认 `false`**（`docker-compose.ghcr.yml` 第 129 行 `${VIDEO_SUBMISSION_GUARD_ENABLED:-false}`；运维手册 `docs/runbooks/video-submission-hardening.md` 写「迁移后受控启用」）【已核】。生产环境是否已开启，本轮无法从代码确认【未核实】 | 只有生产环境确认开启后，原样重发才不算会扣钱。确认前照旧当作可能扣钱。建议 BeefAPI 像图片那样在响应头声明协议，BeefTV 按声明启用，不按域名判断 |
| BeefAPI 超分（`/media-upscale/tasks`） | `generation/upscale.go` 用 `postJSONWithSubmissionKey`【已核】 | **是，且强制**。BeefAPI `middleware/fal_upscale.go` 在 `VIDEO_SUBMISSION_GUARD_ENABLED` 关闭时直接拒绝创建（503 `upscale_unavailable`），开启时同视频去重；`router/video-router.go` 第 13 行接在 `VideoSubmissionGuard` 后面【已核】 | 能创建成功就说明去重已生效，原样重发不算会扣钱 |
| 声明式插件（`generation/protocol.go`） | 宿主把键放进 `request.extra.idempotencyKey`，插件可以映射到请求头，不映射就不发【已核】 | 仓库里只有 `plugin-packages/full-video/manifest.json` 映射了 `Idempotency-Key`【已核】。它是「全参 2.0 / 2.5」第三方服务，上游是否去重查不到【未核实】 | 当作可能扣钱。插件 manifest 以后可以加一个「上游按幂等键去重」的声明，由插件作者负责，后台按声明启用 |
| 其他直连渠道（火山方舟、可灵、Runway、OpenAI 直连、RunningHub 等） | 不带 `Idempotency-Key` 或没有协议声明 | — | 当作可能扣钱，「提交未确认」照旧落到 `confirm` |

做法【推断，〔防重〕4.2 第 ②】：渠道能力加两个字段 `supports_idempotent_submit`、`supports_query_by_request_id`，只由协议声明（BeefAPI 的响应头、插件 manifest）打开，不按域名猜。`supports_idempotent_submit` 为真且原请求还在（图片的 `ImageSubmission`）时，`submission_unknown` 的 `Outcome` 是 `retrievable`：后台用同一 attempt、同一键、**同一渠道和同一 Key** 原样重发（第 3.6 节，BeefAPI 去重范围含 `tokenID`），不新建任务、不问用户。这两个字段只管「结果不明时能不能安全重发 / 能不能按任务号查」，不管收不收费。

同时把「发起上游请求前，带幂等键的 attempt 必须已经提交到数据库」写成显式不变量（〔防重〕2.2【推断】）：`modelcatalog/route_attempt.go` 已在派发前把状态写成 `submission_unknown`，键由 `taskID:attemptID` 派生、跨重启稳定，这一层已经有，方案只是把它从实现细节提为约束，并加测试。

### 3.8 前端只照着做

- `bindGenerationTask` 把 `task.outcome` 原样存到节点 `metadata.taskOutcome`。所有「能不能重新生成 / 是否锁住」的判断只读这一个字段，集中在一个 `lib/task-outcome.ts` 里给出按钮和文案。错误卡、批次子节点、悬浮工具条、提示词面板、任务中心共用它，消除来源不同的问题。
- 删除：`resourceReloadAvailable`、`isKeptGenerationResultCode`、`canvasGenerationRetryBlocked`、`imageSubmissionUnknown`、`canvasImageGenerationHasPendingResult`、`taskRetryBlocked`、`canRetrieveVideoResult`、`generationTaskCanReloadResource`，以及 #263/#16 新增的 `canvasTaskProvesSubmissionUnknown` 一类判定。
- `taskStatus / taskStage / taskProgress` 保留为显示用的副本，只由 `bindGenerationTask` 写；加一个测试：判定函数不允许读这几个字段。
- `lib/generation-error.ts` 不再分类**任务**的错误，只用于前端本地错误（还没发出请求时的网络、参数、保存失败），任务失败的文案由 `outcome.reason` 选。这部分可以在守门上线之后慢慢缩，不阻塞上线。
- 前端不再有任何自动调用 `/retry` 或 `/recover` 的代码。加载画布时的恢复扫描（`use-canvas-generation.ts`）只负责订阅任务、把 `ready` 的结果写回节点，这是现在已有的流程。
- BeefTV 界面的确认框：收到 `paid_confirmation_required` 时显示后台给的费用预览（费用未知时显示「未知」和计费依据），用户点确认后带着同一 `quoteId`、同一 `clientOperationId` 再提交一次。

**给用户看的文字不提 BeefAPI，也不露内部字段。** 用户 2026-10-27 15:19：「我说的是这个应该改成beeftv正在核对 不应该展示beefapi给用户看」。规则：
- 适用范围：所有会显示给用户的文字——错误卡、提示、按钮、确认框、费用预览里的「计费依据」，以及 MCP/CLI 返回给用户读的文字（`structuredContent` 里的说明、等价文本、elicitation 信息、CLI 终端提示、工具说明）。
- 不出现 BeefAPI、渠道 ID、内部字段名和取值（`usage_state`、`billing_state`、`reconcile_deadline`、`pending`、`settled`、`refunded`、`routeRun`、`operationId` 等）。要说是谁在核对、谁扣的费，就说「BeefTV」，或者不提来源（如「上次已扣费」）；时间直接显示成具体时间。「渠道」可以说，BeefTV 设置里本来就这么叫。
- 只给后台和代码看的内容不受限：本方案的设计说明、日志、`reason` 这类机器原因、`paid_confirmation_required` 这类错误码，照常写 BeefAPI 和字段名。`lib/task-outcome.ts` 按 `outcome.reason` 选文案时，文案表里的句子要符合这条规则。
- 本方案里用「」括起来、标明是界面文案的句子都已按这条写好；实施时加一个文案测试，断言用户可见文案里不出现 `BeefAPI` 和上面这些字段名。

### 3.9 唯一留在前端的状态：任务号还没拿到

点下生成到拿到任务号之间，只有前端知道「我发过一个请求」，这一段仍用 `taskClientOperationId` + `generationSubmissionState: submitting | unknown`。

上一版的「发出超过 2 分钟、按标识查不到就判定后台没接纳」已删掉。依据〔防重〕4.2 第 ④ 条、RFC 9110「超时或失败不代表副作用没发生」；〔状态〕5.2 第 2 条：Stripe、ComfyUI、InvokeAI 都是带同一个键重发，由服务端去重，不等一个固定时长。改成：

1. 节点处于 `submitting` / `unknown` 时，前端**带原来的请求体和原来的 `clientOperationId`** 重发 `POST /tasks`。后台已接纳就由 `admitExisting` 返回原任务；没接纳就这次接纳——上次没接纳也就没扣钱，这次接纳的是用户原本那一次点击，不是重复购买。
2. `GET /tasks/by-operation/:operationId` 去掉画布过滤，按用户 + 提交标识查（#16 说明「未覆盖」第 3 条指出画布过滤会把已有任务误判为不存在）；画布不一致单独报错。

**前提要核实：前端本地有没有保存原请求。** 本轮核对代码【已核】：
- 前端**没有**持久化原请求体。`services/api/generation-submission.ts` 的 `submitGenerationCommand` 只在内存里 `structuredClone(input)`，同一次调用内重放；页面刷新后就没了。`persistCanvasGenerationTarget`（`services/canvas-generation-target.ts`）在提交前只把 `taskClientOperationId` 和 `generationSubmissionState: "submitting"` 写进画布文档，不存请求体。`lib/canvas/canvas-project-generation.ts` 的 `runGenerationOperationOnce` 也只是内存里的锁。
- 深度捕捉存了 `taskClientOperationInput`，但它只是 `localExecutorFrozenInputKey` 拼出来的识别串（`JSON.stringify(["depth_capture", projectId, resourceId])`），不是完整请求。

所以分两种情况：
- **同一会话内**（没刷新）：内存里还有原请求，按上面第 1 条自动重发，不需要用户看。
- **刷新或重启之后**：原请求已经丢了，不能自动重发。前端用 `taskClientOperationId` 查 `by-operation`：查到就绑定原任务；查不到就显示「上次提交没有找到，可以重新生成」，用户点「重新生成」时**复用同一个 `clientOperationId`**、用当前画布重新组请求。后台 `admitExisting` 按标识去重：原请求其实已被接纳的，内容一致就返回原任务，不一致就返回 409 `ClientOperationConflictMessage`，不会建出第二个任务。桌面版后端是本机进程、接纳在一个事务里完成，查不到就是没接纳（〔状态〕3.2 对 InvokeAI 的分析【推断】），这里不再加计时判断。
- 如果要做到刷新后也能自动重发，需要在提交前把请求体存到本地（InvokeAI 的做法：「Journal writes precede submission」，〔状态〕3.2）。这会增加一份本地存储和清理逻辑，本方案不做，列为第七节第 2 条。

`generationSubmissionState` 的 `submitting` / `unknown` 对用户的含义已经一样（都是「可以再点，会去重」），展示上合并成一种；字段是否只留 `taskClientOperationId`，按〔防重〕4.3 第 ③ 条留给实施时定。

### 3.10 四种任务共用一套

`Outcome` 的字段对所有任务类型相同，不同的只是「去哪里找可取回的结果」和「渠道保留期」：

| 类型 | 免费取回的来源 | 重新生成 |
| --- | --- | --- |
| 图片 `canvas_image` | 创建回执 / `ImageSubmission`；BeefAPI 图片同键重发 | 走扣费入口 |
| 视频 `canvas_video` | `ProviderRequestID` 查上游，截止按渠道保留期 | 走扣费入口 |
| 超分（按 `UpscaleMediaType(model)` 识别） | `ProviderRequestID` 查上游 | 走扣费入口 |
| 深度捕捉 `depth_capture` | 本地执行器的产物 | 本地计算不扣费，`regenerate` 只会是 `allowed` / `blocked` |
| 文本 `canvas_text` | 无（流式结果已在本地） | 走扣费入口 |

这个分派写在后台一个函数里（按类型选来源），前端不知道这些区别。深度任务里前端自己写 `taskStage: "submission_unknown"` 的两处（`use-canvas-media-tools.ts`）改为由后台根据执行器状态给出。对应 Google AIP-151「各接口不要各自定义长任务接口」（〔状态〕4.1）。

### 3.11 第 3 步专项调整：先固定操作，再执行和投影

本节只交给第 3 步的实现者使用。依据最新 #68 `e08b6bea`、BeefAPI `be8f7072` 和[隔离验证报告](../research/generation-task-state-step-3-recheck.md)，不继续按历次评审清单追加分支。正式代码本次未改。推荐复用现有任务、`AgentOpRecord`、恢复租约和交付器，不增加队列、计费状态机或通用工作流引擎。

**用户行为与 Basis：**

| 保持或澄清的行为 | Basis |
| --- | --- |
| 原结果能取回时只取回，不重新生成；暂停下载可恢复 | 用户已批准第 4 轮方案；本次两种暂停状态的真实交付测试通过 |
| 同编号 `/retry` 始终代表同一次操作，免费分支也返回原接纳结果 | 已批准第 3.3 节“重复提交返回上一次结果”；[Google AIP-155](https://google.aip.dev/155)；本次免费取回重放反例 |
| 同编号不跨到下一轮；新购买使用新编号 | 已批准第 3.6 节“一次同意只用于一轮”；本次回执丢失 `routeRun` 的反例 |
| 已退款可重新生成，结算中等待，不提供查询时取不回则确认 | 用户“beefapi很容易知道……第三方渠道就不一定”“别又多造状态机了”；已批准第 3.1 节；上游实际字段 |
| 临时下载失败不能变成永久取不回；不能只按 GET/POST 判断是否收费 | 已批准第 3.2 节；本次截断下载反例；仓库超分与 RunningHub 原有查询协议 |
| 使用操作回执、原值快照和下面的职责分工 | 本次架构判断，属于建议；不是额外用户确认、过滤或渠道收费规则 |

**一个操作入口，三个窄职责。**

1. `app.RetryTaskWithOperation` 做兼容请求的唯一编排：读取已有回执；没有回执时加载同轮事实，选“取回”或“重新入队”。`RecoverTask`、自动扫描、人工查上游使用同一个免费恢复入口。把当前 `service.go` 中独立的成功交付、视频查询和图片恢复分支收进该入口；不要在 app 和 task 域各读一遍操作回执、各翻译一遍错误。
2. repository 只负责短事务：核对读取时的任务轮次、写接纳回执，以及需要的本地更新。付费分支沿用 `withImmediateTransaction` 将 `routeRun+1`、入队、回执放一起；免费分支记录原轮次，暂停下载的解除也在同一事务。网络查询和下载在事务外，复用现有恢复租约。
3. `task.ComputeOutcome` 是唯一对外结论计算函数。接收原值事实，先判断原结果能否继续取回，再按扣费事实计算 `regenerate`。`RecoveryUnrecoverable` 只改变结果结论，不能覆盖退款或结算中的结论。持有上游 ID 也不等于永远只能取回：已有明确 `no_result/unrecoverable` 时按扣费事实处理，不再盲目重复查询。

**操作回执记录“接纳了什么”，不直接序列化 `model.Task`。**

复用 `AgentOpRecord.ResultJSON`，存最小内部结构：动作（取回或重新入队）、`taskId`、`originalRouteRun`、`acceptedRouteRun`，以及已有的请求指纹。现在 `model.Task.RouteRun` 为 `json:"-"`，直接序列化会丢失轮次，本次实测 `4 → 0`。回执的 `succeeded` 指本地操作已经接纳，不表示上游生成成功。

- 首次带编号的 `/retry` 在网络恢复前就固定选中的动作；“先取回成功再补回执”仍有进程退出的缺口。
- 同编号回读必须先于任务当前状态、排空和重试资格检查；命中就返回原接纳身份与任务的当前投影，不再执行取回或入队。任务后来进入了另一轮时，不能把当前轮次伪称为原回执轮次，也不能回放旧指令修改新轮次。
- 返回体保留原 Task JSON 外形，建议附加可选 `retryOperation`（动作、任务号、原轮次、接纳轮次）；`outcome` 始终是任务当前投影，操作身份来自回执。旧前端可忽略新增字段，不需要本步改前端。这样不必伪造上一轮的当前进度，也不丢失原操作所属轮次。
- 免费接纳后、查询开始前退出：原失败任务仍由既有恢复扫描处理；暂停任务的解除已随接纳事务提交。恢复过程中退出靠已有任务事实和租约继续。记录回执后必须确实留下这条可继续的路径，不能只插一条“已完成”记录。
- 无编号旧客户端保持第 3 步的原兼容行为；不承诺它跨轮次网络重试的持久去重。编号必填和付费同意守门仍是第 4–5 步，不在本步提前启用。
- `AgentOpRecord` 不新增执行生命周期；不另建免费同意表。HTTP handler 只解析参数、转一次错误并返回投影。

**扣费事实只保留原查询的事实，不让日志决定下一次购买。**

建议在当前任务增加一份可空 `BillingObservation` 结构（具体数据库列名实施时定），记录字段存在性、`usage_state`、`billing_state`、`reconcile_deadline` 原值与观察时间，以及该响应所属的 `routeRun`、渠道/路由尝试和上游任务号。这是原方案“存进任务”的具体化，不新增 BeefTV 的“已退款/待结算”持久状态。

- 仅正式渠道的明确扣费查询适配器写入该结构；写入时按任务、轮次和该次派发身份条件更新。查询尚未返回时用户已进入新轮次的，旧响应不覆盖新轮次。没有路由尝试的历史任务用其已保存的渠道和原上游 ID；身份不足时不借旧日志推断退款。
- 新付费接纳在同一事务里清空上一轮观察。日志仍用于诊断和已有结果回执恢复，不能成为第二份扣费判断来源。不必为所有 API 日志增加一套收费授权过滤链。
- 投影分开读“字段缺失”“字段存在且空”“有确定值”。`usage_state=failed` 与图片 `billing_state=refunded` 分别按协议映射，不用一个跨渠道字符串白名单；`pending` 和图片显式空值不能压成 `ConfirmedUncharged=false` 后再统一当 `confirm`。
- 图片和视频查询必须使用真实响应夹具：视频 DTO 信封、实时查询缺键，图片 `result.url` 与 `result_url → 结果 JSON`。失败任务也要保存扣费响应，不能因没有媒体结果就提前丢弃结算事实。
- 结果停止恢复与扣费轮询停止是两件事。已写 `no_result/unrecoverable` 但扣费仍 `pending` 的任务，继续在既有恢复循环读取扣费结论，直到得到上游结论；不能被结果扫描过滤掉。不新建一套计费 worker。

**免费恢复按请求用途分，不按 HTTP 方法分。**

仅调用已有协议的 `poll/query/recover` 构建入口，禁止调用 `create`、任务接纳或 `RetryTask`；允许协议中本就用于查询/取回的 POST。恢复验证记录请求用途、上游 ID、本地任务数和 `routeRun`。取消本次实现自行加入的 GET-only 判断；这不是放开生成 POST。

上述限制约束本步新增的查询/取回执行路径。第 3.7 节已经批准、并在第 2 步实现的原键原字节图片重发保留在其原路径，仍以原渠道的去重协议为前提；本步统一它与其他路径共用的原结果读取、交付与投影，不把该例外推广到所有恢复 POST，也不删除它。

查询成功与媒体下载分开保留进度。取得原上游结果后交给已有交付器；截断响应、磁盘/网络暂时错误只更新重试时间，不写 `no_result/unrecoverable`。上游明确终态、原结果确实过期和暂时无法访问要分别处理。期限未知不等于过期，下载链接过期不等于原结果删除。

**内部实施顺序及完成证明（整体仍属第 3 步）：**

| 顺序 | 可检查的交付 | 停止条件 |
| --- | --- | --- |
| 3A | 共用免费入口与操作接纳回执；保留现有付费事务 | 同编号并发、完成后重放、数据库重开后重放、免费接纳后中断均无新生成；回执轮次正确 |
| 3B | 原查询值持久化到当前轮次，投影读同一份事实 | 六种扣费映射、跨轮次/渠道、过期响应回写、真实两类响应夹具全部通过 |
| 3C | 查询/下载分别恢复；超分及合法 POST 查询参与扫描；渠道期限形成结论 | 两种暂停恢复、暂时下载失败、明确过期、未知期限、`pending` 后转退款完整回放 |

新增验收必须从公开请求或既有 Service 入口贯穿数据库、假上游和任务读回；纯映射测试只是其中一层。每条记录固定源码提交与期望来源。修复后的代码必须重跑本次夹具，不能拿本次临时补丁的绿灯代替正式实现验收。3A 的本地去重通过，也不证明上游支持同键生成去重。

回退本步时可停止自动扫描，保留 `/recover`、已有操作回执读取和原值字段；恢复旧的“一张任务快照”回放代码会丢轮次，不是可接受的无损回退。当前 #68 已写但没有轮次的旧回执仍只能防止再次入队，不能猜出原轮次；后续实现须报告此类历史回执的读取方式，不得删除它们来允许重跑。

## 四、迁移：每步单独上线、单独回退

桌面版把前端打包在后端里（`backend/cmd/desktop/frontend.go` 的 `go:embed all:frontend/dist`），同一个安装包里前后端版本一致。但仓库还支持前后端分开部署（`docker-compose.yml` 里 `web` 是单独的镜像），浏览器里也可能还开着升级前加载的旧页面，所以**必须假设新后端会收到旧前端的请求**。还要兼容的是升级前保存的画布文档里的旧字段，以及外部调用方。

旧前端的请求在新后端上怎么处理：
- 旧前端的「继续取回」调的是 `POST /tasks/:id/retry`（`use-canvas-resource-handoff.ts`）。新后端的 `/retry` 在任务处于 `fetching` / `retrievable`、或者成功但暂停下载时，**一律按 `/recover` 处理**（免费取回，不新建任务），永远不会把这个请求理解成扣费重跑。这个兼容分支一直保留，到确认不再有旧客户端为止。
- 旧前端发起的扣费重跑（`/retry`、`POST /tasks`）不带同意，也可能不带稳定操作 ID。第 5 步之后，缺操作 ID 或 `(taskId, routeRun)` 的一律返回 `operation_id_required`；遇到 `confirm` 任务没带同意的返回 `paid_confirmation_required`。都提示刷新页面或升级，被拒绝只会让用户多走一步，不会多扣钱。
- 已发出去的外部 MCP/CLI：它们现在不认 `paid_confirmation_required`，遇到 `confirm` 任务会看到一条错误并停下，不会扣钱。

| 步 | 改什么 | 用户能感觉到的 | 回退 |
| --- | --- | --- | --- |
| 1 | 后台：`Outcome` 纯函数 + 表格测试（含「重启后 `running` 不变 `cancelled`」、BeefAPI `usage_state` / `billing_state` 各取值的映射），挂到任务读接口上，只增字段 | 无 | 删字段 |
| 2 | 后台：取回循环自动恢复图片（第 3.2 节的完整扫描范围，含没有路由记录的历史回执）；`recovery_outcome` 列（新增可空列）；`/retry` 现有的回执重建分支**原样保留**；BeefAPI 图片「提交未确认」按同键、原渠道自动重发（第 3.7 节）；BeefAPI 渠道读取并保存扣费结论（视频改用 `GET /v1/video/generations/{id}`，图片提交时存 `X-Image-Job-Id`，第 3.1 节） | **客户 A 的节点自己好了**：后台重建 → 下载 → 写回画布，旧前端照常显示成片；手动点也还能恢复 | 关掉循环里这一步 |
| 3 | 后台：按第 3.11 节先统一免费恢复与操作回执，再补当前轮次扣费事实，最后完成视频/超分自动查询及到期结论；同一 `clientOperationId` 包括免费分支都回放原接纳 | 视频失败后能自己取回；带同编号的重复请求返回原接纳结果 | 关闭自动查询，保留接口、回执读取和原值字段 |
| 4 | 后台：费用预览、同意表、扣费入口守门**先只记日志、不拒绝**。前端只做最小改动：BeefTV 现有的扣费确认框（重新生成、提示词面板、任务中心、批次）点确认后带上 `quoteId` 和同一 `clientOperationId`；所有付费提交（含 `allowed` 重跑和 `ready` 后再生成）都带上 `clientOperationId` 和预期的 `(taskId, routeRun)`；内置助手的方案卡显示费用预览；其余前端保护不动。观察一个版本：日志里每一次「本应拦下」都要能对上前端确实带了同意 | 确认框里多了费用 | 关掉日志；前端多带的字段可以保留，后台不守门时不起作用 |
| 5 | 后台：守门改成拒绝；`RecoverMediaUpscale` 去掉扣费分支；MCP/CLI 新工具、`paid_confirmation_required` 与外部客户端「允许发起付费生成」开关（第 3.5 节，默认关）同版上线 | 可能重复扣费时，任何入口都要先确认；外部调用方先要用户在 BeefTV 设置里打开开关，再在自己的界面里问 | 见下 |
| 6 | 前端：所有判断改读 `taskOutcome`；「继续取回」按钮去掉，界面只剩错误卡上的「重新生成」（`confirm` 时先确认）；删掉第 3.8 节列出的推断函数和 `resourceReloadAvailable` | 错误卡、批次子节点、任务中心按钮一致；不再出现节点锁死 | 回退到第 5 步的前端：它会带同意，回退后重新生成照样可用 |
| 7 | 清理：`by-operation` 去掉画布过滤；同会话内同键自动重发（第 3.9 节）；前端不再分类任务错误 | 「查不到原任务」不再锁死 | 单独回退 |

顺序的约束：
- 只记日志的观察期（第 4 步）必须在移除任何前端保护（第 6 步）**之前**完成。第 5 步守门切到拒绝之后，就**不能**靠关掉守门回退：第 6 步之后前端已经不再自己拦，关掉守门等于放开未确认的付费提交。第 5 步之后如果守门误拦，只能修判定规则或发修复版本。
- 带同意的前端改动在第 4 步就上线，早于第 5 步开始拒绝，所以不会出现「后台要同意、前端还不会给」的版本。第 4、5 步之间用户只看到一个确认框。
- 旧前端（Docker 分开部署、升级前打开的页面）不会带同意，也不一定带稳定操作 ID 和 `(taskId, routeRun)`。第 5 步之后，它对着已有节点的**付费**提交——包括 `allowed` 的失败重跑和 `ready` 后的再生成——缺这些字段就被拒绝（`operation_id_required`），提示刷新或升级；带齐字段但在 `confirm` 任务上没带同意的，同样拒绝。被拒绝只是多走一步，不会多扣钱。旧前端的**免费**取回（经 `/retry` 的兼容分支）照常可用。第 4 步只记日志期间，要先确认所有正常入口都已带上这些字段，再在第 5 步开始拒绝。
- 回退第 6 步时连同前端一起回退到第 5 步的版本，而不是只回退某几个文件。第 5 步的前端已经接好同意，回退后确认入口仍然可用。

如果 v2.0.4 只带第 1、2 步，`/retry` 的手动回执恢复仍在，历史任务的恢复能力不会少；自动扫描是在这之上加的。〔状态〕5.3 第 5 条也建议先发不依赖同意的几步（状态投影、后台自动取回、`/recover`）【推断】。

旧画布文档：读取时忽略 `resourceReloadAvailable` 和前端写的 `generationErrorCode`，节点的成败以重新拉到的任务 `outcome` 为准；`canvas-document-rebase.ts` 的字段清单同步删掉。没有 `taskId` 的历史节点保持现状（显示「页面刷新后本地生成已中断」）。

## 五、拿真实问题验收

「为什么不会再发生」写的是结构上的原因；每条都要留一个回归测试，测试素材优先用 #16 已有的。

### 5.1 今天四轮检查查出的问题

| # | 问题（来源） | 新设计下 |
| --- | --- | --- |
| 1 | 客户端写的错误码触发自动扣费重试（#16 第 1 轮 P1） | 前端没有任何自动调用扣费接口的代码；自动取回在后台，只走 `/recover`，那里不引用重试逻辑 |
| 2 | 提示词面板绕过扣费确认（#16 第 1 轮 P1） | 守门在后台：对着已有节点的 `POST /tasks` 先找该节点最近一个任务的 `outcome`，`confirm` 时不带与报价一致的同意就返回 `paid_confirmation_required`、不提交；`retryOf` 指向的不是节点当前任务也拒绝；前端漏不漏弹框都扣不了钱 |
| 3 | 恢复锁冲突（400）、存储配额（403）被当成拿不回（#16 第 1 轮 P2） | 「拿不回」只来自持久化的 `recovery_outcome`（`no_result` / `unrecoverable`）；`/recover` 的任何报错都不改变 `phase`，前端也不根据 HTTP 状态做判断 |
| 4 | 读回执时数据库临时出错被当成拿不回，靠匹配文案判断（#16 第 2 轮） | 同上；读库出错时不写 `recovery_outcome`，下一轮循环再试。#16 后端加的 `result_unrecoverable` 判断点正好就是写 `recovery_outcome` 的位置 |
| 5 | 后到的画布快照重复认领同一节点（#263 第 1 轮） | 取回不在前端认领；后台按任务加租约（`ClaimFailedTaskProviderRecovery`），画布快照来几次都不会多触发 |
| 6 | 恢复响应丢失，被误判为取不回（#263 第 1 轮） | 判定只看后台事实，不看某一次请求的响应；响应丢了，前端订阅到的任务也已经是 `succeeded` |
| 7 | 自动取回和手动重新生成用的是两套判断（#263 第 1 轮） | 只有一个 `outcome`，所有入口读同一个字段 |
| 8 | 节点锁死：任务已终态仍按「提交未确认」锁住（客户 A，#15） | 每个终态都有出口：`retrievable` 后台自动取；BeefAPI 图片同键重发；BeefAPI 渠道 `pending` 时显示核对截止时间，结算后按结论放开；`failed` 时 `regenerate` 为 `confirm` 或 `allowed`，没有永久锁死的分支（第 3.1 节） |
| 9 | 查不到原任务就永远「暂勿重新生成」（客户 B 候选路径 2/3，#16 未覆盖） | 第 3.9 节：去掉画布过滤；同会话内同键自动重发；刷新后查不到就允许用户重新生成，复用同一提交标识，后台去重 |
| 10 | 错误卡和批次子节点对「能否重试」的判断来源不同（#16 未覆盖第 2 条） | 两处都改读 `taskOutcome` |
| 11 | 双击 `/retry` 第二次报「不能重试」（〔防重〕4.2 第 ①，本轮新增） | 同一 `clientOperationId` 重放返回原任务（第 3.3 节） |
| 12 | 进度写入改 `updated_at`，会误作废刚做的确认（〔防重〕4.2 第 ③，本轮新增） | 同意按 `routeRun` 绑定，进度写入不影响（第 3.6 节） |
| 13 | 审核失败被当成「没扣钱」，改提示词就绕过确认（Runway `SAFETY.INPUT.*` 不退积分，Codex 第 4 轮） | 第 4 轮起不由 BeefTV 判断扣没扣：BeefAPI 渠道照读它的退款结论；第三方渠道失败一律要用户确认，改不改输入都一样（第 3.1 节） |
| 14 | 原渠道拒绝后自动换备用渠道，担心价格变（Codex 第 4 轮） | 同一模型唯一定价，换渠道不换模型（`SwitchTaskToNextRoute` 只在同一前台模型版本内选路由），同意不失效；只有模型或版本变了才重新确认（第 3.6 节） |
| 15 | 结果不明时换渠道重发，同一个键在 BeefAPI 被当成新请求（〔#30〕4.1 节，第 4 轮新增） | 结果不明只按原渠道、原 Key、原键重发；只有明确没接纳才换备用渠道（第 3.6、3.7 节） |
| 16 | `/retry` 复用任务号，多轮重跑分不清哪次同意用在哪一轮（〔#30〕4.2 节，第 4 轮新增） | 每次付费接纳写持久回执，同意记录 `consumed_route_run`，一次同意只用于一轮（第 3.6 节） |
| 17 | 外部程序只要有写权限就能花钱（〔#30〕第五节，第 4 轮新增） | 单独的「允许发起付费生成」开关，默认关（第 3.5 节） |

### 5.2 过去的同类修复（逐个打开核对过）

| 提交 | 当时的问题 | 新设计下 |
| --- | --- | --- |
| `d989cce`（#90）阻止恢复前重复收费 | 结果还没恢复，用户又点生成 | 后台守门：`retrievable` 时 `regenerate = blocked` |
| `463b558` 继续取回闪烁 | `resourceReloadAvailable` 被多处写来写去 | 字段删掉 |
| `ce93191` 晚到快照对账 | 前端恢复扫描和后到快照抢节点 | 取回挪到后台，前端只订阅 |
| `b95cb1a`（#193）视频恢复补全原任务关联 | 节点丢了任务号，取回提示不对 | 部分覆盖：取回提示统一由 `outcome` 给；任务号关联本身仍靠 `generationTaskNodeId`，不在本方案里 |
| `ceb3173` 区分人工与自动重试 | 准备失败时自动重试会重发 | 自动路径不再有重试，只有取回；人工重试的条件由 `regenerate` 给 |
| `2a58c3b` 区分「未发出」和「提交未确认」 | 两者混在一起 | 后台事实层已经区分（`not_sent` / `request_not_sent`）；新设计把它集中到 `Outcome` 的一张测试表里，前端不再另做一遍 |
| `cfbe1ff`（#178）VOD 错误提示与恢复后原任务保护 | VOD 错误码前后端各一份 | 前端只用 `reason` 选文案，不再维护判定表 |
| `21af10c`（#142）深度任务恢复与重试 | 深度任务特殊处理散在前端 | 第 3.10 节，深度只是一种取回来源 |
| `5cee841`、`2a3b343` 视频原任务取回校验身份 | 取回时核对任务身份 | 已在后台，保留 |
| `0ecf309`、`907d36d` 拒绝不完整回执、恢复原图下载 | 回执有效性校验 | 已在后台，保留，并从「只有手动才跑」改为循环自动跑 |
| `1049faa` 路由或取消前保留未确认提交 | 派发状态记录时机 | **新设计管不到**：这是事实层的记录错误 |
| `da5cfae` 多张图片输出贯穿恢复与重试 | 多输出只恢复了一张 | 部分覆盖：`outputs` 已按序号投影；`Outcome` 是任务级的，部分输出失败时用 `fetching` / `retrievable`，需要在表格测试里加多输出用例 |


### 5.3 新设计也防不住的

- **事实记错了**：派发状态、回执落库、上游错误分类本身出错（如 `1049faa`），`Outcome` 会照着错误的事实给出错误结论。好处只是这类错误只需要在后端一处修、一张测试表里补用例。
- **上游自己的问题**：上游返回成功却没有图、查询接口报错、过了渠道保留期，只能落到 `failed + confirm`，由用户决定是否重新生成、可能重复扣费。
- **第三方渠道上次其实没扣钱**：第 4 轮起第三方渠道不再判断收不收费，所以上游其实已退款的失败，用户也要点一次确认。这是为了不维护逐渠道的退费表有意接受的代价。
- **BeefAPI 的扣费结论本身错了**：BeefTV 照读，不复核。
- **上游幂等声明本身不可靠**：第 3.7 节「同键重发不算会扣钱」只对核实过的渠道成立；BeefAPI 视频要等生产环境确认 `VIDEO_SUBMISSION_GUARD_ENABLED` 开启。声明式插件作者如果声明错了，后台会照着错的声明重发。
- **调用方没真的问人**：后台只能保证「不明确声明同意就不扣钱」，不能证明外部 MCP/CLI 真的问过人；Claude Code 的 hook、Codex 的自动批准都可能替用户回答（〔外部〕4.2、6.5 节）。用户给某个客户端付费权限，就等于把「问不问人」交给了它。
- **同意本身可能是误点**（像 memoh 误点那次）：本方案只能保证「一次同意最多提交一次」，不能保证同意不是误点。
- **刷新后原请求丢失**：第 3.9 节刷新后不能自动重发，用户要再点一次；如果当前画布和原请求内容不同，后台按同一标识返回 409，用户要换一个新提交（这时节点当前任务是什么，就按第 3.1 节判）。

## 六、#263 和 #16 里能直接用的

| 内容 | 处理 |
| --- | --- |
| #16 后端 `ResultUnrecoverable` 的几处判断（`image_result_recovery.go`、`image_submission.go`、`lifecycle.go`）和 `repository.ErrAmbiguousImageCreateReceipts` | **直接复用**，改成在这些位置写 `recovery_outcome`，替代返回 `reason` |
| #16 后端测试 `TestImageReceiptRecoveryReasonSeparatesUnrecoverableFromTemporaryFailure`、`TestRetryUnknownAcceptanceAndImageReceiptStayOnOriginalTask` 新增断言 | 改成断言 `Outcome`，进第 1、2 步 |
| #16 前端测试 `canvas-generation-failure`、`canvas-task-result-recovery`、`canvas-settled-retry-confirmation`、`canvas-late-generation-recovery.browser`、`canvas-uncertain-recovery.browser`、`generation-preflight` 夹具 | 场景全部保留作验收（第五节第 1–7、10 条）；断言从「前端判定函数返回什么」改成「给定后台 `outcome`，界面显示什么、请求发了几次」 |
| #16 错误卡的三种文案（正在自动取回 / 确认取不回可重新生成 / 未定只能查看）和三张截图 | 直接对应 `retrievable`、`failed+confirm`、`running`，文案复用，不加新按钮 |
| #16 / #263 前端的 `canvasTaskProvesSubmissionUnknown`、`canvasNodeNeedsOriginalResultRecovery`、`recoverCanvasTaskResult`、恢复扫描里的自动取回分支、提示词面板付费确认分支 | 不合并，由后台取代 |
| #15 根因说明（`docs/review-evidence/canvas-uncertain-result-recovery/README.md`） | 作为背景材料保留 |

如果 v2.0.4 等不及后面几步，最小止血是只发第 1、2 步：只改后端，`/retry` 现有的手动回执恢复原样保留，客户 A 这类节点会被后台自动修好，前端一行不改。这需要先在本机用一份带完整回执的失败任务验证一次「后台重建 → 下载 → 写回画布 → 旧前端显示成片」这条链路。本方案没有跑过这条链路，这是推断。

## 七、待架构师评审的点

前两轮 Codex 评审的结论已落进正文：同意确认后重新生成；按目标节点检查，批次检查每个目标；退避按渠道定；批量查询；改输入不能免确认。第 4 轮按用户 2026-10-27 的简化和〔#30〕改动后，原第 1 条（审核失败按计费另判）、第 5 条（外部付费权限，已定为默认关的开关）、第 6 条（`outcome_version`，已定为不加）已在正文定下。还需要拍板的：

1. **BeefAPI 视频 `usage_state = pending` 且已过 `reconcile_deadline` 时显示什么。** 按 BeefAPI 代码，过了截止时间、还没有上游任务号的，它的核对循环会自动退款并把任务标成失败（`model/video_deadline.go` `RefundUnreconciledVideoTask`，默认 1800 秒；`service/video_reconcile_deadline.go` 调用）【已核】。但这个自动退款只处理没有上游任务号的提交；有上游任务号的、或 BeefAPI 没开核对循环的，过了截止时间仍可能是 `pending`。运维手册第 92 行的「超过 24 小时」是允许**人工**核对的条件，还要操作员提供供应商证据，不代表旧任务不会再完成或扣费。所以定为：**`pending` 不管等多久都是 `blocked`，BeefTV 不按等待时间放开重跑**（任务约束「pending → 不让重新生成」）。过了截止时间只改文案为「BeefTV 正在核对，已超过预计时间，可联系客服」，后台按退避继续读，等 BeefAPI 给出 `failed` / `completed` 再按第 3.1 节处理。`reconcile_deadline` 只在 BeefAPI 开了核对循环时才返回，没返回时只显示「正在核对」。待架构师确认的只剩文案和退避间隔。
2. **BeefAPI 的超分、音频等其他任务有没有扣费结论。** 本轮核对【已核】：超分 `GET /v1/media-upscale/tasks/{id}`（`service/fal_upscale.go` `FalUpscaleReceipt`）只在成功时返回 `billing_status`（`settled` / `pending`），失败时没有退款结论；音频 BeefTV 走 `/audio/speech`（同步）和 `/audio/tasks`（`generation/audio.go`），BeefAPI 仓库里查不到 `/audio/tasks` 路由，也没有扣费字段。建议：这两类先按第三方处理（失败取不回就确认重跑）；超分如果要直接放开，需要 BeefAPI 在失败的超分回执里补 `billing_state`，属于 BeefAPI 的改动，另开任务。
3. **第三方渠道「请求没发出」直接放行**（第 3.1 节）：这是 BeefTV 自己记的事实，不是对上游计费的推断，建议保留；若架构师认为也该统一确认，删掉这一行即可。
4. 刷新后自动重发（第 3.9 节）：要不要在提交前把请求体存到本地（InvokeAI 的提交日志），换取刷新后也不用用户再点。代价是多一份本地存储和清理逻辑。
5. BeefAPI 视频的同键去重：先确认生产环境是否已开 `VIDEO_SUBMISSION_GUARD_ENABLED`（〔#30〕4.3 节：9 月有开启记录，当前未读回）；以及 BeefAPI 是否像图片那样在响应头声明视频协议，让 BeefTV 按声明启用。
6. 火山方舟「链接 24 小时、任务 7 天」：过期后重新查询能否拿到新链接，要实测后再定截止按哪个算。火山方舟、可灵的保留期原文还没逐字核对。

## 八、上游 Infinite Canvas

`github.com/basketikun/infinite-canvas` 没有任务中心、异步任务和恢复层（#15 根因说明里的对照），这部分没有可照搬的做法，按 BeefTV 已有的任务、回执、取回循环来收拢。〔状态〕〔防重〕两份调研也确认看过的开源项目里没有可整段照搬的付费确认实现，能借鉴的是模式（幂等键、同事务记账、按保留期查询）。
