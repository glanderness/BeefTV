---
half_life: 30d
archive_at: 2026-11-26
artifact_mode: delivery-doc
scope_type: slice
scope_name: 生成防重、原位再生成与外部客户端付费授权
coverage: 对方案第 3.1、3.6 节与第七节第 5 条给出可直接采用的修改
not_complete_for: 业务实现、生产开关读回、真实计费验收与发布
verification_level: docs-only
real_smoke_status: not_run
review_status: not_reviewed
reviewer: none
review_command: 未发起独立评审；本轮只核对原始文档和源码
review_notes: 研究结论，不表示功能已实现或用户已逐条批准实施
review_owner: BeefTV 项目负责人
review_due: 后续付费守门实施前
execution_backend: docs-only
lead_agent: current
peer_agents: none
builder_agent: none
verifier_agent: none
verification_independence: self_checked
cwf_decision: not_needed
cwf_trigger_boundary: none
goal_handoff: none
acceptance_contract_status: proposed
memory_required: false
memory_space: default
acceptance_memory_id: none
---

# 防重复付费、原位重新生成与外部程序付费权限：定案建议

调研日期：2026-10-27。本轮只新增本文；不修改业务代码、原方案或三份前置调研，不开 PR，不发起收费请求。

## 一、建议定下来的三件事

1. **第 3.1 节保留 `allowed / confirm / blocked`，补清含义和证据条件。** 正在生成或能取回时不另买；确实失败且有不收费或明确退款依据时可直接再生成；已经收费或收费不明时先确认；输入审核被拒时先修改输入，再判断费用。成功后主动再生成是另一次购买，保留正常生成入口。`allowed` 只免“可能重复付费”的额外确认，不代表免费，也不授予外部客户端消费权。依据见第三节。
2. **第 3.6 节保留唯一约束和同事务接纳，但改掉“一条约束就保证一次付费”的表述。** 补全每次重跑的持久回执、所有入口的目标版本检查、批次原子接纳、上游去重期限与身份范围。无需独立确认令牌服务、第二套任务状态机或新队列。依据与反例见第四节。
3. **第七节第 5 条选择“每个登记客户端一个付费开关，默认关闭”，并保留逐次报价与批准声明。** 开关控制能不能代表用户提交收费操作；批准声明控制这次具体做什么。首版不增加累计消费额度或免确认自动化。已有可写客户端也不自动继承消费权。依据和升级规则见第五节。

以上是本报告的设计判断；官方文档提供依据，不代表这些产品要求 BeefTV 照搬。第六节给出可直接放回方案的文字。

## 二、先核对既有资料和当前实现

### 2.1 前置资料已读，未重做其调研

工作树基线为 `1bf517b93da7f5cddef9f4dc93d0a55d12c6176b`。用平台只读 git 分别取回任务指定的三个分支，三个报告的 blob 与本工作树完全相同：

| 报告 | 指定分支及取回提交 | 本轮用途 |
| --- | --- | --- |
| [付费防重](paid-retry-idempotency.md) | `tds/conv-01a1789f-36b0-7e5e-88f8-6b898efd2fa6`，`1bf517b`；blob `9f9271a15365dfcf07ce2e9aa72850515476382e` | 沿用请求身份、同事务接纳、上游幂等三层思路；只检查简化是否遗漏条件 |
| [外部确认](mcp-paid-confirmation.md) | `tds/conv-01a1789f-2e99-7f48-ac11-ebbc99e86460`，`8673396`；blob `6de09bcec46dcd73ce652b104b4af54943b5a023` | 沿用调用方界面确认、服务端不能证明真人点击；补权限授予与额度取舍 |
| [任务先例](generation-task-prior-art.md) | `tds/conv-01a1789f-2760-7c5a-8426-aa2acb825754`，`415b43e`；blob `1a1695753d45a6291020fa4bd5920ab29b734e02` | 沿用创建与取回分开；只补商业平台失败和再生成的计费差异 |

[已定稿方案](../architecture/generation-task-state.md)以本工作树正文为对照。#17 的平台记录为 `done`，文件开头仍写“待架构师评审”，属于旧状态说明；本文不据此重开方案。#25 的任务记录仍是仅实施第 1、2 步，本文不扩展其范围。

记忆检索找到了早期“提交未知时隐藏重试按钮”等决定；当前方案已改为后台按证据自动取回或允许确认后再生成，因此旧记忆只作背景，不覆盖本次方案。

### 2.2 当前源码带来的实际约束

| 出处与已核事实 | 据此推断 / 对本文的影响 |
| --- | --- |
| [任务接纳][B-admit]、[身份比较][B-identity]：新任务按用户和 `clientOperationId` 查重，比对请求哈希；[仓储][B-retry]用写事务接纳 | 原有能力应复用；请求 ID 的稳定性不能被“重新确认”破坏 |
| [仓储 `retryTask`][B-retry]：原行更新回 `queued`，`route_run + 1`，没有给每次 `/retry` 新建任务行 | “原节点再生成”“复用本地任务号”“复用上游任务号”是三件事；不能假定每次重跑都会天然得到一条新任务去重记录 |
| [操作回执 `Store.Run`][B-store]：`AgentOpRecord` 和业务变更共用数据库事务，记录操作、请求哈希和结果 | 已有可复用的持久回执模式；后续应将所有付费入口接到同一个接纳实现，不能只让 MCP 有回执 |
| [客户端登记][B-clients]：只有 `read-only / read-write`，省略模式默认可写；身份按登记 ID 和 token 哈希验证，类别仅用于展示 | 新付费开关可以加在已有登记记录上，不需要新 OAuth 服务或按 Codex/Claude 品牌设白名单 |
| [调用者解析][B-caller]只往操作层传外部类别与 `ReadOnly`，另返回标签；[business principal][B-business]只含 `ReadOnly` | 必须把服务器验证后的登记 `clientId` 传到接纳和审计层；显示名称、调用方自填 `caller` 不能充当身份 |
| [外部生成提交][B-submit]按可写外部身份走提交，要求操作 ID、画布和模型配置版本 | 现有版本检查不能替代消费授权；新权限应覆盖原始 business/HTTP 和间接启动生成的入口 |
| [派发键][B-key]以 `taskID:attemptID` 派生；[路由尝试][B-attempt]在发送前记录 `submission_unknown` | 保留现有派发记录；同意记录负责本地接纳，派发记录负责上游请求，不把二者混成一张状态表 |

## 三、原任务上什么时候重新生成

### 3.1 商业平台的计费与确认：只补未覆盖部分

“出处原话”只摘短句；“出处说明”是中文转述。未实际登录这些产品或点收费按钮，文档未说明的弹窗行为一律写未核实。

| 产品与原始出处 | 失败后 / 成功后再生成 | 确认机制的证据 | 对 BeefTV 的推断 |
| --- | --- | --- | --- |
| Midjourney [Discord 快速开始][MJ-start]：“The 🔄 Reroll button reruns a prompt.”；[Editor][MJ-editor]：“Blocked jobs don't cost you any credits.” | 官方将 reroll 解释为产生一组新图片；Editor 审核拦截不消耗额度。后一句仅覆盖该页面说明的编辑场景，不能扩大为所有系统失败都退款 | [Repeat][MJ-repeat]明确 Discord 批量重复须点 Yes 确认数量，每组消耗 Fast GPU time；单次 reroll 是否额外弹窗，文档未明确 | 成功后主动再做一次是正常购买；重复内容不能自动视作重复请求。批次应展示数量和总费用 |
| Runway [网页退款说明][RW-web]：“Credits are only automatically returned when a generation ends in a generation error.” | 网页生成错误会返还；成功但不满意不自动返还。[排错说明][RW-errors]建议重试或修改输入 | 排错文档未承诺每次重试都有额外收费确认框 | “我不喜欢结果”不是免费重跑理由；正常再生成可以保留直接入口 |
| Runway [开发者失败规则][RW-api]：“credits are not refunded for `SAFETY.INPUT.*` failures.” | 输入审核失败不退费，官方要求不要原样重试；其他错误需按具体代码处理 | API 文档给出错误处理规则，不能从网页退款说明推导 API 所有失败都免费 | 审核拒绝先挡住原样重跑；改输入也不能抹掉上一次费用 |
| Replicate [计费说明][RP-bill]：“For all models, if a run fails, we don’t charge you.” | **同页紧接着有例外**：私有模型和部署按实例活跃时间计费；组合模型失败仍可能收本体运行及已调用下游的费用；取消也可能收费。成功后再次创建按新调用规则收费 | [HTTP API][RP-api]创建 prediction 接受模型与输入，未要求逐次真人确认字段；客户端 UI 是否询问不是此 API 的保证 | 不采用整个平台一个 `failedIsFree=true`；计费规则必须细到产品、模型类型和失败类别 |
| 可灵 [积分政策][KL-credit]：“If the generation fails, the corresponding Credits will be refunded.” | 平台积分在生成时扣除、失败返还；成功后另一次生成仍是另一次积分消耗 | 该政策不说明重试弹窗，也不是开发者 API 或第三方转售渠道的退款合同；这些部分未核实 | 只能用这份政策判断其明确适用的平台积分，不能替 BeefTV 所有可灵渠道声明退款 |

这些产品没有统一的“失败免费”或“每次重试都弹窗”规则。可迁移的是：**把旧结果取回、失败后新尝试、成功后再做一版分别表达；退款规则按实际产品判断。** 这是对上述原始资料的归纳，不是新增行业标准。

### 3.2 给 BeefTV 的完整判定

以下是设计建议。依据为上表、方案第 3.1/3.2 节，以及 [RFC 9110 的非幂等重试限制][RFC-retry]。保留单一 `Outcome`，不新增并行状态机。

| 后台掌握的事实 | 原节点上的操作 | `regenerate` / 是否确认 |
| --- | --- | --- |
| 排队或上游仍在运行 | 等待、取消、查询；不创建另一个生成 | `blocked` |
| 已出结果但未下载完、存储暂时失败、仍可取回、只停止了本地下载 | 自动取回；修好存储后接着取 | `blocked`；取消下载不等于取消上游或退款 |
| 提交未知，但确有上游去重合同，原请求、身份、期限满足重放条件 | 后台恢复同一次操作 | 仍走恢复；不是新一次 regenerate，不增加一次购买 |
| 失败且所有可能收费的尝试均确定未执行，或有适用的不收费/退款合同 | 用户主动再生成 | `allowed`；新尝试仍按模型正常收费 |
| 失败、结果无法取回，旧费用已发生或仍不明 | 显示旧费用风险和本次报价后再生成 | `confirm`；改输入也不能跳过 |
| 输入审核明确拒绝且原样提交仍无效 | 先改提示词、参考素材或适用的模型参数，再预览 | 原样 `blocked`；修改后按旧费用证据变为 `allowed` 或 `confirm`；新内容仍正常审核 |
| 成功且成片已保存 | 同节点再生成一版，保留旧结果 | `allowed`；明确是新的收费生成，保留已有普通生成/重复内容确认体验 |
| 已请求取消，但上游是否停止、是否收费未明确 | 能查询先查询；不能把本地 cancelled 当作未收费证明 | 仍在运行/可取回则 `blocked`；已无法取回但费用不明则 `confirm` |

`failed` 在这里包含“本地已经无法取回，但上游可能曾成功”的情形。建议把原表“确定没有可取回的结果”改成“确认没有结果，或现有渠道已经无法安全取回”，避免向用户谎称上游没有生成。

**计费证据补充三条：**

- `rejected_no_job` 只能先证明没建任务。只有适配器还证明这种拒绝不收费时，才归为免重复付费确认；“HTTP 4xx / 没结果”本身不够。Runway 输入审核收费就是不能混用概念的原始反例。[RW-api]
- 退款合同应保存出处、适用产品/接口、模型类别、错误码范围和规则版本；无声明按收费不明。官方“会退费”可以按原方案免额外确认，但文案应写“按渠道规则退还，可能尚未到账”，不能写“从未扣费”。这沿用原方案的取舍，而非要求等退款到账才可继续。[RW-errors] [RP-bill] [KL-credit]
- 判定覆盖本次 `routeRun` 内所有派发尝试和部分输出，不能只看最后一次 `not_sent` 或失败。如果前面一次可能收费、后来一次未发出，后者不能覆盖前者。派发记录已经包含 `RouteRun` 与 `AttemptNumber`，按这些现有事实聚合即可。[B-attempt] [RP-bill]

**“原任务上”定为用户可以在原节点继续操作，不强行统一所有本地任务号。** 免费恢复沿用原 task/run/attempt 和上游任务号；现有失败 `/retry` 可以保留本地 taskId 并增加 `routeRun`；成功后的新版本继续新建任务。每次新收费尝试都有新操作 ID、新执行轮次/尝试和可追溯的原任务关系，不覆盖旧回执。这样保持现有行为，又能区分买了一次还是两次。[B-retry] [B-key] [RP-api]

## 四、第 3.6 节：保留唯一约束，但它不是全部保证

### 4.1 原始依据与应纠正的旧推断

| 原始出处短摘 / 源码事实 | 本轮推断 |
| --- | --- |
| [Stripe 幂等文档][ID-stripe]：“We generate a new request if a key is reused after the original is pruned.” | 键的保留期限是安全条件；报价到期、结果过期、去重键到期是三件事，不能共用一个 TTL |
| [AWS Builders' Library][ID-aws]：“atomic, consistent, isolated, and durable (ACID) operation” | 保存请求身份和接纳任务必须一起提交；本地事务不能包住远程供应商的收费行为 |
| [AIP-155][ID-aip]：“the server should return the response for the previously successful request” | 重放返回已接纳操作的结果；任务后来失败也不把同一个操作解释为再买一次 |
| [BeefAPI 视频源码][API-video]：去重范围由 `market:userID:tokenID:key` 组成；[图片源码][API-image]复用同一范围 | 同一个字符串换了上游 token 身份仍可能变成新请求。“同模型可换渠道”适用于新尝试选路，不代表未知提交可跨渠道重放 |

前置付费调研中“不需要绑定 operationId / 不需要费用有效期”“没有通用确认令牌”等简化结论不能当作标准要求。Stripe/AWS 的资料证明的是幂等请求，不证明 BeefTV 可删除报价与批准绑定；RFC 6749 的授权码寿命也不是生成报价的标准寿命。本次保留报价有效期、输入指纹、调用者和操作绑定，不新增独立的“发确认令牌”接口。[ID-stripe] [ID-aws] [外部确认第 6.6 节](mcp-paid-confirmation.md#66-一次批准与一次接纳的最小关系)

### 4.2 具体保留和修改

| 项目 | 结论与必须补上的规则 | 理由 / 原始依据 |
| --- | --- | --- |
| `(用户, 节点, 原任务, originalRouteRun)` 唯一约束 | **保留**，作为同一旧执行的一次替代接纳约束；目标包含画布/节点所属关系。不得把 `clientId` 加进去，让两个客户端各消费一次 | 这是 BeefTV 自己的业务规则，不是 Stripe 的原样设计；跨客户端仍只能替代一次。[B-admit] [ID-aws] |
| 多次 `/retry` 的幂等回执 | **补全** `(用户, operationId) → 请求指纹、调用者、taskId、执行 routeRun、批次子项` 的持久映射；先校验身份和读取权限，再回放已接纳记录，不重新执行，只有新接纳才查当前消费权限和报价。不能覆盖任务原创建 ID 来假装保存了重跑历史 | 一个可变任务行存不下多次重跑的身份；同意表只覆盖 `confirm`，`allowed` 重跑也要去重。复用现有 `AgentOpRecord` 模式，将所有入口接入共用接纳，不新增另一套执行引擎。[B-retry] [B-store] [ID-aip] |
| 一次同意的执行结果 | 同意记录补 `consumed_route_run` 或等效稳定执行标识；同一 taskId 后来又重跑，旧同意仍只能指向原执行 | 原任务号复用时 `consumed_task_id` 单列无法准确表达消费到了哪一轮。[B-retry] |
| 两个不同操作 ID 的并发点击 | **补上所有新提交的预期目标版本检查**：新节点期望“尚无任务”；已有节点期望 `(taskId, routeRun)`，来自后端预览。事务内不匹配就拒绝并返回当前事实，不能悄悄改为针对最新任务再买一次 | 串行事务只解决同时读取；若第一笔很快失败或成功，第二笔可能看到新的 `allowed` 再买一次。旧快照必须失效，不能只保护 `confirm`。[B-retry] [B-admit]；此反例与改法为设计推断 |
| 状态变化与报价变化 | **保留**接纳事务内重算 Outcome、核对模型版本/输入/数量/费用/调用者。报价等待期间结果恢复为 ready，旧的“失败重试同意”失效；有意再做一版需新的操作。进度时间变化不作废报价 | 不用 `updatedAt`，暂不增加 `outcome_version`；`routeRun`、目标版本和当前事实检查足够覆盖本题。报价过期不应阻止已接纳操作的只读回放。[B-attempt] [ID-aip] |
| 批次 | **明确默认全有或全无地接纳**：冻结全部目标、子操作 ID、数量和总报价；一个事务写完任务与同意，失败则全部回滚，提交后才派发。执行可以部分成功，重放仍回原批次 | 删掉“单次批量请求可部分接纳”的含糊表达，减少逐项补偿；已有历史部分接纳记录只能补齐未接纳项，不能重做成功项。[B-store] [ID-aws]；全有或全无为本报告取舍 |
| 上游派发 | **保留并收紧**先记 attempt 再发送；同一 attempt 恢复固定原请求、原接口及上游身份、原键和去重期限。没有安全重放合同就只查询；查不回再交用户确认 | 不能由本地 INSERT 成功推出远端只收费一次，也不能把“发过 Idempotency-Key 头”当作供应商承诺。[B-key] [API-video] [API-image] [ID-stripe] [RFC-retry] |
| 保存与清理 | 去重回执不能随报价到期、任务列表清理一起消失。首版保留紧凑回执/删除标记；被删任务重放返回“原操作已处理、结果已删除”，不新建任务。以后清理需先定义明确的受理期限，并拒绝过期旧操作 | 否则删完任务重发就可能第二次收费。无需永久保留媒体、密钥或完整提示词，只保留防重和审计所需标识、指纹与执行关联。[ID-stripe] [ID-aws] |

这不是增加三张新状态表：任务和路由尝试仍是执行事实；现有操作回执是接纳记录；计划中的同意表记录批准范围及其消费结果。它们分别回答“跑到哪”“这个请求处理过没有”“被允许做哪一笔”。实施时应共用一条接纳路径，避免 `/ops`、HTTP、工作流各写一遍守门。

**稳定操作 ID 是所有新收费接纳的必填项，不限 `confirm`。** 这是 BeefTV 为防重选择的更严格规则，不能写成 AIP-155 要求所有 API 必填。后续守门生效时，不带稳定 ID 或必要目标版本的旧客户端新收费请求应明确拒绝；原方案的免费 `/retry` 兼容取回继续保留。相应修改第四节“旧客户端 allowed/ready 不受影响”的说明：能兼容的是已提供这些字段的调用，不能为了兼容在后台每次生成一个新 ID。第 4 步先接好所有正常入口，第 5 步再拒绝缺字段请求。[ID-aip] [B-admit] [B-retry]

**对自动换渠道的决定：保持同一前台模型唯一定价、不因换渠道重新报价。** 但自动换渠道只在上一尝试明确未产生不可退费用、且不会再完成旧请求时进行；旧提交未知时不得换渠道、换账号或换 token 身份重放。模型和版本、输入、数量或费用变化仍使批准失效。前者约束用户批准的购买内容，后者约束供应商如何识别同一次请求，两者不冲突。[B-attempt] [B-key] [API-video]

### 4.3 BeefAPI 视频 guard：历史开启已证实，当前未证实

读取 BeefAPI 默认分支源码 `e4641ca3334eb239ec998ee8188edbb0f58a94d5`：

- [生产报告第 35 行][API-report]记录 2026-09-12 开启 guard，第 60 行记录 09-13 读回保留 guard。**这是历史生产证据。**
- [Compose][API-compose]及 [middleware][API-video]默认仍为 `false`。**默认值不能证明运行中关闭，也不能用历史报告证明今天仍开启。**
- 本轮未读取生产容器配置，未发送付费探针。因此保持视频未知提交不自动重发的策略；需要当前部署的只读配置/版本证据，或经验证、绑定该部署的协议声明及防重测试后才能启用。此处不是阻塞本文定案的待选产品问题。[API-video] [API-report]

更准确的保证写法：**“同一操作最多接纳一次约定的执行；同键恢复可发生多次 HTTP 请求，但不得另建上游付费操作。供应商实际计费一次的保证取决于其已核实的去重合同。”** 不再写“一次同意最多提交一次 HTTP 请求”，也不承诺“任何渠道绝不重复扣费”。[ID-stripe] [ID-aws] [B-key]

## 五、外部程序的权限：开关、额度、确认如何组合

### 5.1 别的项目实际提供什么

| 原始出处短摘 | 出处说明 | 对 BeefTV 的推断 |
| --- | --- | --- |
| [Stripe 受限密钥][P-stripe]：“The default value for all permissions is None.” | 按资源给 Read/Write/None，可为不同应用分别发受限凭据 | 给客户端单独授予付费能力有成熟先例；普通写权限不应自动覆盖全部收费操作 |
| [GitHub 细粒度令牌][P-github]：“Each token is granted specific, fine-grained permissions” | 限定用户/组织、具体仓库与操作；组织可要求批准，令牌不能超出其所有者权限 | 复用现有客户端登记和撤销，不按客户端名字判断可信；开关应附着在凭据登记上 |
| [OpenAI 项目][P-openai]：“All: Full permissions. This is the default.” | 项目 key 可改为 Restricted/Read Only；**其 key 默认全权限，不照搬这个默认值** | 参考“范围与权限分开”，不把 API 平台默认值直接搬进桌面助手 |
| [OpenAI 消费限制][P-openai-limit]：“Enforcement is not instantaneous.” | 当前支持组织/项目 hard limit，触发后请求报错；仅提醒不会停流量；硬限额传播期间仍可能小幅超出 | 不能再笼统说“OpenAI 项目预算只有提醒”；也不能把预算名义值当作单笔精确承诺 |
| [Anthropic 工作区][P-claude]：“API keys are tied to the Workspace they're created in” | key 绑定工作区，可撤销；工作区消费上限与邮件通知是不同配置。[限额规则][P-claude-limit]明确达到消费上限拒绝请求 | 额度是服务端强制能力，不是每次对话确认的别名；第三方真实账务仍由上游掌握 |
| [Stripe MCP][P-stripe-mcp]：“Turn on your MCP client’s tool-approval setting” | OAuth/agent key 决定访问权限；客户端审批另设，可撤销客户端会话 | 官方也把长期授权和工具审批分开，不能声称每笔必有服务器验证过的真人点击 |
| [AWS MCP][P-aws]：“OAuth authorization does not grant additional AWS permissions” | MCP 仍受 IAM 等约束；文档也支持非交互 client credentials | 不靠弹窗代替权限检查；AWS 具备自动化路径并不意味着 BeefTV 应默认允许消费 |

前置 [MCP 调研第 6.5 节](mcp-paid-confirmation.md#65-后台到底信任什么)已经说明客户端可自动批准，本轮沿用，不重新做 Codex/Claude Code 兼容矩阵。以上资料也没有给出所有 MCP 产品通用的消费额度标准。

### 5.2 BeefTV 桌面版选择

**推荐“每客户端付费能力 + 每笔批准范围”，首版不做累计额度。** Basis：上述受限凭据先例、现有登记系统，以及 BeefTV 使用多个上游且没有统一实际扣费账本的代码事实。这是本报告取舍，不是声称开关能约束恶意程序的每次花费。

| 控制 | 具体决定 |
| --- | --- |
| 开关名称与默认 | 每个登记新增 `canSubmitPaidGeneration`，界面“允许发起付费生成”，新旧登记缺省均为 `false`；仍须已有可写权限 |
| 谁能改 | 只从现有受信任桌面/owner 管理客户端的接口修改；外部客户端不能给自己开启。沿用 [agent-clients 的身份校验][B-client-ui]，不新增确认服务 |
| 开启的含义 | 用户把“取得本次同意”的责任委托给这个登记客户端；不是无限额自动运行授权，也不是 BeefTV 已独立证实真人批准。说明文字须明确这一点 |
| 逐次批准 | 所有外部收费生成，包括首次生成、`allowed` 失败重跑、成功后再生成，都提交绑定报价和 operationId 的批准声明；`confirm` 再加入旧任务可能收费的说明。可以使用一次包含全部信息的宿主审批，不叠加第二次同内容询问 |
| 无权限 | 返回 `403` 和机器原因（建议 `paid_generation_not_permitted`），带 `confirmed=true` 也不放行；允许有读取权限的客户端查看任务和费用预览 |
| 有权限但缺本次批准 | 返回 `paid_confirmation_required` 和本次报价，零上游新提交；旧客户端未升级也不能免掉这一条件 |
| 免费取回 | 不要求付费开关；仍要求相应普通读写权限。后台自动取回已经接纳的操作继续进行；只读客户端不能因“免费”而获得写权限 |
| 关闭/撤销 | 关闭阻止随后接纳的新收费操作；已原子接纳的固定任务继续执行与取回，需要停止时用取消功能。撤销整个凭据阻断该客户端访问，不回滚已经发生的消费。关闭前仅取得报价、尚未接纳的请求不能执行 |
| 累计额度 | 首版不做。需要日/月免确认自动化时另立合同：按计费单位预占、并发扣减、结算/退款、未知金额拒绝及撤销；在此之前不展示虚假的“最高花费”保证 |

开关的实施是后续方案第 4/5 步的范围，不加入 #25。升级时已有可写客户端仍可进行普通写操作，但新收费生成会被拦下，需要用户在桌面为该登记明确开启并升级调用协议。回退不得恢复“可写即能付费”；不认识新授权合同的客户端应停止收费请求。以上迁移取舍来自本任务要求定下默认值，以及 [受限权限][P-stripe] 与 [现有注册源码][B-clients]。

**所有入口都必须保留来源身份。** MCP、CLI、business 直接调用、工作流和后台延迟提交不能在进入普通 service 后丢掉 `clientId`，也不能借内置助手身份重新提交。已接纳批次可按原批准继续派发；后续新增节点、加量或新轮次都是新接纳，要重新检查当前权限。按服务端判定的“可能新建收费执行”检查，不能只按 HTTP 方法或工具展示名检查。[B-business] [B-caller] [B-submit]

**未知费用的处理：** 延续原方案，可向有付费权限的客户端提供“费用未知、无可执行金额上限”的明确报价，并要求本次特别同意；不得显示 0 或假称有硬上限。此类调用不适合未来的限额免确认模式。当前开关加声明并不能阻止一个已获权限、却谎称已询问用户的客户端不断生成；要防这种威胁，需撤销权限，或以后采用 BeefTV 独立认证确认/可验证批准。这一限制在启用说明与审计中保留。[外部确认第 6.1、6.5 节](mcp-paid-confirmation.md) [P-openai-limit]

## 六、可直接放回方案的文字

### 第 3.1 节：保持主表，补充限定

> `regenerate` 只回答针对当前节点再生成是否需要重复付费确认，不表达免费或客户端消费权限。正在运行、下载或可取回时为 `blocked`；无法取回且旧费用已发生或不明时为 `confirm`；有适用的不收费或退款依据时为 `allowed`。成功后主动再做一版为 `allowed`，按新的生成收费。审核拒绝只拦原样重跑，改输入后仍按旧费用证据判断。取消请求和 `rejected_no_job` 均不单独证明未收费。费用判断覆盖本次运行全部可能收费的尝试和输出，不能被最后一次未发出覆盖。所有外部收费操作还须通过客户端付费权限及本次批准检查。

理由：保留已定稿的产品行为；补上不同产品退款规则、取消和多尝试的证据要求。原始依据：[Runway][RW-api]、[Replicate][RP-bill]、[路由尝试源码][B-attempt]。

### 第 3.6 节：保留约束，改为“一次批准对应一次接纳”

> 保留同意表的 `(用户, 目标节点, 原任务, 原 routeRun)` 唯一约束，核对报价、目标版本和当前 Outcome 后，与任务接纳及操作回执在同一事务提交。所有新收费接纳必填稳定操作 ID，持久映射到请求指纹、真实调用者、任务及执行轮次；`/retry` 复用任务号时也必须保留每次操作的映射和消费轮次。同一操作重放经过身份与读取权限检查后只回原接纳结果，报价过期或任务再次失败均不触发重买；不同操作携带的旧目标版本不得自动作用于最新任务。新批次默认全部接纳或全部回滚，提交后才派发。去重记录不随报价或媒体过期删除。
>
> 同意绑定前台模型版本、输入、数量和费用，不绑定备用渠道；同一模型换渠道不重新报价。但未知请求的恢复必须固定原尝试、原请求、原上游身份和键，并满足该上游去重期限。未证明上一次无不可退费用时不自动换渠道重新创建。保证是“一次操作最多接纳一次约定执行”，不保证只有一个 HTTP 请求，也不代替上游的计费保证。暂不新增 `outcome_version`、独立确认令牌接口或执行状态机。

理由：原唯一约束可防同一旧执行被两个同意消费，但不能覆盖全部操作重放及上游收费。原始依据：[AWS 原子接纳][ID-aws]、[AIP-155][ID-aip]、[Stripe 键保留期][ID-stripe]、[本地重跑源码][B-retry]、[BeefAPI 去重范围][API-video]。

### 第七节第 5 条：不再待选，采用每客户端默认关闭

> 外部登记客户端新增“允许发起付费生成”，默认关闭，历史缺省也按关闭处理；由用户在现有受信任桌面设置中单独开启、关闭。普通可写权限不包含消费权。开启后，首次生成、失败重跑和成功后再生成均须提交绑定本次报价与操作 ID 的批准声明，由外部调用方在自己的界面取得用户同意。服务器验证真实登记身份和批准范围，记录“调用方报告批准”，不声称独立核实真人。免费取回不需要消费权，但仍遵守普通权限。首版不引入累计额度或长期免确认模式；所有会创建收费执行的入口共用同一检查。关闭只阻止新的接纳，已经接纳的固定任务继续执行；撤销权限不撤销既有消费。

理由：复用现有凭据登记即可表达最小权限，避免普通写操作顺带授予消费权；逐笔声明和开关解决不同问题，额度不能替代二者。原始依据：[Stripe 受限密钥][P-stripe]、[GitHub 细粒度令牌][P-github]、[Stripe MCP][P-stripe-mcp]、[AWS MCP][P-aws]、[本地客户端登记][B-clients]。

同时校正第 3.4 节“调用方不声明同意就绝不扣钱”的范围：它指尚未接纳的、需要批准的新收费操作，不含已经接纳后继续执行或取回的任务；也不表示 BeefTV 能拦住供应商对既有执行的结算。

## 七、后续最小验收与本轮证据范围

以下是实施验收条件，**本轮没有运行这些业务测试**。全部可先用不收费的假上游验证：

| 场景 | 应观察到的结果 |
| --- | --- |
| 同 operationId 并发、断线重发、任务失败后再重发 | 同一 taskId + 执行轮次/批次回执；不增加收费执行；同键异输入明确冲突 |
| `/retry` 多轮后重放最早一轮的操作 | 返回那一轮接纳关联，不将当前任务再排队；旧创建 operationId 也不丢失 |
| 两个客户端用不同操作 ID 对同一旧任务确认 | 只接纳一个；目标版本及唯一约束拒绝另一个，第一笔立即终态也不能绕过 |
| 原失败任务在用户确认期间恢复成功 | 旧失败重试批准不再创建任务；用户重新预览“再做一版”才能新购 |
| 取消、退款承诺、输入审核收费、前一尝试未知而末次未发出 | 分类符合第三节；不将无结果、取消或末次失败误作免费 |
| 批次第 N 项写入失败，随后同键重放 | 首次本地事务全部回滚、没有派发；重放正确接纳一次，不重复已有历史子项 |
| 接纳提交前/后崩溃，或上游接纳后响应丢失 | 未提交不派发；已提交回读原操作；恢复保持原键/身份，不安全时停止重发 |
| 去重期限届满、换上游 token 身份、结果/任务被删除 | 不将旧请求当新购买；查询、明确拒绝或要求新的购买确认 |
| 只读、普通可写但付费关闭、缺字段旧客户端、伪造桌面/调用者 | 都不能新建收费执行；免费取回按普通权限工作 |
| 有权限但缺报价/同意、换输入/模型/数量、批次加项 | 不派发，返回对应权限或重新确认原因；同模型安全备用路由不无故重新询问 |
| 关闭付费开关与请求并发、关闭后新工作流子任务 | 以后台授权检查和接纳顺序确定结果：关闭先完成则拒绝；先接纳的固定任务继续，不扩展授权范围 |

本轮已做：比对三份报告来源版本；阅读方案和相关源码；读取官方计费、权限和限额资料；区分引用、源码事实与设计推断；检查本文内部链接、引用及修改范围。未做：浏览器收费交互、供应商实际退款/扣费验证、BeefAPI 当前生产配置读回、构建或业务测试、独立 AI 评审。

未核实之处已采用明确默认：未知退款按 `confirm`；未知上游去重不自动重发；外部权限缺失按关闭。新证据只改变对应渠道规则，不能自动放宽所有渠道。本文可供后续修改方案，不能作为功能已上线的证据。

## 原始来源索引

官方滚动页面的核对时间均为本报告调研日期；代码链接固定到本轮读到的提交。原始英文短摘仅用于核对措辞，全文建议均为本报告判断。

[MJ-start]: https://docs.midjourney.com/hc/en-us/articles/32631709682573-Discord-Quick-Start
[MJ-editor]: https://docs.midjourney.com/hc/en-us/articles/32764383466893-Editor
[MJ-repeat]: https://docs.midjourney.com/hc/en-us/articles/32757107922061-Repeat
[RW-web]: https://help.runwayml.com/hc/en-us/articles/34266159290003-Can-I-have-credits-refunded
[RW-errors]: https://help.runwayml.com/hc/en-us/articles/32880432736659-Why-am-I-receiving-errors-when-trying-to-generate
[RW-api]: https://docs.dev.runwayml.com/errors/task-failures/
[RP-bill]: https://replicate.com/docs/topics/billing/
[RP-api]: https://replicate.com/docs/reference/http#predictions.create
[KL-credit]: https://kling.ai/docs/point-policy
[ID-stripe]: https://docs.stripe.com/api/idempotent_requests
[ID-aws]: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
[ID-aip]: https://google.aip.dev/155
[RFC-retry]: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2
[P-stripe]: https://docs.stripe.com/keys/restricted-api-keys
[P-github]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
[P-openai]: https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform
[P-openai-limit]: https://developers.openai.com/api/docs/guides/spend-limits
[P-claude]: https://support.claude.com/en/articles/9796807-create-and-manage-workspaces-in-the-claude-console
[P-claude-limit]: https://platform.claude.com/docs/en/api/rate-limits
[P-stripe-mcp]: https://docs.stripe.com/mcp
[P-aws]: https://docs.aws.amazon.com/agent-toolkit/latest/userguide/oauth-authentication.html
[B-admit]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/task/admission.go
[B-identity]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/task/identity.go
[B-retry]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/repository/local_runtime.go#L329
[B-store]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/operations/store.go
[B-clients]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/agentops/clients.go
[B-client-ui]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/handler/agent_clients.go
[B-caller]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/handler/agent_ops.go#L157
[B-business]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/handler/business_catalog.go
[B-submit]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/operations/generation_submit.go
[B-key]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/app/provider_submission.go
[B-attempt]: https://github.com/glanderness/BeefTV/blob/1bf517b93da7f5cddef9f4dc93d0a55d12c6176b/backend/internal/modelcatalog/route_attempt.go
[API-video]: https://github.com/Sunnyender-org/beefapi/blob/e4641ca3334eb239ec998ee8188edbb0f58a94d5/middleware/video_submission.go#L76
[API-image]: https://github.com/Sunnyender-org/beefapi/blob/e4641ca3334eb239ec998ee8188edbb0f58a94d5/middleware/image_submission.go#L115
[API-report]: https://github.com/Sunnyender-org/beefapi/blob/e4641ca3334eb239ec998ee8188edbb0f58a94d5/docs/reports/video-enterprise-hardening-2026-09-12.md#L35
[API-compose]: https://github.com/Sunnyender-org/beefapi/blob/e4641ca3334eb239ec998ee8188edbb0f58a94d5/docker-compose.ghcr.yml#L129
