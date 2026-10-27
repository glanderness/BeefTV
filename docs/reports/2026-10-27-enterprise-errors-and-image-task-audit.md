# 2026-10-27 企业报错盘点：一张被判失败的腾讯图片任务实际已生成

排查对象：`task_fslEAXD280nHVNy6hIuOINxt4VswNmCG`（2026-10-27 19:52:43，`gpt-image-2.5-flare`，sync_image，渠道 455）。
数据快照：2026-10-27 21:57（CST），生产库 `beefapi-postgres`、生产节点 `VM-4-16-ubuntu`（`new-api-blue`，镜像 `sha256:d1530bc…`，二进制构建于 10-26 17:35，对应 `origin/codex-enhance` 6ef9892758）。
全程只读：没有改渠道、价格、代码，也没有重新提交任何生成请求。

## 结论

- **腾讯售后说的对，图确实生成了。** 我用渠道 455 的凭证直接查 `DescribeTaskDetail`：该任务 `Status=FINISH`、`ErrCode=0`、`Progress=100`，输出 1 张 PNG（1024×1536，2,614,450 字节，`Container=png_pipe`），完成时间 `2026-10-27T11:52:59Z`（北京 19:52:59）。文件是临时存储，有效期到 `2026-11-03T13:32:53Z`（北京 11-03 21:32），我把文件下载下来核对过：HTTP 200、`image/png`、像素尺寸与任务详情一致。
- **后台显示"失败"是我们自己判的，而且判早了。** 请求 19:52:33.695 开始，19:52:43.71 就以 502 收尾，全程 10.03 秒；腾讯那边同一任务到 19:52:59 才 FINISH。也就是说我们在上游还在跑的时候就把结果记成"未确认"，同时按失败处理、不收费。
- **用户侧看到的是失败，不是图。** 返回给客户端的是 422，文案就是你贴的那句「图片任务结果尚未确认。请先查看原任务或联系支持核对，不要重复提交。」后面带三条 id；客户拿不到图，只会以为白跑了。
- **钱没扣。** 这条 request id 在 `logs` 里只有一条 type=5（错误）记录、`quota=0`，`billing_reservations` 里也没有这条的预扣；任务记录里的「已退回」是"失败且未计费"的固定展示文案（`web/src/helpers/task-log-billing.js:150`、`TaskLogsColumnDefs.jsx:430`），不是先扣后退。
- **这张图今天还能交付**：`https://store.vod-qcloud.com/1a168d62vodcq251000800/aad025545001834825778379369/aigcImageGenFile.png`（无需签名，11-03 21:32 后失效）。不需要重跑，也不需要再付一次钱。
- 今天企业组共 **8 条错误日志、38 条失败任务**，绝大多数集中在上游内容审核（版权/敏感）和视频参考素材注册失败；**最需要马上看的是 21:19–21:49 那批 `reference image registration failed`**（同一用户 7 次全挂）。
- **任务记录的筛选确实比使用记录少**，但后端接口早就支持按状态/平台/类型/用户筛，缺的只是前端控件；另外「上游任务号」目前整条链路都查不了——售后给你 `...AigcImageTask-...` 这种官方编号时，后台没法直接搜到对应记录。

## 一、这张图片任务：证据链

### 时间线（北京时间）

| 时间 | 谁 | 发生了什么 |
|---|---|---|
| 19:52:33.695 | BeefAPI | 开始处理请求 `202610271152336920990968268d9d6ZLg1xf97`，日志「用户 7106 额度充足，信任且不需要预扣费 (funding=wallet)」 |
| 19:52:33 | 腾讯 VOD | 素材/图片任务创建，`CreateTime=11:52:33Z`，`BeginProcessTime=11:52:33Z` |
| 19:52:43.71 | BeefAPI | 记 502 + 422，`error_code=vod_image_unknown`，请求总耗时 10.028867572 秒（`use_time=10`） |
| 19:52:59 | 腾讯 VOD | `FinishTime=11:52:59Z`，`Status=FINISH`，`ErrCode=0` |

### 上游回执（我实测调用 `DescribeTaskDetail`，2018-07-17 版本）

- `TaskId`: `1467940581-AigcImageTask-52cec9e89894c26d799bd5c38542a8cet`
- `AigcImageTask.Status=FINISH`、`ErrCode=0`、`ErrCodeExt=""`、`Message=""`、`Progress=100`
- 输入 `ModelName=OG`、`ModelVersion=image2.5_flare_medium`、`OutputConfig.Resolution=1K`、`StorageMode=Temporary`
- 输出 `Output.FileInfos` 1 个：`FileType=""`、`Container=png_pipe`、`Width=1024`、`Height=1536`、`Size=2614450`、`ExpireTime=2026-11-03T13:32:53Z`
- 下载核对：`HTTP 200`、`Content-Type: image/png`、`2614450` 字节，与 MetaData 的 Size 一致

查询请求本身带 `SubAppId=1467940581`（渠道 455 的 key 形如 `vod|<SubAppId>|<SecretId>|<SecretKey>`），换不带 SubAppId 的写法同样返回 FINISH，可以排除"查错了应用/子应用"。

### 内部记录

- `tasks` 行 id=9968：`task_fslEAXD280nHVNy6hIuOINxt4VswNmCG`，platform `sync_image`，action `generate`，group `gpt-pro`，channel 455（Tencent VOD OG 2026-10-15），user 7106，`status=FAILURE`，`progress=100%`，`quota=0`，`created_at=submit_time=finish_time=1793101963`（19:52:43）
- `data`：`upstream_task_id=1467940581-AigcImageTask-52cec9e…`、`upstream_request_id=48b2ab1d-5821-4fce-9d61-b2be795b8ecd`、`attempts[0]={status:502, channel_id:455, error_code:vod_image_unknown, result_unknown:true}`
- `private_data`：`token_id=8883`、`funding_request_id=202610271152336920990968268d9d6ZLg1xf97`
- `logs` 行 id=2255163：type=5（错误），`quota=0`，`use_time=10`，`error_code=vod_image_unknown`，`failure_stage=upstream_status`，`retry_diagnostics.primary_skip_retry=true`（明确禁止了自动重试），`user_status_code=422`
- 同一 request id 在 `logs` 里**只有这一条**，没有消费记录，也没有退款记录；`billing_reservations` 里 0 条

上游号和 `request_id` 都存下来了，只是没人再去用它核对。

## 二、"失败"是在哪一步判出来的

链路（BeefAPI，`origin/codex-enhance` 6ef9892758）：

1. `relay/image_handler.go` 判断是不是 durable 图片任务：`service.IsDurableSyncImage(info)`。这条请求不是（组 `gpt-pro`、按次计价带 billing），走的是**非 durable 的 sync_image 审计路径**。
2. 请求尾部在 defer 里 `service.StashSyncImageAudit` → `controller` 汇总后 `service.RecordSyncImageTask`（`service/sync_image_task.go:114 buildSyncImageTask`）写一条**终态镜像行**：有错就 `status=FAILURE, quota=0`，`fail_reason` 取错误文案前 240 字。这行写完就没人管了。
3. 错误码来自 `relay/channel/tencent/vod_image.go` 的 `NormalizeImageResponse`：`payload.Unknown=true` 且上游 `Response.Error` 为空时，走 `vodImagePresentationError("unknown", …)`，文案取 `relay/channel/tencent/vod_image_presentation.go:32` 的 `unknown` 词条，对外压成 `image_result_unknown` / 日志里记 `vod_image_unknown`。

`payload.Unknown=true` 只有 4 个出口（都在 `vod_image.go` 的轮询循环里）：

| 出口 | 行号 | 条件 | 这次是否可能 |
|---|---|---|---|
| identity 持久化失败 | 447 / 482 | `SetSyncImageUpstreamIdentity` 返回错误 | 否：非 durable 路径没注册 observer，这个函数实际不会失败 |
| 轮询上下文结束 | 464 | 8 分钟 `pollTimeout` 到点，或 `c.Request.Context()` 被取消 | 8 分钟可排除（总耗时 10 秒）；**客户端断开仍在可能范围** |
| 查询拿不到任务 | 501 | 查询返回非 200（且不是 429/5xx），或 200 但响应里没有 `AigcImageTask` | 可能 |
| 状态不认识 | 511 | `Status` 不属于 `FINISH/WAITING/PROCESSING` | 可能 |

另外两个分支可以排除：查询报错（490 行）会把 code 带出来（`query_missing`/`query_auth`/`query_rejected`），而这次日志里 code 是空的 `[]`；创建失败会走 `create_*` 词条，文案也完全不同。

**为什么这次 10 秒就退出了**：轮询间隔 3 秒（`vod_image.go:58`），`10.03s ≈ 创建约 1 秒 + 3 次轮询`，也就是第 3 次查询返回了上面三种"不可用"之一就结束了。

**但现网日志无法区分是哪一种**：`sync_image_poll_stop_reason` 只在 durable 路径被写进 `video_polls.last_error_code`（`relay/sync_image_recovery.go:73-75`），非 durable 的审计行完全不记停止原因，`fail_reason` 三种情况是同一句话。要定论必须补这一行日志——这是本次排查唯一的证据缺口。
（同样的画像：近 11 天一共 11 次 `vod_image_unknown`，`use_time` 分别是 3/10/10/11/11/17/40/120/124/124/181 秒，占图片请求约 0.3%，说明是低频竞态，不是某个客户端的固定超时。）

## 三、结构性缺口（比这一条任务更重要）

1. **"结果未知"被当成"失败"处理。** 对已受理的付费任务，上游没给结论时正确做法是保持待定、稍后按 `upstream_task_id` 复核，而不是直接写 FAILURE 并退款；图现在只能靠人工去腾讯取。BeefAPI 里已经有 `QueryVODImageTask`、`vod_image_recovery.go`、`online_task_recover` 这套能力，但只接在 durable 路径上，sync_image 这条路没接。
2. **轮询上下文挂在客户端连接上。** `vod_image.go:454` 用 `c.Request.Context()` 做 `pollCtx`，客户端一断，已受理的付费任务立刻被判"未知"。同样场景在有 `Idempotency-Key` 的图片中间件里是用 `context.WithoutCancel` 保护的（`middleware/image_submission.go:216`）。
3. **官方任务号不可检索。** 售后给的是 `...AigcImageTask-...`，`tasks` 表只有我们自己的 `task_xxx`；上游号在 `data`/`private_data` 里，接口没有这个过滤条件。这次是靠失败文案里带的 id 才认出来的。

## 四、今天企业组的报错盘点

口径：`logs.type=5`（错误）按 `group='企业'` 过滤 + `tasks.status='FAILURE'` 按 `group='企业'` 过滤。全天总量：错误日志 84 条、失败任务 43 条、任务 725 条（企业占 8 条 / 38 条）。

### 使用记录里的 8 条错误日志

| 时间 | 用户 | 渠道 | 模型 | 错误 | 说明 |
|---|---|---|---|---|---|
| 00:37:02 | 11194 | 280 | claude-fable-5 | unknown_error | `Input is too long >1m`，客户端输入超长 |
| 11:09:13 | 1（内部测试） | 514 | wand-vega-vl-1.0-flash | 400001 | `text must not be null`，我们的调用参数缺字段，值得单独修 |
| 11:26:47 | 8929 | 280 | claude-fable-5 | unknown_error | 同上，输入超长 |
| 11:27:04 | 8929 | 280 | claude-fable-5 | unknown_error | 同上，输入超长 |
| 12:56:01 | 6088 | 455 | gpt-image-2.5 | content_policy_violation | 腾讯 `ContentModerationFailed`，提示词/参考图未过审 |
| 14:36:48 | 10873 | 343 | seedance-2.0-mini | bad_response_status_code | `reference audio 3: could not store reference media` |
| 16:24:43 | 10226 | 506 | deepseek-v4.1-flash | 401008 | 腾讯 TokenHub 免费试用额度用尽且未开按量付费，**这条是我们的渠道配置问题** |
| 17:41:19 | 10454 | 406 | gpt-5.6-sol | unknown_error | 502 上游空回 |

### 任务记录里的 38 条失败任务（按原因归类）

| 平台/渠道 | 原因 | 条数 | 性质 |
|---|---|---|---|
| 54 / 343（whatstoken seedance） | 输出视频疑似版权限制 | 17 | 上游审核，重试无效，需提示用户改题材 |
| 54 / 343 | 输出视频疑似敏感信息 | 5 | 同上；其中 1 条是输出音频敏感 |
| 54 / 343 | 素材下载失败（`tos: read body err: context deadline exceeded`） | 1 | 用户给的素材 URL 拉取超时 |
| 54 / 343 | 首尾帧与参考素材混用 | 1 | 参数冲突，可在客户端前置校验 |
| 23 / 486（WAND 1.5-pro） | 参考图准备失败（`reference image could not be prepared`） | 9 | **今晚集中爆发，见下** |
| 23 / 486 | 视频生成失败（通用） | 4 | 需带上任务号找腾讯取原因 |
| sync_image / 455 | 内容安全 | 1 | 上游审核 |

当天企业组消费记录 1104 条、退款记录 293 条，失败任务的 `quota` 都是 0——即失败都没有实际收费。

### 今晚需要马上看的一批：486 参考图注册失败

| 时间 | 任务 | 用户 |
|---|---|---|
| 20:40:40 | `task_wMxSAhhySsyd1iveuhnSecti0Agw24VG` | 11207 |
| 21:19:58 | `task_pRfSMYaBUxWnerrh6n3GIViEkPkZHkXs` | 11207 |
| 21:45:19 | `task_gmGY1aqv8F36dV1xIRs7zgCcq1SsbF0b` | 11207 |
| 21:45:52 | `task_xrkbIPSzBaxQiRhQFxN9TqqJG63qpaas` | 11207 |
| 21:46:01 | `task_CoCXLaTfSRrDbYIipsCp3wFMeAsBvywn` | 11207 |
| 21:46:12 | `task_c6WvF0WGe8wOxhdfPhzWUygDTD81BX31` | 11207 |
| 21:48:33 | `task_6C6AyoNnfPfx4G7BSV5O2rkYqlInp00I` | 11207 |

- 上游模型都是 `vod/wand-vega-video/1.5-pro`（`origin_model_name=seedance-2.5`）。
- 服务端日志是 `video material preparation failed owner=task_…: reference image registration failed`：指的是**素材注册任务返回 FINISH 但 `ErrCode≠0`、或输出里没有 `asset-` 前缀的资源号**（`relay/channel/task/vod/materials.go:196`）。不是我们网络或存储报错，是腾讯对这张参考图的校验没过。
- 同一用户在 486 上今天还有 23 次成功（21:02–21:51），所以不是渠道整体不可用，更像是某几张参考图/某个提示词组合过不了素材校验；他 21:50 之后又提交了 4 个任务，说明还在反复试。
- 现在这条失败原因只落到一句英文，用户的素材差异看不出来——建议把上游 `ErrCode/ErrCodeExt/Message` 一起记为 `fail_reason` 附加信息。

## 五、任务记录 vs 使用记录：筛选到底差在哪

「任务记录」页面（`web/src/components/table/task-logs/TaskLogsFilters.jsx`）现在只有 3 个条件：

| 页面 | 前端现有筛选 | 后端接口已支持的参数 | 缺什么 |
|---|---|---|---|
| 任务记录 | 时间范围、任务 ID、渠道 ID（管理员） | `/api/task/`：`channel_id`、`platform`、`user_id`、`user_ids`、`task_id`、`status`、`action`、`start_timestamp`、`end_timestamp`（`model/task.go:491 TaskGetAllTasks`） | 状态下拉、平台、类型、用户、**上游任务号** |
| 使用记录 | 时间范围、市场、令牌名称、模型名称、分组、Request ID、渠道 ID、用户名称、日志类型（全部/充值/消费/管理/系统/错误/退款） | `/api/log/`：`type`、`username`、`token_name`、`model_name`、`channel`、`group`、`market`、`request_id` | **成功/失败这一维**：成功是 type=2 消费、失败是 type=5 错误，两条流 |

具体差异：

1. **任务记录的「状态」列有，筛选控件没有。** 状态值就 6 个（`NOT_START/SUBMITTED/QUEUED/IN_PROGRESS/SUCCESS/FAILURE`，另有 `UNKNOWN`），后端 `status=` 已经能用，只是前端表单没放——补一个下拉就能"只看失败"，不用改查询逻辑。
2. **「上游任务号」现在整条链路都查不了。** 售后给的官方编号存在 `tasks.data->>'upstream_task_id'`，接口只按我们的 `task_id` 精确匹配。这条排查里最实用的一个筛选项恰好缺席。
3. **使用记录没有"成功/失败"维度。** 只能在「日志类型」里选「错误」单独看失败流，看不到"某用户今天所有失败"，也没法和消费记录放在一张表里按结果排。要对齐使用记录，需要一个把 type∈(2,5,6) 合并、再按成功/失败筛的视图（或加一列"请求结果" + 对应筛选）。
4. **两边时间口径不同**：任务记录按 `submit_time` 过滤，使用记录按 `created_at`；比对同一条请求时会出现几秒偏差。
5. **费用口径是一致的，不用担心对不上**：sync_image 审计行注释就写明它镜像消费日志的 quota（`service/sync_image_task.go`），这次两边都是 0。

## 六、要跟腾讯售后核对的

1. 这条任务本身：请对方确认 `1467940581-AigcImageTask-52cec9e89894c26d799bd5c38542a8cet` 已成功（我们已自行确认 FINISH + 出图），并说明**任务刚创建后的最初几秒**，`DescribeTaskDetail` 是否可能返回 200 但响应体里没有 `AigcImageTask` 对象——这是我们排名第一的可疑点。
2. 20:40–21:48 这批 `reference image registration failed`：我们拿到的是"素材任务 FINISH 但失败"，没有 `ErrCode/Message`，需要对方按时间（10-27 12:40–13:49Z）和 SubAppId `1467940581` 查素材注册任务的具体拒绝原因（尺寸/格式/内容审核还是并发）。
3. 附带请确认临时文件的保留策略：本次 7 天（`ExpireTime 2026-11-03T13:32:53Z`），是否所有 AIGC 图片任务都是这个口径，我们需要据此决定转存时机。

## 七、建议动作（需批准后才动代码/配置）

不改代码就能做的：

- 今天这张图直接用腾讯的临时文件交付给客户（`https://store.vod-qcloud.com/1a168d62vodcq251000800/aad025545001834825778379369/aigcImageGenFile.png`，11-03 21:32 失效），要长期保存先转存到我们自己的存储；不需要重跑。
- 给该客户（user 7106 / 令牌「小红书」）回一句：这次已确认生成成功，图已补，费用未扣。

代码层（BeefAPI，建议单独立项）：

1. `vod_image.go` 的 4 个 unknown 出口都写 `sync_image_poll_stop_reason` 并落到日志/任务，先把"到底为什么未知"变成可查。
2. unknown 不再直接终态失败：写入待定并由后台按 `upstream_task_id` 异步复核（复用 `QueryVODImageTask`），确认失败才不收费、确认成功就补交付。
3. 轮询 ctx 与客户端连接解耦（对齐 `image_submission` 中间件的 `context.WithoutCancel`）。
4. 任务记录前端加「状态 / 平台 / 类型 / 用户 / 上游任务号」，使用记录加「成功/失败」；上游任务号需要后端补 `data->>'upstream_task_id'` 的过滤。
5. 486 素材注册失败把上游 `ErrCode/ErrCodeExt/Message` 落进 `fail_reason`，否则每次都要翻服务端日志。

## 附：本次用到的查询

- 上游：`DescribeTaskDetail`（VOD 2018-07-17，TC3 签名，`TaskId` + `SubAppId=1467940581`），只读，未调用任何创建类接口。
- 内部：`tasks`（id=9968）、`logs`（id=2255163、`request_id` 全表匹配、type=5 按 group 聚合）、`channels`（455/486/343/485）、`billing_reservations`（该 request 0 条）。
- 服务端日志：`new-api-blue` 容器 json 日志按 request id 与 `video material preparation failed` 关键字过滤。