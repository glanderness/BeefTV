---
half_life: 14d
archive_at: 2026-11-10
artifact_mode: research-report
scope_type: decision-support
scope_name: 协议、模型与插件下线后的兼容策略
coverage: 外部项目模式、BeefTV #33 修改方向、默认值与未完成任务
verification_level: browser-and-source-review
real_smoke_status: not_applicable
review_status: self_checked
reviewer: none
review_command: 未发起独立 AI 评审；本轮只做外部资料、源码和当前分支静态核对
review_notes: 本文只交付调研结论，不修改业务代码，不声明外部项目的异步任务保证超出其公开文档范围
execution_backend: docs-only
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

# 协议、模型与插件下线模式调研

> 调研日期：2026 年 10 月 27 日。只调研，不修改 BeefTV 业务代码。
>
> 本文的“下线”默认指：**新用户、新配置和新发现列表不可再选**，不自动等同于“已保存配置立即停止运行”。如果供应商已经永久关闭 API，才进入另一种“停止运行”的处置。

## 0. 结论先行

**#33 应保留“新选不可用、旧引用可运行”的双轨语义，但重做决策边界：下线状态可以继续由运行时从引用推导，不必新增 registry 字段；真正必须收敛的是协议默认值、可选性和执行性的多处推导。**

建议把 #33 拆成两个层次：

1. **本次必须完成的最小闭环**
   - 统一一个协议决策点，输出“能否运行”和“能否新选”两个不同结果。
   - 新选择只消费 `selectable` 结果；已有模型配置和任务按显式保存的协议消费 `runnable` 结果。
   - 继续保留已安装定义，避免发行包撤下后启动清理老记录。
   - 同名插件升级遇到未完成任务时暂缓替换；盘点失败不得用默认值覆盖待配置状态。
   - 继续采用“一次盘点、只读小字段、不读取整份冻结请求”的实现方式。

2. **不应在 #33 继续扩大的内容**
   - 不新增一套持久化 `retired` 状态源。
   - 不做自动换协议、换渠道、换凭据或自动重提交任务。
   - 不把所有旧配置迁移、恢复和异步任务版本化一次性塞进 #33。
   - 不让每个前端页面、默认函数和请求解析器各自判断“协议是否可用”。

3. **后续独立任务**
   - 对真正需要长期兼容的异步任务，保存提交时的不可变执行定义摘要（协议 ID、插件包/定义 digest、关键执行版本），逐步替代“只要有未完成任务就延迟整个插件升级”的保守策略。

核心判断是：当前重复漏洞的根因不是“撤下状态没有写进 registry”这一点，而是**同一个协议在不同调用路径上被分别解释为目录项、默认值、已保存配置和任务执行器**。只修某一个 fallback 会继续漏出下一条路径。

---

## 1. 先固定两个维度：停止新选，不等于停止运行

协议、模型和插件至少有以下两个独立维度：

| 维度 | 含义 | 典型来源 | 下线后的要求 |
| --- | --- | --- | --- |
| `selectable` | 是否允许新建连接、模型配置或新任务选择 | 当前目录、插件启用状态、撤下引用盘点 | 撤下后为否；新列表隐藏或标记不可选 |
| `runnable` | 已有显式引用是否仍能执行、查询或取回 | 保存的配置、任务 attempt、已安装定义、凭据与渠道 | 只要执行条件仍满足，就不能被“默认值刷新”覆盖 |

异步任务还需要第三个维度：

| 维度 | 含义 | 下线/升级后的要求 |
| --- | --- | --- |
| `task_execution_binding` | 任务提交时使用的执行定义 | 查询、取回、解析应尽量继续使用原协议和原定义；不能因为目录默认值变化而换源重提 |

外部项目的共同点不是都保存一个名为 `deprecated` 的布尔值，而是把**目录/发现状态**和**已存在引用**分开。BeefTV 可以继续把撤下状态从“保存配置和未完成任务的引用”推导出来，但推导结果必须在一个权威决策层汇合，不能在 UI、默认函数和执行器中重复推导。

---

## 2. 外部项目的做法

### 2.1 VS Code 扩展：编辑器内标记弃用，不自动迁移已安装扩展

**观察到的做法**：

- VS Code 官方发布文档没有把 `deprecated` 描述为扩展 `package.json` 的 Marketplace 字段；弃用由发布方在官方 Deprecated extensions 讨论帖申请。
- VS Code 编辑器界面会把弃用扩展显示为灰色删除线并给出警告；如果有替代扩展或设置，会提供 Migrate 按钮。
- 官方文档明确：VS Code **不会自动迁移或卸载**已经安装的弃用扩展。
- 同一页面还注明：截至当前文档版本，扩展不会在 Marketplace 页面中显示为 deprecated。因此这里能直接借鉴的是“运行时安装记录与迁移 UI 分离”，不是一个已经被 Marketplace API 证明的目录字段。

**对 BeefTV 的启示**：

- 目录/设置页可以标记“已撤下、建议迁移”，但不应因为新目录不再推荐就静默换模型或协议。
- 替代项只能由用户显式确认后写入配置；不能把替代项当成隐式默认值。
- “停止推荐/编辑器内标记”和“禁止新安装”是两个不同动作，不能混成一个状态。

来源：

- [VS Code 发布扩展：Deprecating extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#deprecating-extensions)
- [VS Code 源码](https://github.com/microsoft/vscode)，MIT License。这里只参考行为和边界，没有复制代码。

### 2.2 Grafana 插件：搜索隐藏与禁止安装是两个阶段，既有安装不受影响

Grafana 的官方插件下线政策是本次调研中最接近 BeefTV 目标的公开例子，但必须区分目录展示和安装权限：

- 被弃用插件不再出现在 grafana.com 插件目录搜索结果，也不再出现在 Grafana 管理界面的插件视图中。
- 这不是立即禁止所有新安装：官方政策仍允许通过插件直链访问和下载，且可以通过 CLI 安装。
- **已有安装不受影响**，继续正常加载和运行，同时显示弃用警告。
- Grafana 后续可以再按产品策略限制云端安装；这属于更强的“禁止新安装”阶段，不应倒推成“搜索隐藏已经等于不能安装”。
- 对 BeefTV 的直接借鉴是：先改变发现/推荐入口，再单独决定是否阻止新安装；不要删除已有执行定义。

来源：

- [Grafana Plugin Deprecation Policy](https://grafana.com/legal/plugin-deprecation/)
- [Publish or update a plugin](https://grafana.com/developers/plugin-tools/publish-a-plugin/publish-a-plugin)
- [Grafana 源码](https://github.com/grafana/grafana)，AGPL-3.0。按任务约束只参考思路，不搬用实现。

### 2.3 Home Assistant：旧行为先继续工作，最终移除也保留 stub 让旧配置可见

Home Assistant 的开发文档给出了比较完整的生命周期：

1. **弃用期**：旧行为继续工作，受影响用户收到 warning；新版本声明预计在哪个版本移除。
2. **新入口停止**：如果集成被替代，config flow 以 `deprecated` 原因中止，新的 config entry 不再创建。
3. **旧实体仍保留一段时间**：旧实体继续创建并提示迁移；只有用户禁用且没有自动化/脚本引用后，才从 registry 清理，避免新启动时再次创建。
4. **永久移除**：集成代码缩成 stub，保留最小 `config_flow.py`，已有 config entry 仍能加载并产生 ERROR repair issue，明确告知用户该集成已经移除以及如何删除旧条目。

这比简单的“删除协议”更重要的地方在于：

- **旧配置的存在本身是需要被识别和提示的事实**，不是启动清理的垃圾。
- 新用户不应再获得已撤下对象，但旧用户仍要看到可解释的状态。
- warning 和 error 有明确语义：warning 表示仍有效，error 表示已停止工作；不能把两者混成一个 `available=false`。

来源：

- [Home Assistant：Deprecating](https://developers.home-assistant.io/docs/deprecating/)
- [Home Assistant：The integration manifest](https://developers.home-assistant.io/docs/creating_integration_manifest/)
- [Home Assistant core 源码](https://github.com/home-assistant/core)，Apache-2.0。只参考配置条目、弃用和移除的生命周期。

### 2.4 Terraform：状态和版本不能随意删除；弃用通过版本演进完成

Terraform 的两个官方文档对 BeefTV 有两个直接借鉴点。

**Provider/资源字段弃用**：

- 先在 schema 中声明弃用并发出 warning。
- 在 minor 版本中保持旧字段和旧状态可用。
- 只有 major 版本才移除旧字段及其代码。
- 重命名期间同时支持旧字段和新字段，避免旧配置和 state 在一次刷新中互相打架。

**Registry 版本保留**：

- Terraform Registry FAQ 明确不建议删除已经发布的 provider/module 版本，因为这会破坏使用该版本的消费者配置。
- Provider 版本、provider address、配置和 lock file 是不同层次；“最新版本”不应覆盖已被旧 state 使用的语义。

它不是 BeefTV 异步任务的直接答案：Terraform 的一次 plan/apply 通常是同步流程，官方文档没有承诺每个资源永久绑定某个 provider 二进制版本。但它证明了一个稳定原则：**发布/目录层可以推荐新版本，已存在 state 和旧配置不能靠删除旧版本来解决。**

来源：

- [Terraform Framework：Deprecations, removals, and renames](https://developer.hashicorp.com/terraform/plugin/framework/deprecations)
- [Terraform Registry FAQ](https://developer.hashicorp.com/terraform/registry/faq)
- [Terraform Plugin Framework 源码](https://github.com/hashicorp/terraform-plugin-framework)，MPL-2.0。只参考兼容演进原则。

### 2.5 OpenRouter：目录元数据带过期时间，但路由 fallback 不等于换模型

OpenRouter 的公开模型 API 与 Provider Routing 文档展示了另一种“目录服务”模式：

- 模型目录返回规范化模型 ID、canonical slug、上下文/能力等元数据，并可返回 `expiration_date`。
- Provider routing 是**同一模型请求内部**的供应商选择和 fallback；它不应被理解为把用户配置的模型 ID 自动改成另一模型。
- 目录元数据可以指导“新选择是否仍推荐”，但已保存配置的执行结果仍取决于该模型是否仍能被请求、原 provider 是否还存在以及返回的错误。

2026 年 10 月 27 日通过公开 Models API 做了一次只读快照：返回 690 个模型，其中 15 个带 `expiration_date`；例如 `inception/mercury-decide:free` 的日期为 2026-10-27。这是动态目录快照，不是稳定数量承诺，但足以说明“过期/撤下”可以先存在于目录元数据而不是直接删除旧 ID。

OpenRouter 的公开资料没有证明所有过期模型都保证旧任务继续可取回，因此不能把它当作 BeefTV 异步任务兼容性的证据。

来源：

- [OpenRouter Models API](https://openrouter.ai/docs/api-reference/models/get-models)
- [OpenRouter Provider Routing](https://openrouter.ai/docs/features/provider-routing)
- [OpenRouter Models API 当前快照](https://openrouter.ai/api/v1/models?output_modalities=all&limit=1000)
- OpenRouter 是服务/API 文档，不作为开源代码许可样本。

### 2.6 LiteLLM：稳定 alias 指向当前部署，适合“发现名”和“执行目标”分离

LiteLLM 的路由配置把用户可见的 `model_name`（alias）与实际调用的 `litellm_params.model`、`api_base`、部署列表分开：

- 新请求按当前 `model_list`、数据库模型注册或路由组选择部署。
- alias 可以保持稳定，底层 deployment 可以新增、替换、做负载均衡和 fallback。
- session affinity 可以把连续请求尽量固定到同一部署；如果部署被移除或不可用，路由器可能回退到其他部署。
- 公开文档没有给出“已提交的异步任务永久绑定某个旧插件包”的通用承诺，也没有一个和 BeefTV 完全对应的 `retired-but-runnable` 状态。

因此 LiteLLM 适合借鉴的是**单一模型路由/alias 决策点**，不适合直接当作 BeefTV 任务恢复方案。BeefTV 的查询、下载和解析依赖提交时的协议定义，不能仅凭当前 alias 重新推导。

来源：

- [LiteLLM Routing](https://docs.litellm.ai/docs/routing)
- [LiteLLM Model Management](https://docs.litellm.ai/docs/proxy/management/add_model)
- [LiteLLM 源码](https://github.com/BerriAI/litellm)，仓库主体 MIT；`enterprise/` 目录有独立许可。这里只参考路由模型。

### 2.7 one-api / new-api：运营开关能阻止新路由，但不是完整的旧任务保留模型

对 one-api 和 new-api 的源码及 README 做了盘点：

- channel 记录通常包含启用/禁用状态、模型列表、模型映射、优先级和自动禁用等运营字段。
- 路由时会跳过禁用或不可用渠道；模型映射可保持用户请求名稳定，再把请求改写到上游模型。
- 数据库记录和计费/调用日志仍然存在，禁用渠道不等于立即删除全部历史记录。
- 但这类网关主要解决**当前请求的渠道选择**，没有为 BeefTV 这种“提交后稍后查询、下载和恢复”的任务提供通用的不可变插件定义绑定。不能仅因为渠道还留在数据库，就认为旧任务一定能按原请求取回。

许可：

- [one-api](https://github.com/songquanpeng/one-api)：MIT License。
- [new-api](https://github.com/Calcium-Ion/new-api)：AGPL-3.0。

new-api 只参考思路，按任务约束不搬用 AGPL 代码。两者都不应成为 BeefTV “下线后旧任务继续可用”语义的唯一依据。

---

## 3. 横向归纳：哪些做法是稳定共识

### 3.1 状态放在哪里

外部项目大致有三层：

1. **发布/目录层**：是否展示、可搜索、可安装、是否推荐、是否过期。
2. **用户引用层**：已安装扩展、已保存配置、Terraform state、Home Assistant config entry、模型 alias。
3. **运行时执行层**：当前实际加载的包、provider、deployment、协议定义和任务 attempt。

下线最安全的默认动作是：先改变第 1 层；第 2 层不自动删除；第 3 层只在安全生命周期结束或明确永久移除后改变。

对 BeefTV 来说，这意味着：

- `retired` 可以是运行时根据“发行包/安装记录 + 保存配置 + 未完成任务引用”生成的**视图状态**。
- registry 不必新增一个会过期、需要迁移、还可能和引用事实不一致的永久 `retired` 字段。
- 但运行时必须把这个视图一次性算好并传给所有消费者，不能让每个消费者重新猜。

### 3.2 老配置如何处理

跨项目共有四条：

- 不把老配置变成新默认值。
- 不因为新目录不再列出对象，就在加载老配置时静默换对象。
- 允许旧配置继续工作时，给 warning/retired 标记；不能工作时，保留可解释的 error/stub。
- 只有用户明确迁移，或用户已停止引用、且兼容期结束，才清理旧记录。

BeefTV 还必须区分两种“配置里没有 `protocol`”的旧数据：

- **隐式旧默认**：旧 profile 缺少 `protocol`，但没有 `protocolPending: true`，表示沿用当时按能力/模型约定的默认协议。例如已有音频 profile 仍应解析为 `openai-audio`；不能把缺字段一律改成待配置。
- **明确待配置**：`protocolPending: true` 表示最近一次目录决策已经确认没有安全的可选协议，故意留下未配置状态。它才应保持 `undefined`，等待用户选择。

#33 的 `SavedProtocolReferences()` 目前主要统计显式协议 ID，因此 retention 盘点还必须和同一个兼容 resolver 对齐：对缺字段的旧 profile，要么盘点其有效的隐式默认协议，要么确保该内置默认定义始终留在可执行范围。不能让“旧音频缺字段仍能运行”和“启动时盘点认为没有引用”同时成立。当前分支的 `web/test/manual-channel-protocol.test.ts` 已明确覆盖“显式 capability 为 audio 且缺少 protocol 时仍使用 `openai-audio`”；统一 resolver 不能回归这条兼容语义。

BeefTV 的既有配置还多了一条安全限制：协议、渠道、账号和 token 是同一个执行身份的一部分。下线后不能自动切到备用渠道、换凭据或创建另一笔生成请求；但对已确认可重放的原提交，允许按原身份和原幂等键恢复，见第 5 节。

### 3.3 默认值应该由谁决定

**默认值应只有一个权威决策点。** 目录加载、模型编辑器、能力控件、创建任务和恢复任务可以有不同调用方，但不应分别实现：

- “协议是否已撤下”；
- “目录为空是无候选还是请求失败”；
- “已有显式协议是否可以继续运行”；
- “没有协议时该选哪个默认值”。

推荐的内部结果不是一个裸字符串，而是携带上下文的决策：

```text
ProtocolDecision {
  protocolId
  selectable       // 能否作为新配置/新任务的候选
  runnable        // 当前已有引用能否执行
  reason           // active / retired-reference / pending / catalog-unavailable / removed
  source           // saved-config / task-attempt / new-default / explicit-user-choice
}
```

这不是要求 #33 现在就新增公开 API 或数据库表，而是要求把现有多个 `defaultProtocol...`、`ensure...`、`resolve...` 的语义收敛到一个内部 resolver。

### 3.4 插件升级与未完成任务

后续修订：#78 复现了整包冻结会阻止旧任务获得解析修复，#80 据此修改实现；当前规则及验收见 [插件保留说明](../refactor/plugin-retention.md)。下面保留外部研究的范围，正常更新不再要求 pending 为零。

外部证据分两类：

- VS Code、Grafana 主要处理“已安装插件”的生命周期，没有 BeefTV 同等的远程异步结果回收。
- Terraform 证明旧 state 和旧 provider 版本不能随意删除，但不提供每个异步任务的版本快照。

因此 BeefTV 不能从外部项目推导出“保留插件名字就足够”。更可靠的两级策略是：

**短期（适合 #33）**：

- 正常兼容更新采用新版，未完成任务也使用修复后的同协议实现；必须通过旧回执、原任务查询和新建请求回归。
- 新版 manifest 删除或改名仍被保存配置或任务引用的 provider ID / 别名时，保留旧定义，推迟替换。
- 新版仍能解析旧 ID 只是避免 ID 断裂，不能证明查询合同兼容。不兼容合同使用新 ID，并继续提供旧实现。
- 盘点失败时，整包撤下或删除 ID 的更新保留旧定义；完整保留原 ID 的维护更新可以继续。

**原长期备选（未采用，不是本次前置条件）**：

- 提交任务时保存执行定义 digest 或不可变包版本。
- 查询/下载/解析只按任务绑定的定义加载；当前目录和新默认值不参与重选。
- 当旧定义确实不可用时，任务进入“无法按原定义取回/需要用户确认”，而不是自动重提交。

---

## 4. 对 BeefTV #33 当前方向的评估

评估基线：#33 分支 `tds/conv-01a17934-be1a-7ae4-a4a3-92b5b18cb0a9`，当前 tip `75f0695`；本工作树基线为 `70aa2a3`。以下只评估分支中的实现与文档，不改其代码。

### 4.1 应保留的部分

1. **撤下状态从引用推导，不写入 registry**
   - 这与 VS Code/Grafana 的目录层和引用层分离相符。
   - 只要已有模型配置或未完成任务引用协议，就把定义留在可解析范围内；隐式旧默认也必须被盘点覆盖，不能只数显式字段。

2. **“新选择不可见/不可选，旧显式引用仍可执行”**
   - 这是正确的产品语义，不能简化成一个全局 `enabled=false`。
   - 旧配置页面可以标记已撤下，但不能让 `resolveModelRequestConfig` 用新默认值覆盖它。

3. **保留删除被引用 ID 的保护**
   - 原先对所有 pending 延迟替换的建议已被 #78 的复现推翻：它会冻结任务恰好需要的解析修复。
   - `deferralFor()` 应检查新版移除的 provider ID / 别名是否仍有配置或任务引用；普通更新继续安装。
   - 盘点失败时，对撤下或移除 ID 的更新保留旧记录，不把未知当作无人使用。

4. **一次盘点、只取小字段**
   - 任务详情、任务列表和 by-operation 只应批量查询提交/派发所需字段。
   - 不应为了判断是否有未完成任务而加载并解密最大 64 MiB 的冻结图片请求。
   - 完整请求快照留到实际恢复，并按原 attempt/task/user 做全部校验。

### 4.2 需要重做或收缩的部分

1. **多个默认协议函数仍是主要风险**

   当前需要重点收敛的路径包括：

   - `defaultProtocolForCapability`
   - `defaultProtocolForModel`
   - `ensureModelProfilesWithUiDefaults`
   - `resolveModelRequestConfig`
   - 前端 `model-protocols` 和目录失败时的兜底

   如果这些函数各自拥有“目录为空时的默认值”“没有协议时的 fallback”“协议不可用时的替代”，就算 backend retention 正确，前端或请求层仍可能把撤下协议重新推导出来。

2. **`protocolPending` 只能是兼容标记，不能成为第二套决策源**

   `protocolPending` 对旧 profile 没有显式协议、且当前没有安全候选的情况有价值；但它必须只由统一 resolver 写入/清除。不能让 UI、保存逻辑和请求逻辑分别解释这个布尔值，否则会出现“界面显示待配置、提交时又偷偷采用默认协议”的分裂。

3. **必须区分“目录加载失败”和“目录成功但没有可选项”**

   两者都不能用一个空数组表达：

   - `catalog-unavailable`：无法证明当前目录；旧配置不动，新配置不自动赋值。
   - `catalog-loaded-no-selectable`：目录已知但没有可选协议；新配置应保持待配置，而不是回到内置默认。
   - `saved-explicit-retired`：旧配置仍有显式协议；保留其运行路径并显示撤下原因。

4. **不建议在 #33 继续增加完整的任务版本系统**

   任务 digest/包快照是长期正确方向，但它会同时牵涉任务表、插件包保留、解析器加载和恢复安全校验。当前 #33 先用“未完成任务延迟同名升级”作为保守策略，范围更可控；把完整不可变执行定义另开任务，避免 #33 再次变成全链路重构。

### 4.3 评审结论：当前缺的不是更多 guard，而是一个 resolver 契约

#33 的已有修补在局部上是合理的，但继续按“再给某个 fallback 加一个 if”推进，仍会反复出现同类漏洞。应先写清楚并测试以下不变量：

```text
新选择：只能选 selectable=true 的协议。
旧显式配置：只要 runnable=true，就不因 selectable=false 被改写。
未完成任务：只按 attempt 保存的协议/定义执行，不按新默认重选。
目录失败：不改变旧配置，不把未知状态当成可选候选。
升级盘点失败：不删除或覆盖可能仍被引用的旧定义。
```

---

## 5. #33 推荐修改方向与实施步骤

### 第一步：先定一个内部决策矩阵

至少覆盖以下行：

| 场景 | 目录状态 | 保存引用 | 新选择 | 执行/恢复 |
| --- | --- | --- | --- | --- |
| 正常协议 | 已加载，有候选 | 无 | 可选 | 可运行 |
| 已撤下但被旧配置引用 | 已加载 | 有显式协议 | 不可选/显示撤下 | 继续按旧协议 |
| 已撤下且无引用 | 已加载 | 无 | 不可选 | 不需保留新默认 |
| 目录加载失败 | 未知 | 有显式协议 | 不自动生成新默认 | 旧配置不被覆盖 |
| 目录加载失败 | 未知 | 无 | 待用户选择或明确错误 | 不静默猜协议 |
| 目录成功但无候选 | 已知空集 | 无 | 待配置 | 不回退到撤下协议 |
| 同名升级且新版删/改名仍被配置或任务引用的 provider ID / 别名 | 已加载 | 有旧引用 | 保留现有目录 | 旧定义继续解析 |
| 有未完成任务的兼容插件更新 | 已加载 | 原协议 ID 保留 | 新目录可更新 | 新实现查询原任务 |
| 升级盘点失败 | 未知 | 不确定 | 撤下或删 ID 时保留 | 原 ID 全保留的更新继续 |

### 第二步：收敛到一个 resolver

将现有默认和兜底路径改成调用一个内部决策函数。它至少需要知道调用场景：

- `new-profile`：只允许选择 `selectable=true`。
- `existing-profile`：优先使用保存的显式协议；撤下不等于不可运行。
- `task-recovery`：优先使用 attempt/task 保存的协议和定义摘要；禁止按当前模型能力重新猜。
- `catalog-unavailable`：返回未知/待配置，不覆盖已有字段。

当前报告不要求具体函数名，但要求删除“同一字段在多个函数中各自推导”的结构。

### 第三步：保留 #33 的运行时 retention 和升级护栏

- 继续从安装记录、保存配置和未完成任务盘点出 `retired` 视图。
- 继续保留撤下定义，避免启动 reconciler 把老配置直接删除。
- 同名包正常兼容更新不因未完成任务冻结；只在新版删除或改名仍被配置或任务引用的 provider ID / 别名时推迟。兼容性由旧回执和真实请求路径的回归验证，不由 ID 相等自动证明。
- 盘点失败时撤下和删 ID 保留；不涉及删 ID 的更新继续。
- 不新增 registry 永久 `retired` 字段，不引入第二个“已下线插件表”。

### 第四步：把前端目录和默认值改为只读 resolver 结果

前端可以展示三种状态：

- 正常可选；
- 已撤下但被当前配置使用；
- 目录暂不可用/待配置。

但前端不能自行拼接协议候选、再调用 `defaultProtocolForCapability` 另算一遍。目录请求失败时的硬编码 fallback 必须满足同一份后端可执行目录；若无法证明其仍可选，宁可显示“目录暂不可用”，也不要把撤下协议重新塞回新配置。

### 第五步：补回归测试，而不是只测“列表隐藏”

最少要覆盖：

1. 已撤下协议仍被旧模型配置显式引用时，模型请求仍使用旧协议。
2. 同一协议在新建配置列表中不可选。
3. 旧 profile 缺少 `protocol` 且没有 `protocolPending` 时，保留旧的隐式默认语义（例如音频仍为 `openai-audio`）；只有显式 `protocolPending: true` 才保持未配置，不自动套撤下协议。
4. 目录 HTTP 错误或盘点错误时，已有 profile 的协议、地址、模型和凭据不被覆盖。
5. 目录成功为空与目录请求失败产生不同的状态/日志。
6. 同名插件有未完成任务时升级不替换任务所需定义；即使没有任务，新版删除/改名仍被保存配置引用的 provider ID 时也不能直接替换。
7. 任务列表/详情的 SQL 不选择 `request_cipher` 或整行冻结请求，不逐任务 N+1 查询。
8. 失败恢复不创建另一笔生成请求、不切备用渠道或凭据；但在协议明确支持、原 endpoint/headers/body/幂等键仍有效时，允许按原身份重放同一提交以恢复结果。该重放不是新任务，必须保留现有 `sendImageSubmissionWith()` 的测试覆盖。
9. 所有默认入口都经过同一 resolver，不能用一个路径的单元测试掩盖另一个路径的 fallback。

### 第六步：另开任务做不可变任务定义

当 #33 的最小闭环稳定后，再引入：

- `task.protocol_id` 与 `task.definition_digest`；
- 按 digest 保留声明式 manifest/插件包；
- 查询、下载和解析严格按任务绑定的定义加载；
- 旧定义缺失时报告“原定义不可用/需确认”，不自动换渠道重提。

这样可以最终取消“只要存在未完成任务就拖住同名插件升级”的宽泛锁，但不应为了现在的下线修复提前引入整个版本仓库。

---

## 6. 最终决策

### 保留

- 新配置不可选，旧显式配置不被自动改写。
- 撤下状态从引用推导，不新增 registry 状态源。
- 有旧配置或未完成任务引用时，已安装旧定义继续可解析。
- 同名插件正常维护更新继续；新版删除/改名仍被配置或任务引用的 provider ID / 别名时保留旧定义。
- 盘点失败对撤下和删 ID 保守保留。
- 一次小字段盘点，恢复时才加载完整快照。

### 简化

- 把多个默认和 fallback 函数收敛到一个 resolver。
- 把 `selectable`、`runnable`、`task_execution_binding` 分开，不用一个 `enabled` 或一个空数组表达全部状态。
- `protocolPending` 只作为统一 resolver 的兼容结果，不允许各层自行推导。
- 目录失败、目录空集、旧显式撤下引用分别建模。
- #33 不做自动迁移、自动换渠道、自动换凭据、自动重提交。

### 推迟

- 完整的异步任务定义 digest/包快照和按版本恢复。
- 旧插件包的长期仓库存储与清理策略。
- 全部历史配置的自动迁移和替代协议推荐。

**因此，#33 不应继续沿当前多处补丁路线扩张；应先以“单一 resolver + 双轨状态 + 保守 retention”重做决策边界，再保留现有安全护栏。**

---

## 7. 许可与引用说明

本报告只引用公开文档、API 行为和源码结构来做设计研究，不复制外部项目代码。

| 项目 | 本报告用途 | 许可证/性质 | 使用边界 |
| --- | --- | --- | --- |
| VS Code | 编辑器弃用 UI 与已安装扩展分离 | 源码 MIT | 可参考思路，不复制代码 |
| Grafana | 目录隐藏、已有安装不受影响 | AGPL-3.0 | 只参考思路，按任务约束不搬代码 |
| Home Assistant | warning、config entry、stub 和最终移除 | Apache-2.0 | 可参考生命周期，不复制代码 |
| Terraform Plugin Framework | 兼容期、state/版本保留 | MPL-2.0 | 可参考版本演进原则，不复制代码 |
| OpenRouter | 动态模型目录、过期日期、provider routing | 商业 API/文档 | 仅作公开接口行为证据 |
| LiteLLM | alias 与 deployment 的单一路由决策 | 主体 MIT，enterprise 子目录另有许可 | 只参考路由模型，不复制代码 |
| one-api | channel 状态、模型映射、路由开关 | MIT | 只作网关模式参考 |
| new-api | channel/模型映射和运营禁用思路 | AGPL-3.0 | 只参考思路，不搬代码 |

---

## 8. 主要来源

- [VS Code 发布扩展：Deprecating extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#deprecating-extensions)
- [Grafana Plugin Deprecation Policy](https://grafana.com/legal/plugin-deprecation/)
- [Home Assistant Deprecating](https://developers.home-assistant.io/docs/deprecating/)
- [Home Assistant Integration Manifest](https://developers.home-assistant.io/docs/creating_integration_manifest/)
- [Terraform Framework Deprecations](https://developer.hashicorp.com/terraform/plugin/framework/deprecations)
- [Terraform Registry FAQ](https://developer.hashicorp.com/terraform/registry/faq)
- [OpenRouter Models API](https://openrouter.ai/docs/api-reference/models/get-models)
- [OpenRouter Provider Routing](https://openrouter.ai/docs/features/provider-routing)
- [LiteLLM Routing](https://docs.litellm.ai/docs/routing)
- [LiteLLM Model Management](https://docs.litellm.ai/docs/proxy/management/add_model)
- [one-api](https://github.com/songquanpeng/one-api)
- [new-api](https://github.com/Calcium-Ion/new-api)
- BeefTV #33 分支：`tds/conv-01a17934-be1a-7ae4-a4a3-92b5b18cb0a9`，tip `75f0695`。
- BeefTV 当前工作树基线：`70aa2a3`。
