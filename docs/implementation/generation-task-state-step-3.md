# 后台生成任务状态重构：第 3 步

日期：2026-10-27

## 已实现

- 新增 `POST /tasks/:id/recover`。
- `/recover` 只读取、查询原任务或恢复已有回执；不调用 `RetryTask`，不创建本地任务，也不提交新的上游生成请求。
- 图片失败任务只接受完整且成功的原始图片回执恢复。
- 视频、视频超分失败任务复用原 Provider task ID 查询，保留现有任务号和任务记录。
- 已成功任务通过现有结果交付恢复路径取回已有结果；`/retry` 对成功但尚未交付或暂停交付的任务也只恢复已有交付，不转入新生成。
- `/media-upscale/tasks/:id/recover` 不再对缺少上游任务 ID 的任务转入重试；`/tasks/:id/retry` 继续保留兼容语义。
- 后台恢复循环会查询近期仍有 Provider task ID 的失败视频；自动路径只接受声明为 GET 的状态查询，超分和非 GET 协议留给人工 `/recover`。
- API 调用日志保存 BeefAPI 视频响应中的 `usage_state`、`billing_state`，并保存图片响应头 `X-Image-Job-Id`；计费字段另记录“字段存在”与“字段为空”。这些字段只作为内部计费/恢复证据，不进入公共 JSON 投影。
- 只有正式 BeefAPI 来源的日志才能提供扣费证据；第三方渠道即使返回同名字段，也不会让任务获得免确认重跑资格。
- 视频轮询合并回原始创建日志时，会按字段存在性覆盖扣费状态；显式空值表示仍在结算，不能保留旧的 `refunded` 或 `not_charged`。
- 自动视频查询遇到已确认终态、永久查询拒绝或不支持的协议时，会写入明确恢复结论并停止扫描；网络和服务暂时故障保留下一次轮询。
- 任务 Outcome 只把明确的 `not_charged`、`uncharged`、`no_charge`、`refunded`、`refund_completed` 证据映射为“确认未计费”；缺字段、`unknown`、`charged`、`settled` 或其他值继续是 `confirm`，不会从错误文案推断。

## 明确不在本步

- 不修改前端。
- 不新增任务状态机、队列或计费推断。
- 不把第三方渠道的未知扣费解释为未扣费。
- 未凭空定义尚未在当前渠道协议中确认的 retention 数值，也未发起真实付费生成。
- 第 4–7 步不在本次变更内。

## 验证

- `go test ./... -run '^$'`：全后端包编译通过。
- 新增查询恢复测试覆盖：已有图片成功回执恢复、无 Provider task ID 的视频恢复拒绝重提、失败视频自动查询原任务且只发 GET。
- 新增日志解析测试覆盖 `usage_state` / `billing_state`，并区分字段缺失与显式空值。
- 新增 HTTP 路由级 `/recover` 免费假上游回归，确认结果取回只发 GET、不发 POST。
- 新增自动恢复结论和 24 小时窗口回归：终态/永久拒绝会停止扫描，瞬时 503 保留待轮询，缺少 `started_at` 时按 `created_at` 判断窗口。
- `go test ./internal/app` 相关恢复测试通过；完整包测试仍有现有 `TestFailedThirdPartyVideoRecoveryRenewsOriginalTaskAndMaterializes` 因 Gemini Veo 官方插件未安装而失败，不能把该失败归因于本步改动。
- `go test ./...` 另受本地未构建 `plugin-packages`、缺少 `@earendil-works/pi-coding-agent` 以及部分 harness 缺表影响；本步相关包无新增失败。

## 权限与迁移评审结论

- `/tasks/:id/recover` 只经过 `currentUser`，任务仍由 `TaskForUser` 按用户归属读取；不需要桌面可信写权限，因为该接口不提交生成、不写渠道配置、不执行扣费动作。
- `/tasks/:id/retry` 和原超分恢复入口继续保留桌面可信写权限/兼容语义；本路由没有复用它们的扣费分支。
- `ApiCallLog` 新增的计费/恢复字段由现有 `LocalModels` 的 `AutoMigrate` 管理，旧日志可正常读取；没有新增任务状态列或独立迁移状态机。

## 后续评审重点

1. 结合各渠道正式协议补齐并验证自动查询 retention 配置。
2. 确认 BeefAPI 图片 `X-Image-Job-Id` 对应的只读扣费查询接口，再接入 `billing_state` 查询，而不是由 BeefTV 推断。
3. 已用免费假上游补充 HTTP 路由级回归，断言 `/recover` 的上游请求始终没有 POST；后续仍需结合正式渠道协议补齐 retention。
