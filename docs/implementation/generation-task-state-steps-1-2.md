# 生成任务状态重构：第 1、2 步实施说明

状态：独立评审提出的两项阻塞问题已修正，待复审；没有开 PR、合并、发布或更新本机应用。

依据：`docs/architecture/generation-task-state.md` 第四节第 1、2 步及任务 #25。起点为本任务分支的 `1bf517b`；不合入 #16 的前端改动。本文记录本分支事实，不把后续步骤当成已经实现。

## 1. 实际改动

| 位置 | 改动 |
| --- | --- |
| `backend/internal/task/outcome.go`、`outcome_test.go` | 纯函数 `ComputeOutcome`；根据任务、派发、提交与交付事实计算 `phase/regenerate/reason`，不解析错误文案、不写状态、不授权消费 |
| `backend/internal/model/models_task.go`、`task/contracts.go`、`taskdelivery/project.go` | 详情与列表增加 `outcome`，继续返回旧字段；新增私有可空 `RecoveryOutcome`，公共投影不持久化 |
| `backend/internal/app/task_outcome.go`、`task_delivery.go`、`task_domain_adapter.go` | 同一任务交付投影计算 Outcome；详情、列表、by-operation 批量读取小字段，不加载或解密冻结媒体请求；排队、运行中与成功任务不查恢复证据 |
| `backend/internal/repository/repository.go` | 列表选择补齐归属、原轮次与恢复结论，避免详情与列表算出不同结论；成功完成清除恢复结论和轮询退避 |
| `backend/internal/repository/image_recovery.go` | 扫描全部可能已接纳的失败图片，包含无路由记录的历史创建回执；按任务 ID 游标前进，恢复写入受原任务租约、用户、状态与轮次保护 |
| `backend/internal/app/image_auto_recovery.go` | 现有 5 秒交付循环触发一个受 worker 管理的独立恢复批次；先看原回执，再考虑冻结请求同键恢复；不等该批结束才下载其他结果 |
| `backend/internal/app/image_submission.go`、`repository/image_submission.go` | 复用原冻结请求发送函数，增加失败任务租约内的单次重放；冻结原渠道标识，不重新排队、不新建任务、不递增 `routeRun`、不切换路由 |
| `backend/internal/app/image_recovery_identity.go` | 自动 POST 前及实际发送准入时核对原渠道、同源地址和原传输凭据；当前凭据只用于比对，绝不替换冻结 Header |
| `backend/internal/app/image_result_recovery.go`、`repository/analytics.go` | 人工与自动共用原回执解析；原 `/retry` 仍保留恢复分支；回执歧义使用具名错误，自动路径不会吞掉数据库错误 |
| `backend/internal/generation/http.go` | 带发送准入的冻结图片 POST 禁止跟随重定向，避免将幂等合同转给其他端点；不改变普通 GET 下载行为 |
| `backend/internal/database/local_schema.go` | 追加 v26 `task-recovery-outcome`；仅新增 `recovery_outcome TEXT NULL`，没有默认值、没有回填，不改旧 ledger |
| `backend/internal/app/storage_quota.go`、`repository/local_runtime.go` | 既有成功完成、主动重跑路径清理上轮恢复结论；恢复遇到配额等暂时错误仍保留未决事实并退避 |
| `backend/internal/app/service.go` | 仅增加恢复批次占用标记与扫描游标；没有独立队列或第二份任务生命周期 |
| `docs/content/docs/backend/backend-database.mdx`、`http-api.mdx` | 同步 v26、读投影、自动恢复条件和尚未实现的范围 |

没有改 `web/`、视频提交/查询、超分恢复、MCP/CLI 审批、报价或用户同意表，没有新增 `/recover`。`outcome.regenerate` 目前只是读投影，不是付费准入凭据；第 3–7 步的收费守门尚未接入。

## 2. 恢复规则与安全约束

- 候选为 `failed + canvas_image`，并满足当前轮 `accepted/submission_unknown`、`stage=submission_unknown`、存在同用户图片创建回执三者之一。取消、运行中、视频与异主回执不进入这个扫描。
- 每轮上限 **8**，独立批次的上下文预算为 **15 秒**；每次同键 POST 最多 **5 秒**。发送、网络或存储暂时失败复用 `next_poll_at`，退避 **30 秒至 15 分钟**。批次由既有 worker 计入在途工作，停机与暂停仍受其管理。
- 原回执完整且明确成功时直接恢复 URL，再由现有下载、资源保存和画布绑定处理。节点删除、已换任务等原有绑定保护不变。
- 只有当前轮次保存的加密请求、已保存的幂等协议声明、合法 HTTPS 图片端点、可核对的原键以及仍可使用的原渠道与凭据身份同时成立，才允许自动 POST。请求正文、端点和 Header 沿用原快照，不用当前提示词、素材或渠道配置重建请求；当前渠道配置只用于检查可用性及身份，不能替换快照中的地址或凭据。发送前还会再次校验原 attempt、任务租约与当前轮次。
- 同键传输也会追加多条 API 日志。多条日志不能挑一条旧成功结果，但不妨碍用可验证的当前冻结请求、原键取回确切回执；缺少这种证据的冲突历史写 `unrecoverable`。当前路由开始前的回执不能覆盖当前轮结果。
- 后台恢复不再以原 worker 的 **12 次**发送计数判定结果丢失；仍沿用已核实的 BeefAPI 图片回执窗口 **首次保存后 23 小时**。没有扩大为其他渠道通用重试器。
- `no_result` 只表示没有结果；计费不明仍投影为 `confirm`。过期、原始证据缺失/不完整且无法安全重放则为 `unrecoverable + confirm`。数据库、锁、DNS、取消、配额等暂时失败不写这两类结论。回执分类同时检查 HTTP 状态：408/429/5xx 的通用错误 JSON 不证明生成失败，仍可按原键取回；2xx 的明确业务失败、已知幂等终态码及 401/403 分别保留原有终态处理。
- 重启后的 `running` 不改成 `cancelled`，继续由现有过期租约领取与原派发恢复处理；本任务没有重写启动逻辑。

上述批次上限、时限与退避是本次实现参数。
Basis：任务 #25 的「不拖慢既有下载循环」问题、既有 worker/租约机制及本任务范围内的实现判断；不是渠道新增收费声明。

### 2.1 原渠道与凭据身份：追加要求的落实

依据：用户本轮明确要求，以及只读核对分支 `tds/conv-01a17917-d69d-7ec8-8eb5-6f74947500fa` 的 `docs/research/paid-permission-and-regenerate.md` 第四节；未合并该分支。该报告给出的 BeefAPI 去重范围是 `market:userID:tokenID:key`，因此**只保持同一个键并不足以防止重复购买**。

- 原 `RouteAttempt.ChannelID` 优先；新增冻结请求在原加密 JSON 内补存 `ChannelID`，不改变上游请求正文或任务 API，也不追加数据库列。
- 发送前先检查原渠道仍存在且启用、原源地址与实际冻结地址同源、当前有效 Bearer 凭据及其他鉴权 Header 与原快照完全相同。真正交给传输前再次检查；并发停用或换 token 不消耗发送次数。这项发送准入也覆盖原 worker 对已发送图片的继续等待/重启重放，不仅限于新增失败任务扫描。
- 任务当前输入已选另一个渠道时，仍只核对原 attempt；传输使用原地址、原键、原 Header、原正文，运行时统计与并发渠道也固定到原渠道。不会重新选路或自动尝试备用渠道。
- 原渠道删除/停用、凭据或源地址替换、快照渠道不一致时，后台停止 POST，持久化 `unrecoverable`，读投影为 `failed + confirm`。上游对原凭据返回 401/403 也停止自动恢复；这些结论都不代表未计费。
- 已有完整成功回执仍可直接取回与下载，不因渠道停用而扔掉结果。数据库或本地凭据读取故障仍只退避，不写永久结论。
- 历史系统路由快照没有新增字段时，可由原 attempt 验证渠道；历史直连只有在能明确识别原托管源并核对同一原 Bearer 身份时恢复。其他缺少原渠道证据的直连记录不自动 POST，进入拿不回/需确认，不猜测新渠道。

Basis：用户追加要求及上述报告第四节。校验的是实际冻结的鉴权值，而不是当前任务中可变的展示名称；绝不把新 token 填进旧请求。

## 3. 验证

### 本机假上游：历史回执到旧画布字段

入口：`backend/internal/app/image_auto_recovery_test.go` 的 `TestHistoricalImageAutoRecoveryDownloadsAndBindsLegacyCanvas`。

测试创建独立临时 SQLite 工作区、旧画布和失败图片任务，**不创建 RouteAttempt 或 ImageSubmission**。历史成功回执指向本机 `httptest` 图片服务；只启动真实的交付定时器，不启动会执行生成的主任务 worker，不调用 `/retry`。

已经观察到：

1. 后台恢复原任务，原 `routeRun=3` 不变；
2. 本机假上游收到 **GET=1、POST=0**；
3. PNG 下载为本地资源，任务投影成为 `ready`；
4. 原画布节点得到旧客户端使用的 `status=success`、`content` 和 `storageKey`；
5. 本地任务数没有增加，路由记录仍为零。

测试打印的脱敏证据：

```text
历史回执→后台重建→GET 下载→旧画布 success/content：通过；task=historical-image routeRun=3，GET=1 POST=0
```

**未做实际旧前端浏览器展示验收。** 本次未构建/启动前端或正式桌面应用，没有截图、浏览器绘制或真实页面同步证据。替代验证覆盖到服务端持久画布的旧消费字段，不能将其写成「已经看到旧页面显示成片」。如果上线门槛要求真实页面读回，须在独立评审后用同样的免费夹具补验；不得用真实账户点生成替代。

### 其他专项覆盖

- `task/outcome_test.go`：22 个表格场景，覆盖运行、下载、入库、恢复、未发送、审核、计费不明；把错误文案换成「退款/审核/超时」也不改变计算。
- `app/image_recovery_scan_test.go`：候选扫描含无路由回执；前段任务争用租约时游标仍向后；关闭并重开真实 SQLite 文件后重新领取旧 `running`，仍是原任务、原轮次，不取消。
- `app/image_auto_recovery_test.go`：缺失、残缺、多条冲突回执与业务失败分别分类；数据库读取故障和租约争用不写永久结论；JSON 与 multipart 在旧计数上限之外仍按保存的原字节、原键发送到本机 TLS 假服务。
- `app/image_auto_recovery_continuity_test.go`：多条未知发送日志后仍可同键等待；明确过期停止；旧轮次成功回执不覆盖当前轮；2xx 正文中的业务失败不被当成成功图片。
- `app/image_recovery_identity_test.go`：冻结原 attempt 渠道；当前任务改选其他渠道仍只用原身份；删除/停用/换源/换 token/快照身份不一致均零发送且最终读投影为拿不回/需确认；发送准入期间再停用/换 token 也零发送；渠道读取失败仅退避；原凭据 401/403 停止；托管和自定义直连凭据核对；旧 running worker 的同键重放在停用、删除或换 token 时也零发送。
- `handler/task_outcome_test.go`：详情、列表、by-operation 均返回一致 `outcome`，保留旧任务状态，不返回私有恢复列或凭据。
- `app/image_recovery_review_test.go`：独立评审回归；唯一 408/429/500/503 通用错误回执不提前终止恢复，连续临时故障后仍使用原身份、原键、原正文取回成功结果并保存；已知终态和 2xx 业务失败保持区分。三个读入口均以两份约 1.25 MiB 不透明快照检查实际 SQL，失败任务只查一次小字段提交证据，排队、运行中及成功任务不查提交证据。
- `database/local_schema_task_recovery_test.go`：v25→v26 可空、无默认值、无回填、未知列保留、重复迁移幂等、缺列拒绝 Ready；注入 ledger 写入失败后 DDL 与版本同时回滚。既有历史迁移断言增加 v26，而不改旧身份。
- `generation/image_replay_redirect_test.go`：307 不把冻结 POST 转发到第二个端点。
- 原人工 `/retry` 回执恢复与既有图片提交测试继续作为回归，不删除或放宽旧安全断言。

最新核心包、图片行为矩阵及相关竞态专项已通过。历史回执→本地下载→旧画布字段的同一免费夹具另连续运行三次通过。此前 `go test -p 4 -timeout 8m ./...` 在 app 包达到 8 分钟上限，没有完整通过；不能将这次超时说成已确认的既有产品缺陷，仍需在评审/PR 前补足完整回归。

完整命令与最终回执见同目录 `generation-task-state-steps-1-2-verification.txt`。验证只使用临时目录、本机假服务与假凭据；没有调用真实付费生成或打开真实用户数据库。

## 4. 与方案或任务前提不一致之处

1. **没有 PostgreSQL 实现。** 当前 `database.Open`、Go 驱动和仓库约定均只支持 SQLite。任务提到的 PostgreSQL Compose 前提过时；本次不新增数据库后端。
2. **图片订阅没有独立后台推送。** 当前调用方通过任务读取轮询订阅图片；新增投影覆盖其读接口。文本 SSE 不承载这份图片任务投影，本次没有改变其事件合同。
3. **未新增各渠道保留期和退款声明配置。** 本步只覆盖已保存协议声明的图片冻结请求，沿用 23 小时。`ConfirmedUncharged` 是纯函数输入；当前没有渠道退款元数据就保持 false，不凭上游失败推定免费。视频、超分和更广的渠道能力工作后置。
4. **实际浏览器验收缺口如上。** 自动后台链与旧画布数据已验证，不把它冒充旧 UI 的实际绘制证据。
5. **完整回归及静态检查的结果以验证文件为准。** 初次全量测试因未生成官方协议包、未安装锁定的 agent-host 依赖失败；已按 CI 前置步骤补齐，未改锁文件。扩大 `go vet` 范围还会报告未改动文件中的既有告警，不为本任务顺手修视频上传或其他代码。

### 实现方结构自查（不替代独立评审）

以 `1bf517b` 加本分支变更为范围检查了纯函数/读投影、批量事实查询、冻结请求发送准入、现有 worker 生命周期、租约写入与 SQLite 迁移。恢复仍调用原发送、下载及画布绑定实现；身份检查独立在 `image_recovery_identity.go`，没有新队列、独立传输客户端或第二份任务状态，没有新增依赖。新字段只追加到旧表及原加密请求 JSON，未另建收费授权模型。

本分支已收到独立评审意见，本轮按两项阻塞意见修改并自测；这不代表复审通过。完整回归与实际浏览器展示的缺口保留给 Chief 交接，不据此批准发布。

## 5. 回退与交接

- 只撤回读投影和自动恢复逻辑时，使用仍识别 v26 的修复构建；不改已应用的迁移记录。
- 如必须回到只支持 v25 的程序，先停止所有写入者，恢复升级前完整工作区备份到独立目录，由匹配版本的程序打开。不得删列、降低 ledger 或让旧程序直接写升级库。升级后新增数据须保留，由负责人决定如何迁回。
- 本任务没有操作真实备份、迁移真实工作区、安装应用或生成发布产物。
- 收尾停在 review，由 Chief 安排「架构师」独立看固定 diff，尤其检查冻结请求的发送准入、历史回执扫描、失败分类、租约与迁移。实现方的测试和自查不代替独立评审。
- 评审通过后再按用户要求建立正式中文 PR；本次不建 PR、不合并、不发布。平台的 Done 会直接合入 main，因此不要把 Done 当成「待评审」操作。

## 6. 独立评审修订（2026-10-27）

### 阻塞 1：临时 HTTP 回执被写成永久 `no_result`

根因是历史回执分类只看正文；通用 `error.code=internal_error` 会命中业务失败解析，即使 HTTP 是 503。原专项覆盖过发送中的临时失败，但漏了「唯一已保存回执是临时 HTTP 错误」这一输入。

`image_auto_recovery.go` 现改为 `imageReceiptConclusion(receipt.StatusCode, receipt.ResponseBody)`，非 2xx 通用错误正文不再单独产生 `no_result`。明确幂等过期/冲突仍停止；401/403 仍表示原身份无法继续取回。其余暂时失败返回空恢复结论，由既有编排保留退避和下一轮机会，不改变原渠道/原键准入。

新增用例对唯一 408/429/500/503 回执，连续两次注入 HTTP 503 后，第三次返回同键成功结果并保存；原 URL、Authorization、Idempotency-Key 和正文不变，原任务与 `routeRun` 保留，最终没有永久失败结论。仅使用假发送函数与假凭据。

### 阻塞 2：普通任务轮询读取并解密大请求

根因是批量证据查询直接读取完整 `ImageSubmission`，而 `taskOutcomeFacts` 对每行执行冻结请求解密；批量查库并不等于媒体读取成本可控。

`repository/image_recovery.go` 改用不包含 `RequestCipher` 的 `ImageSubmissionEvidence`，提交证据只选 `attempt_id/task_id/user_id/response_accepted`；路由也只选使用到的小字段。`task_outcome.go` 删除读投影的 `safeFrozenImageReplay` 调用，排队、运行中与成功任务跳过恢复证据查询。未决结论继续由已有派发状态、回执存在及接纳事实计算，不从精简字段宣称已获安全发送资格。

仅 `failedImageResultWith` 确认需要原键恢复后，按原 attempt、task、user 查询完整请求，继续执行所有原有协议、年龄、原键及原凭据检查。没有新增缓存、数据库列或另一份安全声明。

新增 SQL 回归对详情、列表及 by-operation 逐一检查：不得选择 `request_cipher` 或整行；两个失败任务只有一次批量提交证据查询，排队/运行中/成功为零次。以大而不可解密的快照验证读取不依赖它；这是查询形状验证，不是峰值内存或吞吐基准。

上述两个新增用例在修前生产代码的临时 Go overlay 下均按目标断言失败，修后通过；没有倒改工作树还原旧代码。最新命令和回执见验证文件末节。本轮不提前实现 #32 的新计费映射、不补做前端，不将专项通过称为全量通过。
