---
half_life: 7d
archive_at: event:step-3-implemented
artifact_mode: delivery-doc
scope_type: phase
scope_name: 生成任务第 3 步查因、方案调整与最小验证
coverage: 免费取回、操作回放、扣费事实及其组合行为
not_complete_for: 第 4–7 步、前端、正式实现、真实付费验收、发布
verification_level: local
real_smoke_status: not_required
review_status: not_reviewed
reviewer: none
review_command: 本研究由当前架构师自查，未申请另一位评审
review_notes: 真实源码与临时 SQLite 测试；扣费实验只改临时副本
review_owner: 第 3 步后续实现者
review_due: event:formal-step-3-implementation
execution_backend: direct
lead_agent: current
peer_agents: none
builder_agent: none
verifier_agent: none
verification_independence: self_checked
cwf_decision: not_needed
cwf_trigger_boundary: none
goal_handoff: skipped
acceptance_contract_status: proposed
memory_required: false
memory_space: default
acceptance_memory_id: none
---

# 生成任务第 3 步复核：为何反复漏改，怎样最小调整

结论：不是整套任务架构需要重写。反复漏改有四个可核实原因：方案对免费操作回执的约定互相冲突；原值在进入判定前被压成一个布尔值；手动、自动恢复与日志分别持有一部分判断；测试验证了局部实现，却没有验证一次操作从接纳、取回到再次点击的完整行为。会话过重和说明未更新加剧了交接困难，但没有证据证明“上下文长”本身就是代码漏改的原因。

建议沿用现有任务、SQLite 事务、操作回执与恢复租约。第 3 步改为：**先统一操作接纳和免费恢复，再保存本轮扣费原值，最后补查询与下载的完整恢复测试。**不增加计费状态机，不扩到费用确认或前端。

## 1. 研究范围与固定证据

本次帮助第 3 步实现者修正方案，用当前代码和无费用反例定位原因。方案修改见[生成任务方案第 3.11 节](../architecture/generation-task-state.md#311-第-3-步专项调整先固定操作再执行和投影)。原第 4 轮已获用户批准；本次新调整是研究建议，不把研究授权写成正式功能实现或发布授权。

| 输入 | 本次使用的版本与证据级别 |
| --- | --- |
| 本研究分支起点 | BeefTV `c99cba49`；只编辑方案、研究文档和隔离实验文件 |
| #68 实现 | 重新 fetch `tds/conv-01a17d1f-1c47-7765-b433-c2afe8ff9358`，固定 `e08b6bea5f35a4ebe48e942cd482805ccacce163`；没有使用默认分支冒充 #68 |
| #54 与 #68 历史 | 两项任务 spec、#68 最新会话及提交历史；只解释交接过程，不代替现状 |
| 上游接口 | BeefAPI 默认分支重新 fetch 后固定 `be8f70726a385e77d5bc0aae242f47ab92c7c7ab`；核对 `controller/image_jobs.go`、`model/task.go`、`relay/relay_task.go`、`dto/task.go` |
| 旧接口依据 | 对照方案引用的 BeefAPI `b9343cb`；实时查询省略扣费字段的分支当时已经存在 |
| 验证 | 实际 Service、repository、投影函数，临时 SQLite、本地 HTTP 假上游；未使用正式客户端、用户数据库或真实生成服务 |

记忆检索使用 nmem `default` Space，命中较早的原位再生成记录；它不是本次第 3 步的现行验收依据。现行依据以用户给定 spec、已批准方案和以上固定源码为准。本次研究结论主动保存为 nmem `e434fad7-6b40-4d11-a7fa-d181b2d846af`，团队项目记忆 `rOas8NtnhyqP8jVD8lXeo`；这是研究索引，不是新的用户批准记录，未另建本机记忆副本。

## 2. 最新实现已做到什么

旧评审里的“完全没做”有一部分已经不成立：

- `handler/routes.go` 已读取 `clientOperationId`，`Service.RetryTaskWithOperation` 已进入持久操作回执；付费入队与回执写入在同一个事务。
- `/retry` 已对有原上游 ID、非 `submission_unknown` 的失败视频调用原任务查询；图片也新增 `imageJobResult` 的 GET 查询。不能继续说所有可取回视频都会直接重新入队。
- 日志已限制正式来源，并保留字段存在标记；合并时显式空值可以覆盖旧值。这些修复有效，但没有解决本轮身份和投影问题。
- `/recover` 对 `delivery_paused`、`delivery_timed_out` 都调用 `resumeGenerationDownload`。本次补充实际交付夹具，两种状态均解除暂停、取回图片、投影 `ready`，且没有新增生成。

`docs/implementation/generation-task-state-step-3.md` 仍说图片查询未接入，映射仍以旧字符串表描述；说明未随最后提交更新。该文件不能用作最新实现清单。

## 3. 可复核的因果链

### 3.1 操作回执被误当成付费专用回执

原方案第 3.3 节要求同编号重放返回原任务，第 3.6 节却说“免费取回不写这条回执”；迁移期 `/retry` 恰好同时承载免费取回和付费重跑。照着后一句实现，就无法满足前一句。

`app/service.go:retryTask` 在进入任务域前完成免费恢复并返回；只有 `repository/local_runtime.go:retryTaskWithOperation` 的付费入队分支写 `AgentOpRecord`。图片首次恢复完成并交付后，再次携同一编号请求，任务已成功，免费分支不再处理，随后任务域报 `only failed or cancelled tasks can be retried`。

本次实测：`GET=1`、新生成请求 `0`、本地任务 `1`、`routeRun=3` 不变，但操作回执 `0`，第二次返回错误。因此是重放合同没完成，不能把它夸大成这个案例已重复扣费。

还有一个独立事实：付费回执直接 `json.Marshal(model.Task)`，但 `Task.RouteRun` 标注 `json:"-"`。四个并发接纳只增加一轮；关闭、重开临时数据库后同编号没有再次入队，但回执解码后的轮次从 `4` 变 `0`。去重有效，不等于回执完整。本次不把普通数据库重开称为强杀或断电测试。

**调整：**所有带编号的兼容 `/retry` 先固定动作与轮次；回执存专用小结构，表示“已接纳哪次操作”。免费操作不写付费同意。不要等媒体已经恢复后再单独补回执，那个顺序仍有进程退出缺口。网络恢复继续使用已有任务和租约。

### 3.2 判定输入丢信息，修日志无法修结果

`app/task_outcome.go:taskOutcomeFacts` 把两个原字段压成 `ConfirmedUncharged bool`。`false` 同时代表“结算中”“已扣费”“没有查询字段”。`task/outcome.go:ComputeOutcome` 无法再区分它们；`RecoveryUnrecoverable` 又硬编码 `confirm`，覆盖已经知道的退款结论。

上游 `TaskUsageDisplayOf` 和 `GetImageJob` 仍支持原方案所列的关键取值，不是接口突然删除了退款或空值约定。现有 `TestBillingEvidenceConfirmsNoChargeOnlyForExplicitStates` 甚至明确要求不识别视频 `usage_state=failed`；该测试与已批准方案相反，并且本次复跑仍为绿灯。

**调整：**把原值和字段是否存在传到唯一投影函数，按图片/视频协议分别映射；“结果取不回”和“钱是否退回”分开计算。只调整两个文件的临时补丁使六个持久事实案例由 **2/6 通过变成 6/6 通过**。没有新增数据库状态或执行循环。补丁没有解决身份、协议、回执与并发，不可作为生产修复合入。

### 3.3 日志聚合承担了业务事实职责，任务号又可跨轮复用

`repository/analytics.go:TaskProviderBillingEvidence` 只找同用户、同任务号的最新正式来源日志；没有当前 `routeRun`、派发渠道和原上游身份条件。`VideoAPICallRoot` 在有 task ID 时也只按任务号找创建日志；`LatestBeefAPIImageJobIDForTask` 同样不分轮次。加一个来源过滤，只能隔离第三方同名字段，不能防止旧正式渠道事实继续被采用。

本次用同一任务第 1 轮的 `refunded` 日志，第 2 轮切到没有扣费结论的渠道，实际投影仍为 `failed/allowed`。这是已经复现的跨轮次证据错误。这里验证的是 Outcome，不声称第 4–5 步收费守门已经存在或这个夹具真的发出了第二次收费请求。

**调整：**回到原方案“存进任务”的做法，保留一份当前轮次的扣费查询原值。适配器写业务事实，日志只保留诊断；接纳新轮次时清空旧事实，迟到查询按原轮次条件更新。不要继续给日志聚合增加一层层收费判断。

### 3.4 协议与恢复路径没有被同一条验证穿过

| 位置与当前事实 | 为什么局部检查会漏 | 应改什么 |
| --- | --- | --- |
| `queryBeefAPIVideoResult` 仍查询 `/v1/videos/{id}` | 假响应只写 `status`；测 GET 成功不等于测到了 `usage_state` | 使用真实 `/video/generations` DTO 信封与缺字段响应夹具，验证持久化后 Outcome |
| `imageJobResult` 已有 GET，但自动图片恢复走 `failedImageResultWith`，没有调用它 | 手动路径通过，不能证明后台循环也会查图片 job | 复用同一免费恢复入口及相同适配器 |
| 同步图片 job 可能只给 `result_url`；当前 `imageJobData` 不认识这个字段 | 只测 `data/images/result/output` 形状，漏掉实际两段查询 | 再 GET 原结果端点，按 JSON 解析图片，分别保存结算与结果事实 |
| 视频新接口在 `tryRealtimeFetch` 可以提前返回无扣费字段的响应 | 原方案只读 `TaskDto`，把字段声明误当整条接口的保证 | 成功缺键与请求失败分别处理；不把缺键当 `pending` |
| 自动视频恢复加入 GET-only，直接排除超分/RunningHub | 只断言“POST 为零”，把“免费”误写成 HTTP 方法 | 断言请求用途不是 `create`，保留既有合法查询 POST |
| 扫描用固定 24h WHERE 排除老任务，未写结束原因 | 旧测试只验证“不会再扫描”，没读用户看到的 Outcome | 到期先形成结果结论；未知期限不能假定过期 |
| `queryBeefAPIVideoResult` 把查询与下载都作为一个返回错误；`automaticProviderRecoveryOutcome` 按轮询错误分类 | 只测状态接口 503，未测上游成功后的下载失败 | 分开保存结果与交付进度，临时下载错误仍可恢复 |

最后一项已用真实 HTTP 截断响应复现：上游状态查询 1 次，下载尝试 4 次，返回短内容后写 `unrecoverable`，而不是保留后续下载。早期夹具因未初始化渠道协调器未到达 HTTP；修正为仓库已有运行时测试工厂后才采纳此结论，未把测试设施错误算产品错误。

### 3.5 交接与验证本身也在漏

两次旧修订回复把本步要求的图片查询、保留期配置等写成“后续评审重点”；最后提交修了部分内容，实现文档却没跟进。会话里数次压缩和 heavy 标记是已观察到的事实；模型为何作出每个取舍不可从这些记录推出。

可以确定的是验收对象不一致：方案讲一次用户操作，测试多为映射 helper、来源过滤、仓储入队、扫描 WHERE 各自通过。旧测试 **5/5 通过**，同提交上本次组合与协议测试却有 **11 个反例**。这足以否定“再跑同一批定向测试就算补齐”，不需要猜测模型内部原因。

## 4. 主流做法中真正适用的部分

比较问题只有两个：重复请求的身份由谁保存；一次部分成功的任务应该重做哪一步。来源限下面四份官方资料，能回答后停止，不引入任何框架依赖。

| 官方来源 | 适用到本项目的做法 | 不照搬的部分 |
| --- | --- | --- |
| [AWS Builders’ Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) | 客户端操作 ID 与本地接纳变更同事务；重复请求给等价答复 | SQLite 事务不能覆盖上游 HTTP，不宣称跨系统恰好执行一次 |
| [Google AIP-155](https://google.aip.dev/155) | 已提供请求 ID 就保证幂等；允许回读资源当前状态 | 它建议 ID 可选，本项目何时必填由已批准第 4–5 步决定，不能引用它提前拒绝旧客户端 |
| [Temporal Activity 定义](https://docs.temporal.io/activity-definition#idempotency) | 完成后尚未报告就崩溃会重执行；把可能重复收费的执行与结果交付分开 | 不安装 Temporal，也不认为持久执行器会自动保证外部扣费幂等 |
| [BullMQ 幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs) | 一个可重试步骤应足够小，部分成功后不把所有动作重做 | 不增加 Redis、队列或第二套任务状态 |

这些是机制参考。免费取回、结算中等待、第三方未知需确认的产品规则仍来自用户批准方案，不来自竞品偏好或本次评审。

## 5. 最小改法及实施检查点

完整调整以方案第 3.11 节为唯一实施说明，本报告只解释证据。三个变化足够：

1. **一个操作编排入口。** app 选择免费恢复或付费入队；repository 写原子接纳；恢复网络 I/O 不放在事务里。删除 app/task 重复操作回读和错误翻译，手动/自动共用恢复适配器。
2. **一份本轮扣费原值。** 在当前任务持久化带身份的原值观察；纯函数计算 `Outcome`。不保留用日志决定重跑的第二种来源，不增加派发收费规则表。
3. **按用户动作交付测试。** 从一次带编号请求开始，跨取回/交付/再次请求/数据库重开验证；从真实查询响应到数据库再到 Outcome 验证。查询与下载各自失败时只重试相应部分。

本次明确不做：新费用预览、用户同意表、操作编号必填拒绝、前端变动、外部付费权限开关、正式修复、PR、合并、发布。未改 #68 分支。方案涉及用户行为的每一项都在第 3.11 节列出 Basis。

## 6. 可重跑证据与验收状态

实验目录：[step-3-recheck](step-3-recheck/)。`run.py` 只对指定仓库执行 `rev-parse`、`archive`，复制固定提交到当前分支的 `.local/cache` 临时目录，注入研究测试后调用真实 Go 代码。退出自动删除源码副本与 SQLite 临时数据，不更改源仓库。测试进程不继承团队密钥。

以下命令中，把 `/path/to/BeefTV` 换成已包含 `e08b6bea` 的本地仓库。首次 Go 模块准备可能需要下载依赖，不会调用生成 API。

```sh
python3 docs/research/step-3-recheck/run.py --repo /path/to/BeefTV --output .local/cache/step3-baseline.json
python3 docs/research/step-3-recheck/run.py --repo /path/to/BeefTV --billing-probe --run '^TestStep3BillingContract$' --output .local/cache/step3-billing.json
```

基线命令应退出 `1`：这是确认原代码违背预期的研究测试，不是修复后全绿。补丁实验命令退出 `0`。结果按最末级测试计数，排除父级测试重复统计。

| 验收问题 | 证据级别与入口 | 基线结果 | 能证明什么 |
| --- | --- | --- | --- |
| 六种扣费事实是否正确投影 | 临时 SQLite → `taskOutcomeFacts` → `ComputeOutcome` | 2/6 通过 | 视频退款、视频 pending、图片空值、不可取回但已退款四项失败 |
| 新轮次不引用旧退款 | SQLite 更新 `routeRun`、渠道后重新投影 | 失败 | 旧退款仍使新轮次 `allowed` |
| 免费取回完成后同编号重放 | `RetryTaskWithOperation` → 交付器 → 同入口 | 失败 | 未重复生成，但无回执并报重试资格错误 |
| 并发接纳、数据库重开后不再入队 | 四个并发 repository 请求 → 关闭重开同库 | 通过 | 只增加一轮、回执一条、再次失败后重放不入队；没有启动上游生成 worker |
| 回执保留原生成轮次 | 上一场景读持久回执 | 失败 | 库里为 4，回放为 0 |
| 两种暂停解除并完成交付 | `RecoverTask` → 本地 HTTP 图片 → 任务读回 | 2/2 通过 | 两种状态都到 `ready`，GET 一次、新生成为零 |
| 视频真的走扣费查询路径 | 生产查询函数 → HTTP 路径记录 | 失败 | 仍是 `/v1/videos/original`；不证明新 URL 解析已完成 |
| 同步图片真实结果响应被识别 | 上游源码夹具 → 生产 `imageJobData` | 失败 | `result_url` 没有被处理；该项只测解析，未运行 BeefAPI 服务 |
| 停止扫描后有结果结论 | 老任务 → 自动扫描 → Outcome | 失败 | 超过 24h 被排除但仍显示 `retrievable` |
| 临时下载失败保留恢复机会 | 生产自动查询 → 假上游 completed → 截断视频 | 失败 | 下载失败被写成 `unrecoverable` |

合计 **16 个最末级检查，5 个通过、11 个失败**。完整精简记录：[baseline.json](step-3-recheck/baseline.json)。5 个已有测试全部通过的对照：[existing-controls.json](step-3-recheck/existing-controls.json)。

**临时扣费补丁：**[billing-probe.patch](step-3-recheck/billing-probe.patch) 仅在副本中增加原值输入，并取消不可取回分支覆盖退款判断。相同六项由 2/6 变成 6/6，[billing-probe.json](step-3-recheck/billing-probe.json)。它验证“无需新增持久计费状态也能正确表达这六项”，没有验证推荐的全部存储和操作架构。

实验性质为 `throwaway`。补丁保留在研究目录用于复现实验，不在产品依赖图内，不应直接提升为正式实现；后续实现者应迁移稳定夹具到真实入口测试，删除临时补丁执行路径或将其保留为只读历史证据。没有并行的运行时判定器。

```yaml
executable_scenarios:
  trigger_reason: 操作去重、免费恢复与扣费投影分别通过仍可给出错误组合结果
  decision_to_prove: 同一次操作不重生成，扣费原值不被结果恢复状态覆盖
  invariant_sources: 已批准方案第3.1、第3.2、第3.3、第3.6节及本报告固定的上游源码
  production_truth_owner: app.RetryTaskWithOperation、app.RecoverTask、task.ComputeOutcome、repository.retryTaskWithOperation
  fixture_path: docs/research/step-3-recheck/
  required_cases: 本节16项最末级检查
  expected_outputs: 原操作身份、Outcome、原任务与轮次、上游请求用途及计数
  side_effect_boundary: 临时SQLite与本地假上游，无真实生成
  pre_implementation_oracle: production-adapter
  post_implementation_replay: 后续正式实现必须重放这些夹具，再补本节未覆盖项
  duplicate_truth_forbidden: 不将实验补丁作为第二套正式判定器
  promotion_decision: adopt-fixtures
```

## 7. 剩余不确定项与下一次应证明的事

- **未证明整个新方案已经实现。**本次只对扣费投影做了对照改动。统一操作接纳、免费接纳与解除暂停的同事务写入、当前轮次原值存储仍需后续正式实现。
- **未覆盖免费接纳后的进程强杀、并发自动/手动恢复、租约过期和迟到响应。**后续用同样的临时数据库与假上游注入这些时序，验证不会转为新生成；不能只补一条成功后回执写入测试。
- **未运行完整 HTTP 鉴权与前端流程。**入口测试到 Service/repository 为止；现有 handler 已接参数是静态证据。后续还需让公开 `/retry`、`/recover` 与任务读取返回一致。
- **渠道真实结果保留期与重新签发下载链接能力没有实测。**不把火山、可灵搜索摘要或链接过期时间提升成统一结果期限；超分和合法 POST 查询亦需协议夹具。
- **没有生产退款、视频幂等开关或实际余额读回。**上游接口依据是固定源码；假上游不能证明生产配置。此研究不需要付费生成，也不因此要求放开付费权限。
- **第 3 步自身尚不保证所有付费入口都有同意检查。**那是已批准的第 4–5 步，不能因为本次证明了一项错误就提前扩大本任务。

停止条件已达到：当前反例、反例的原因、最小架构调整与可重跑证据均已记录；正式实现和独立复查留给后续任务。文档通过 delivery-planner 格式检查，证据计数和本地链接已检查，`git diff --check` 通过。研究产物的自查不等于另一位架构师或用户批准。
