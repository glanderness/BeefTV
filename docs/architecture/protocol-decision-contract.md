---
half_life: 14d
archive_at: 2026-11-10
artifact_mode: delivery-doc
scope_type: slice
scope_name: 精简默认目录前的前端协议读写约定
coverage: 协议写入权限、六类调用场景、旧配置解释、待配置状态、复用判断与回归清单
not_complete_for: 后台保护的交付验收、实际撤包、任务定义版本绑定、付费验证和发布
verification_level: docs-only
real_smoke_status: not_required
review_status: not_reviewed
reviewer: none
review_command: 本轮仅核对固定提交、调用链与文档；未进行独立评审
review_notes: 接口名和行为是实施建议，不表示前端改造已完成或已获实施批准
review_owner: 项目负责人
review_due: 精简默认目录实施前，按届时主线复核
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

# 前端协议决策接口约定

## 1. 推荐结论与适用范围

**保留 #44 的旧配置读取规则，重做前端写入权限。一个模型的协议只在“加入模型”和“用户主动修改协议相关设置”时决定；展示、目录刷新、BeefAPI 归一化和提交请求不得替已有模型重选协议。**

继续用 `model-protocols.ts` 承担这项职责，不另建配置库、协议服务或任务执行器。协议决定必须连同 `protocolPending` 一起交付，调用方不能只拿字符串再补默认值。配置的持久化继续走 `commitModelConfig` 和现有本地配置仓库。

本文件面向后续实施者与评审者，只覆盖整理方案 P1-B“精简默认目录”所需的前端接口与验收。用户已选择当前先交后台保护；本文件不恢复 #44 的前端实施范围，不撤下任何协议，不改变后台保护、任务恢复、凭据或供应商路由。任务绑定插件定义版本仍是独立工作。

以下涉及“必须”的条款，是本建议被采用后实现应遵守的合同，不表示这些行为已在当前应用中实现。新增协议选项、恢复自动选择和历史错误配置批量迁移，都不能从本设计推导出执行授权。

## 2. 已核对的来源与修正

| 来源 | 固定版本 / 阅读内容 | 本文如何使用 |
| --- | --- | --- |
| 本工作树 | `d647039`；模型设置、配置归一化、目录合并、请求组装及相邻测试 | 当前实现基线。这里还没有 #44 的统一决策实现；不能把分支能力写成主线现状 |
| [#44 设计](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/docs/refactor/protocol-decision.md) | 实际获取分支头 `1c98775a7d447a93cb4fbac5f1413c71aba057a1`；设计、源码、测试；对话两轮评审 | 判断复用范围，追踪六项初审问题和三项复审问题 |
| [#39 调研](https://github.com/glanderness/BeefTV/blob/ae04dfe45974224a199f241d687e27c848045a13/docs/research/protocol-retirement-patterns.md) | `ae04dfe45974224a199f241d687e27c848045a13`，重点为第 3–6 节 | 沿用新选择、旧引用和任务恢复分开处理的原则；报告中的建议类型不是已实现 API |
| [BYOK 整理方案](../research/byok-consolidation-plan.md) | 当前工作树文件第 4、7、9 节 | 旧配置优先、服务预设只初始化；先后台保护，再最小完整 BYOK，再精简默认目录 |

任务补充说明中的“三处问题”描述的是对 `c7109ef` 的复审。`1c98775` 在此之后又做了修订，并新增对应测试。因此本文将三处作为必须保留的回归案例，**不认定它们在最后版本中仍按原方式复现**。分支文档记载的测试通过是原作者记录，本轮未重跑，不能算本轮运行证据。

但 `1c98775` 仍不符合本约定：`beefApiProtocol` 仍优先使用未标记撤下的合约；向导仍用 `mismatched/notInstalled` 推翻旧继承；目录合并仍能以新的声明协议覆盖已有协议。问题已经不适合继续靠三处各补判断解决。

对“目前没有协议真正撤下”的处理：本轮没有读取用户安装环境，不能证明所有运行实例的状态。本设计不依赖已经发生撤下，全部验收使用合成目录；实际撤下仍属于后续阶段。未重新开展外部项目调研，本文不额外声称外部服务状态。

## 3. 数据含义与不变量

### 3.1 三个对象分别由谁决定

| 对象 | 权威来源 | 前端可以做什么 |
| --- | --- | --- |
| 已保存模型的有效协议 | 保存的 `modelProfiles`、渠道 `interfaceType`、固定的旧默认规则 | 只读解析；新目录不改变解析结果 |
| 协议能否成为新选择 | 本机后端协议目录的启用、撤下、能力与适用范围 | 统一过滤并校验；供应商模型目录不是本机执行能力证明 |
| 已提交任务的执行协议 | 后端任务及其已保存请求 | 前端只请求恢复；不重新决定协议、渠道或凭据 |

`retired` 表示不再接受新选择，不等于执行被禁止。旧引用可以继续提交新生成，前提是原定义和执行条件仍然满足；这不是“只能取回历史任务”。`enabled: false`、定义缺失或实际请求失败要如实报错，但不能借机自动换协议。前端读出一个协议 ID，也不等于证明供应商当前可用。

`apiFormat` 是目录读取及既有格式适配信息，不是生成协议的替代字段。`interfaceType` 是渠道级已有协议引用；它对新模型只是一项候选。`logicalModelId`、系统渠道和工作流的后台解析路径继续各有原来的权威来源，不通过本模块伪造协议。

本合同的唯一写入口针对前端管理的模型配置。后台权威系统渠道的读取、初始化与更新仍接受后台结果，不由前端重新择协议；BeefAPI 的用户可编辑渠道即使使用托管凭据，也不能借此豁免前端读写规则。

### 3.2 怎样区分新模型与已有模型

- 模型身份是同一渠道内的原始模型 ID；显示名和上游别名不能把一个模型变成另一个已有引用。
- 一次操作开始前，已存在于渠道的 `models` **或**已保存 `modelProfiles` 中的模型，都按已有模型处理；没有 profile 不代表新模型。
- 新加入的模型在同一次配置更新中取得完整 profile：有明确协议，或有 `protocolPending: true`。不能先把名字加入 `models`，随后调用旧配置读取器把它当成老配置补默认值。
- 向导的未选目录项只是预览数据，不写入持久化 `modelProfiles`。草稿中已通过统一写入入口加入的模型，也按已有决定处理，重复渲染、勾选和保存不重新初始化。
- 删除后重新添加、复制到另一渠道属于新选择，不能借旧引用身份绕过撤下限制。未改变协议的普通字段编辑不是新选择。

不新增持久化的 `isNew` 或协议来源字段。操作前的配置快照和明确的用户动作足以区分这些情况。

### 3.3 旧配置没有 `protocol` 时怎么读

保留 #44 `savedModelProtocol` / Go `providerpreset.SavedModelProtocol` 的顺序，目录不作为输入：

1. 非空显式 `profile.protocol` 优先；只做已确认的等价 ID 规范化，不替换协议格式。
2. 没有显式协议且 `protocolPending === true`：有效协议为空，不继承渠道，不套旧默认。
3. 否则，非空 `channel.interfaceType` 是有效协议；协议的能力不能被模型名推断覆盖。
4. 仍没有协议时，系统渠道以及 `apiFormat` 为 `gemini`、`claude` 的渠道不猜 OpenAI 协议。
5. 其余旧渠道按已保存 capability 读取旧默认；没有 capability 才使用固定的模型名能力推断表。文本为 `chat-completion`，图片为 `openai-image`，音频为 `openai-audio`，视频没有隐式默认。

这里的“空”包括缺字段、空字符串与纯空白。`protocolPending: false` 与缺省标记同义。已有模型完全没有 profile 时，也按上述顺序解释，不能直接改成待配置。

旧数据同时带非空 `protocol` 和 `protocolPending: true` 时，沿用 #44 的显式协议优先，返回数据冲突诊断；读取时不删字段、不把已有配置停用。新写入禁止产生这种组合。前后端共享用例必须包括这一行及等价别名，保证启动盘点能保留请求实际使用的定义。

缺协议且没有 pending 的旧视频、Gemini/Claude 或系统模型，属于“旧配置没有在这里解析出协议”，不是“曾明确决定待配置”。后续请求是否可用，分别交给已有格式适配或系统路由校验；不能为让返回值非空而写入 `chat-completion`。

### 3.4 `protocolPending` 只记录一次明确的配置决定

持久化只保留现有字段，不增加第二套 pending 表：

| 状态 | 保存形式 | 允许发生的转换 |
| --- | --- | --- |
| 已明确选择 | `protocol` 为非空 ID，省略 `protocolPending` | 用户主动换协议、清空协议或改能力时，由统一入口改变 |
| 明确待配置 | 省略 `protocol`，`protocolPending: true` | 用户通过现有选择器选中可用协议后才清除标记 |
| 旧隐式配置 | 两字段都缺省，或 pending 为 false | 按旧规则读取；普通打开、刷新、保存不转换 |

新建没有安全候选、用户主动清空协议、用户改能力导致旧协议不适用，才由统一写入入口产生 pending。调用方不得自行添加、删除或用 `false` 清除它；序列化必须保留 `true`，不能因过滤空字段而顺带删掉标记。

**目录恢复可用时，已有 pending 仍保持 pending。** 用户用现有协议选择器完成选择即可，不增加按钮。这是对 #44“目录恢复后自动采用协议”的有意收缩：后台刷新不能悄悄把一个不可提交的模型变成可提交。

## 4. 最小内部接口

以下名称是后续实现约定，不是本轮新增的代码。仍集中在 `web/src/lib/model-protocols.ts`；输入使用只读的窄类型，不依赖 React、Zustand 实例或网络请求。底层可以复用 `savedModelProtocol`，但业务调用方统一使用下面三个接口。

| 接口 | 必须输入 | 返回内容 | 副作用 |
| --- | --- | --- | --- |
| `readModelProtocol` | 操作前的渠道、模型 ID、对应 profile；不接收目录 | `resolved`：协议与来源 `explicit/channel/legacy`；`pending`：明确待配置；`unconfigured`：没有有效协议，并区分旧配置与 `not-added`。必要时带数据冲突诊断 | 无；不补 profile、不写字段、不确认上游可用性 |
| `listModelProtocolChoices` | 显式协议目录快照、模型能力、当前读取结果 | 可新选的协议列表；另列当前协议及撤下/禁用/缺失/未知说明 | 无；当前协议即使不可新选也能显示，不自动选列表第一项 |
| `applyModelProtocolChange` | 操作前完整渠道、明确动作、模型信息、显式目录快照 | `applied` 与完整 `nextChannel`，或 `unchanged`，或 `rejected` 与原因；成功结果包含可再次读取的最终状态 | 纯函数；仅此处构造协议字段更新，实际保存仍由配置仓库完成 |

写入动作限定为：`add-model`、`choose-protocol`、`clear-protocol`、`change-capability`、`change-channel-routing`。不设 `refresh`、`normalize` 或任意 `patch.protocol` 动作。返回的完整更新必须整体应用，禁止调用方再加 `protocol || default`。失败不返回可误保存的半成品。

读取器先检查模型是否已存在。对尚未加入的目录预览项返回 `unconfigured/not-added`，不能套旧默认；界面可读目录能力和可选项，但直到加入动作才产生配置决定。`add-model` 遇到已存在的同 ID 返回 `unchanged`，不得当作重新初始化命令。

动作的最小参数和失败行为固定如下；`unchanged` 总是保留原对象，`rejected` 不产生配置更新：

| 动作 | 动作参数 | 成功 / 无法选择时的结果 |
| --- | --- | --- |
| `add-model` | 模型 ID、可选的用户明确 capability、供应商原始元数据、服务预设声明 | 初始化成功为 applied；没有可确认协议也为 applied，但新 profile 必须 pending，并返回原因 |
| `choose-protocol` | 已有模型 ID、明确选择的协议 ID | 合法新选择为 applied；当前同 ID 为 unchanged；目录未加载、失败、目标撤下/缺失/能力不符则 rejected |
| `clear-protocol` | 已有模型 ID | 写入 pending；已经 pending 为 unchanged；不要求目录成功 |
| `change-capability` | 已有模型 ID、用户选的新 capability | 与原值相同为 unchanged；旧协议已知兼容则保留，否则写 pending；不替换为另一协议 |
| `change-channel-routing` | 用户明确修改的 `interfaceType` 或 `apiFormat` | 先按第 4.3 节保护旧模型；新渠道协议也需验证可新选，失败则整体 rejected；仅改变目录格式不要求重新选择旧协议 |

除 add 外，模型不存在时拒绝操作。初始化未能决定协议的原因至少区分 `catalog_not_loaded`、`catalog_unavailable`、`no_selectable_protocol`、`ambiguous_contract`；原因只用于返回和展示，不另存一套 pending 状态。

`applyModelProtocolChange` 负责协议字段、相关能力及相应参数默认值的协调；它调用现有 `defaultModelCapabilityConfig`，不重写参数引擎。普通显示名、价格等更新走原有代码。协议改变后旧连接测试结果失效，沿用现有测试回执机制，不增加测试状态存储。

### 4.1 目录输入必须显式携带状态

协议目录快照固定区分 `not-loaded`、`loaded`、`unavailable`，同时标明请求的 `scope` 与能力覆盖范围。`loaded` 的空列表是成功的空集。`unavailable` 即使带旧的展示信息，也不能作为新选择的证据；首次未加载同样不能自动给新模型补旧默认。

目录加载器只负责请求、DTO 转换与缓存。缓存按当前工作区、scope、能力范围隔离，复用现有查询/请求设施；不新造全局状态管理器。完整目录与按能力过滤的目录不能相互覆盖。调用方必须传入自己持有的快照，移除 `recordedCatalog` / `knownRetired` 对决策的隐式影响，禁止用 `[]` 表示“请猜上次的目录”。

只有 `loaded` 且覆盖当前能力、当前 ID 已启用、未撤下的目录项能证明新选择合法。供应商声明和 BeefAPI 合约只能提供候选，不能跳过此检查。别名必须经后端可解析的规范 ID 或明确的等价映射确认；插件包 ID、模型名以及“没有在 knownRetired 中出现”均不能充当证明。未确认的别名返回 pending，不默认放行；若后续确需目录提供别名，应从现有 provider 元数据投影，不能另维护一份猜测表。

前端写死的 fallback 可保留为说明材料，不能作为可点击的新选择。目录失败只影响新协议选择；旧模型的普通编辑和原协议执行不以成功加载目录为前提。用户仍可手填模型 ID 并保留草稿，不能把供应商 `/models` 失败与本机协议目录失败混为一件事。

### 4.2 新选择如何选候选

在统一模块内按下面顺序读取证据：准确的供应商协议合约或明确 endpoint 元数据 → 用户为该连接已选的协议 → 服务预设。调用方传原始元数据与预设声明，不自行排好协议 ID 数组，也不预先调用 `protocolSelectableForNewModel`。准确合约与 endpoint 提示冲突时，以准确合约为准；多个同等可信声明冲突时返回 pending，不能由遍历顺序决定。

新模型 capability 先取用户明确选择，再取准确模型合约/明确目录能力，再取已选渠道协议的已知能力，最后才用模型名提示。明确证据相互矛盾且会改变协议时返回 pending，不能靠改 capability 让某个候选通过。这个推断仅用于新建；旧模型的解释严格采用第 3.3 节。可信声明明确列出多个可用 endpoint 属于候选集合，不是互相冲突的声明。

采用最高一层有效证据后，只从这层明确允许的候选中选；已撤下、禁用或缺失就保持 pending，不能退到另一个不同格式。只有完全没有更高层证据时，才采用所选服务预设的默认值。通用 OpenAI 兼容预设可以有文本、图片、音频默认；**不按视频能力或模型名自动选择 `newapi` / `newapi-channel-2`，也不选任意同能力的第一个协议**。五种视频中转格式不能互换。

旧默认表的 `legacy` 只用于旧配置；`preferred` 只提供已确定候选集中的稳定排序，不构成执行依据。服务预设、endpoint 映射和 BeefAPI 合约仍各用现有数据源，统一模块消费它们，不把相同映射再抄一份。

依赖只朝一个方向：预设的固定候选表作为纯声明传入，协议模块不反向 import 会调用它的 `serviceModelProfile` 或 store。目录解析的协议映射也提供原始事实，过滤、优先级和是否写入仅在统一模块执行。已有混在函数内的数据表可移出为同一源的声明，不复制另一套默认表。

用户明确选择另一个协议时，必须通过相同目录校验；拒绝后旧配置原样保留。用户保存“当前已经使用的同一个协议”是无变化，协议撤下或目录失败也不阻止该保存。主动改能力时，已知仍匹配的旧协议可保留；不匹配或无法确认时写 pending，不猜另一种格式。

### 4.3 不能通过渠道字段绕过模型协议写入

`interfaceType`、`apiFormat`、模型 ID 和 capability 都可能改变隐式旧默认。除用户明确动作外，普通归一化与目录刷新不能改写这些决定协议的字段。

`change-channel-routing` 用于用户修改渠道协议或目录格式：先读取修改前每个已有模型的有效协议，对依赖渠道或旧默认的模型显式保存原协议，再修改渠道字段。原 pending 保持；原来就无有效协议的模型写 pending，避免新渠道默认把它悄悄启用。此写入由同一入口完成，页面不得循环自行补协议。修改渠道默认不代表批量更换已有模型；需要换的模型通过现有模型设置逐个明确修改。

只编辑显示名无需此动作；真正替换模型 ID 按删除旧条目、加入新条目处理。后台系统渠道的协议变更仍由后台管理，不能把 `change-channel-routing` 用作覆盖系统配置的通道。

## 5. 模块读写权限

“可写”指能产生不同的协议决定，不是能否复制对象或调用持久化函数。

| 模块 | 协议权限 | 必须删除或禁止的行为 |
| --- | --- | --- |
| `lib/model-protocols.ts` | 唯一计算并构造 `protocol/protocolPending` 更新的位置；包含旧引用读取器 | 不读隐藏的会话目录，不加载网络，不持久化 |
| `lib/model-service-presets.ts` | 提供预设信息和原始候选证据；可读取已有决定 | 不在 `serviceModelProfile` 中按域名、模型名或目录缺失重选旧协议 |
| `lib/channel-model-catalog.ts` | 解析模型目录、计算非路由元数据；新增项通过唯一写入口初始化 | 不覆盖旧协议，不清 pending，不直接信任 `mapped.protocol`；不把无 profile 的已列模型判成新增 |
| `stores/use-config-store.ts` | 加载、复制和替换已决定的配置；请求解析只读 | `normalizeConfigSnapshot`、`enrichBeefApiMediaChannel` 不修协议；不持有 BeefAPI 特例选择器 |
| `pages/settings/model-service-editor.tsx`、`channel-model-settings.tsx`、`channel-settings-pane.tsx` | 收集用户动作、展示读取结果、调用写入口并保存其完整返回值 | 渲染、过滤、保存前不得重跑新建选择；不手写 pending，不清 profile 冒充新模型 |
| `components/model-protocol-picker.tsx`、`model-protocol-browser.tsx` | 展示选项与当前引用，发出用户选择事件 | 不直接写 profile，不自行补默认；当前撤下项不能复制给新模型 |
| `services/api/plugin-catalog.ts` | 加载协议目录并保留状态、适用范围、撤下信息 | 不用硬编码列表伪装成功目录；无候选时也要返回明确状态 |
| `services/model-config-repository.ts`、本地配置读写 API | 保存/恢复完整配置，沿用现有 revision 与失败处理 | 不解释协议默认值、不吞掉 pending、不在失败后报告保存成功 |
| `services/api/generation-task.ts`、`image.ts`、`audio.ts`、`video.ts` 及传输层 | 消费请求解析结果，检查所选路径的前提 | 不以空协议走 OpenAI 默认，不在错误后另选协议或渠道，不改配置 |
| 参数、凭据说明和连接测试模块 | 按有效协议读取能力、鉴权说明和回执 | 不用 `profile.protocol || interfaceType` 绕过 pending；不能用声明协议给旧协议套另一套鉴权或参数 |

`ensureModelProfilesWithUiDefaults` 原签名没有修改前的完整渠道，无法可靠区分“已有模型没 profile”和“本次新增”。后续取消这个业务写入口；由增删模型动作显式提供前后快照。`defaultProtocolForCapability/defaultProtocolForModel` 不能继续供调用方取得一个可直接落入配置的裸字符串；必要的排序逻辑只留作统一模块内部函数。

实施时把页面普通 patch 类型中的 `protocol/protocolPending` 排除，明确选择用动作传递；同样检查 capability 与渠道路由字段。评审用代码检索逐一核对所有赋值、字段删除及对象展开覆盖位置，只有统一写入口可以产生新决定，序列化和原样复制除外。无需为此引入通用规则引擎或新的 lint 依赖。

## 6. 六个场景的调用约定

| 场景 | 调用什么、传什么 | 拿回什么、由谁保存 | 不许做什么 |
| --- | --- | --- | --- |
| 新建模型 | 手填、勾选或自动发现的新增项调用 `applyModelProtocolChange(add-model)`；传操作前渠道、模型能力依据、预设/endpoint 元数据和协议目录快照 | 完整新模型决定：显式协议或 pending；页面/服务通过原配置仓库整体保存。向导未完成选择可保留草稿，沿用现有保存校验 | 先加入模型名再当旧模型读；只保存 `.protocol`；把名字包含视频型号当成协议证明 |
| 已有模型 | 展示与普通编辑调用 `readModelProtocol`；主动换协议、清空或改能力才调用对应写动作 | 稳定的有效协议或明确空状态；普通编辑原样保存原协议字段 | 因目录撤下、缺失、失败或模型名推断而改协议；以“补 UI 默认”为名写入 |
| 目录刷新 | `applyFetchedChannelModelCatalog` 以刷新前配置分类；解析器只提供元数据，已有项只读；本次新加入项调用 `add-model` | 已有协议字段保持；新增项得到完整决定；名称、价格及匹配当前协议的能力信息可更新 | 对已有 pending 自动重试选协议；删除目录没返回的旧引用；以新的声明协议替换旧协议；更新 capability 导致旧默认改变 |
| BeefAPI 归一化 | `normalizeConfigSnapshot` / `enrichBeefApiMediaChannel` 对已有模型调用 `readModelProtocol`；真正首次初始化的模型在建立时走 `add-model` | 既有协议、pending 和旧默认解释不变；参数补全以有效协议为准 | `contract || current`；按模型名把 text 改成 audio 再补旧默认；使用 `legacyDefaultProtocol` 另算；视频没有协议时再调新建选择 |
| 向导 | 列表预览只读；新增/明确改能力时调用写入口；保存校验只读当前草稿 | 保存前后的协议结果一致；未选协议指出模型并打开现有编辑器；不增加操作按钮 | 保存时重新调用会择协议的 `serviceModelProfile`；为读元数据清空 `modelProfiles`；目录失败时以预设推翻渠道继承 |
| 提交请求 | `resolveModelRequestConfig` 使用 `readModelProtocol`，保留状态供所有实际出站入口校验 | 将已解析协议映射到请求 `interfaceType`；pending 返回可解释错误，相关出站调用为零；有效旧引用照原协议执行 | 只返回 `undefined` 然后让下游 fallback；请求解析更新配置；401/415/超时后改协议再生成 |

### 6.1 刷新、归一化和保存必须满足的等式

对前端管理、操作前已存在的模型，`P` 表示完整协议决定（包括 pending、来源及影响隐式默认的字段），`R` 表示刷新，`N` 表示归一化：

```text
P(R(C)) = P(C)
P(N(C)) = P(C)
P(R(N(R(N(C))))) = P(C)
P(保存后重新加载(C)) = P(C)
```

比较既包括有效协议，也包括持久化的 `protocol/protocolPending` 是否被无授权改写。价格和名称的变化不影响这些等式。目录移除模型可以影响发现列表，不能自动删除保存引用；这是对当前 BeefAPI 刷新直接替换 `models/modelProfiles` 的必要调整。

元数据表明 capability 与旧协议冲突时，只返回诊断，不以新 capability 重算旧默认；需要修改的部分由现有模型编辑器处理。协议专属 capabilityConfig、authType 也只能取自当前有效协议，不能保留旧 ID 却套新协议的请求参数。

### 6.2 BeefAPI 的“修正旧路由”如何处理

`1c98775` 的测试还要求将已保存 `chat-completion` 的某个音频模型自动改为 `openai-audio`。这是历史修复行为，不是无副作用的归一化。**本建议停止在日常归一化中做这种修正**，让已保存值、旧默认和 pending 有稳定含义。

后续若确有必须自动修复的数据，要单列迁移：有准确旧数据特征、限定模型/渠道范围、明确前后协议、重复执行无变化、回退与验收依据，再由同一写入模块提供专用迁移动作。仅凭 BeefAPI 域名、模型名或“看起来配错”不足以证明可以改写用户配置。没有这些证据的旧错误配置保留并报告问题，由用户在现有编辑器修正。

因此不能直接沿用“归一化仍会修正旧路由”的测试预期，也不能为了维持它给统一接口加一个任意 `force` 开关。本轮只提出这项设计取舍，不执行任何数据迁移。

### 6.3 提交请求不能把 pending 丢在中间

本轮源码中，`image.ts` 的 `requestImageQuestion/requestToolResponse` 有空 `interfaceType` 走 Chat Completions 的分支；`audio.ts` 非 `async-audio` 会走 `/audio/speech`。所以只断言 resolver 返回空值还不够。

后续必须让实际调用入口先识别 `pending` 并停止，再进入各协议适配。已有 Gemini/Claude 格式适配和后端权威系统路由可按其原有规则验证 `unconfigured`，但不能接管 pending 来完成另一种生成。校验结果不写回配置；不因前端目录临时失败否定有效旧引用。错误原因需机器可识别，例如 `protocol_pending`、`protocol_unconfigured`、`protocol_capability_mismatch`；这里只约定内部结果，不增加公开 HTTP 错误码或数据库列。

工作流使用独立选择的 workflow provider，继续走原路径，不能把模型 pending 偷偷转成工作流。后台图片恢复仍可以使用冻结请求和原幂等键重放同一个 POST；“不重新选择协议”不能误写成“任何恢复都禁止 POST”。

## 7. #44 现有实现的沿用清单

结论是**保留旧引用解释、数据映射和测试素材，重写新选择接口及三个自动改写路径**。不按行数估计百分比，也不整段搬回旧分支；当前主线包含 #44 分叉后新增的凭据说明等改动。

| #44 内容（`1c98775`） | 沿用程度 | 后续操作 |
| --- | --- | --- |
| `savedModelProtocol`、共享 `legacy`/能力推断表、Go `SavedModelProtocol` | 核心顺序可直接沿用 | 包装为带状态的读取结果；核对别名规范化与冲突数据在前后端一致。不把目录加入旧读取器 |
| `saved_protocol_cases.json`、旧默认与 pending 的正反例 | 用例素材直接保留 | 增补无 profile、空白、显式+pending、Claude、别名与多次保存；同时检查后台引用盘点 |
| `retired/retiredReason` 的 DTO 映射、保留当前撤下协议的选择器展示 | 数据与展示思路可沿用 | 统一消费选择列表和当前读取结果；不沿用失败目录可新选的入口 |
| `resolveModelRequestConfig` 调 `savedModelProtocol` 的替换方向 | 可沿用调用方向，不能原样结束 | 传递 pending/unconfigured 状态直到真正出站处，补阻断证据；请求组装本身不重写 |
| `newModelProtocol` 的候选过滤 | 过滤条件可参考；对外合同重做 | 去掉 optional catalog、数组兼容、unknown 自动放行、任意同能力兜底；返回完整写入结果 |
| `declaredProtocolForNewModel`、`recordedCatalog/knownRetired`、裸字符串默认包装 | 不直接沿用 | 删除旁路；声明候选也验证同一显式目录，目录缓存不决定隐藏状态 |
| `ensureModelProfilesWithUiDefaults` | 原签名及新旧分类不沿用 | 替换为有操作前渠道的新增/编辑动作；保留无关字段和参数 helper |
| `beefApiProtocol/beefApiVideoProtocol/beefApiPendingProfile` 与 `enrichBeefApiMediaChannel` 的择协议分支 | 协议分支重写 | 移除合约修路由与自行 pending；有效协议只读。模型合约、价格、已验证参数规则保留并按有效协议使用 |
| `serviceModelProfile` | 预设、凭据与参数基础可沿用；决定协议的函数体重写 | 移除 mismatched/notInstalled 后重选；分开只读预览与用户动作；保存不再初始化 |
| `mergeFetchedChannelModelProfiles` | 目录解析、价格和参数映射可沿用；协议合并分支重写 | 已有项不覆盖协议或 pending；新增项统一调用写入口；不能只看 profile 是否存在 |
| `model-service-editor` / 设置页事件 | 现有 UI、保存仓库可沿用；事件连接调整 | 读写分开，结果整体保存，pending 只由统一入口处理；保留当前主线的凭据说明和手填能力 |
| Docker 共享 JSON 输入修复 | 若继续使用该相对导入，可直接沿用 | 验证前端实际构建上下文；不能只验证宿主机 import |
| 后台保留、升级延迟、provider ID/别名保护及图片恢复 | 不因本合同重做 | 由后台保护任务交付；本文件只列必要的交叉回归，不把前端设计变成后台重写任务 |

`protocol-decision.test.ts` 中四种预期需要明确替换：首次无目录也给默认值、无显式目录依赖会话记录、归一化修正旧路由、目录恢复后自动清掉 pending。保留它们的输入作为反例，改为断言本合同；不能为了让旧测试继续通过保留对应旁路。

## 8. 实施验收清单

以下均为**后续实现待执行**，本轮只完成来源和覆盖关系核对。用合成配置、本地 mock、临时数据目录与占位凭据，不做真实付费生成。标有“沿用”的测试名只表示 #44 有相应素材，不表示本设计已通过运行验收。

### 8.1 两轮复审逐项映射

为避免轮次名称混乱：R1 指对 `2d50aa8` 的六项评审；R2 指对 `c7109ef` 的三项复审。#44 文档称修订测试为“第二轮/第三轮”，不影响以下问题身份。

| 编号 / 原问题 | 合成输入与必须断言 | 证据位置 / 验收状态 |
| --- | --- | --- |
| R1-1 插件 ID 与旧 provider ID 同名，改名保护漏判 | 插件 `x` 原有 provider `x`，新版只有 `x-v2`，保存引用 `x`；应推迟替换。新版保留真实可解析别名时可升级 | 沿用 `TestUpgradeRenamingAProviderNamedLikeItsPluginIsDeferred`、`TestUpgradeKeepingALegacyAliasIsAdopted`；后台交叉回归待执行 |
| R1-2 Docker 漏共享 JSON | 前端构建阶段实际包含 `protocol_defaults.json`，能解析相对导入 | 沿用根 Dockerfile 修正，运行 `docker build --target web-build .`；待执行 |
| R1-3 向导改写旧默认 | OpenAI 渠道旧 text profile 缺 protocol；预设偏好 Responses。打开、过滤、保存、重载仍为 `chat-completion`，原字段不被补成新预设 | 沿用 `the model-service wizard keeps a legacy profile's default and a pending mark`；补完整 UI 保存链，待执行 |
| R1-4 向导丢 pending | 新图片模型，仅有已撤下图片协议；新增结果 pending，保存/重载/请求仍 pending，出站次数为零 | 沿用 `a wizard profile refused by the catalog stays pending all the way to the request`；补出站 spy，待执行 |
| R1-5 BeefAPI 给 pending 补协议 | BeefAPI 音频模型已标 pending；经过 create/normalize/保存重载及再次 normalize 后仍 pending，不能补 `openai-audio` | 沿用 `BeefAPI normalization does not fill a pending model back in`；待执行 |
| R1-6 新模型继承撤下渠道协议 | 渠道 `openai-image` 已撤下；新发现图片模型不得继承，须 pending。协议启用且未撤下的对照组才可初始化 | 沿用 `a newly fetched model does not inherit a retired channel protocol`；待执行 |
| R2-1 R1 修订反而停用旧 BeefAPI 配置 | 已有 `seedance-2.0/newapi`、缺协议旧音频 profile、已列无 profile 音频模型；目录撤下对应协议后，显式值和旧默认都保留，不产生 pending | 沿用 `BeefAPI normalization keeps saved models running after their protocol is retired`；再加渠道继承优先及反向模型名案例，待执行 |
| R2-2 向导推翻渠道继承 | 已列 `model-123` 没 profile，渠道为 `video-generations-json`；模型名似 text 仍读视频协议。另用旧 `claude-api` 继承与目录失败，保存前后不变 | 沿用 `the wizard keeps a channel protocol a saved model inherits`；加入 loaded 空集、禁用和缺失三组，待执行 |
| R2-3 第二次刷新补回撤下协议 | BeefAPI 新音频项首次刷新变 pending；通过真实 `applyFetchedChannelModelCatalog → normalize → 保存重载` 连续执行两次再提交，仍 pending、出站零次。协议恢复后刷新也不清标记 | 沿用 `a catalog refresh keeps a pending model pending and never refills a retired protocol`，修改最后自动采用的旧预期；待执行 |

### 8.2 防止再出现同类遗漏

| 编号 | 验收条件 | 证据层次与位置 / 状态 |
| --- | --- | --- |
| C01 旧值优先级 | 显式协议、显式+pending、渠道继承、text/image/audio 旧默认、video 无默认、system、Gemini、Claude、空白字段均按第 3.3 节一致解析 | `protocol-decision.test.ts` 与 Go `TestSavedModelProtocolMatchesSharedCases` 共用 fixture；待执行 |
| C02 引用盘点一致 | 无 profile 的已列模型也计入有效旧协议；pending 不计；等价别名计到仍可解析的定义。空集合与盘点失败不能等同 | `SavedProtocolReferences` 相关 workspace 测试；待执行 |
| C03 新旧身份 | 同一渠道已有模型没 profile、孤立的已保存 profile、真正新增、删除重加、复制到别的渠道分别分类；向导未选预览不套旧默认、不变成旧引用；重复 add 不重选 | `model-service-presets.test.ts`、`channel-model-catalog.test.ts`、模型设置交互 fixture；待执行 |
| C04 目录状态 | 首次未加载、失败且有 fallback、成功空集、全撤下、禁用、能力范围不匹配都不能新分配；已有协议不被影响 | `protocol-decision.test.ts`、`plugin-catalog-retired.test.tsx`；待执行 |
| C05 声明不豁免 | 合约声明的 ID 缺失、已撤下、禁用、能力不符或只有未经确认的别名，都不分配；插件 ID 与 provider ID 不混用 | 扩展 `a declared protocol is not auto-assigned when the catalog request failed`，覆盖 loaded 条件；待执行 |
| C06 候选不换格式 | 最高层候选撤下而另一个同能力协议存在，不偷偷换过去；仅有视频模型名不分配通用 multipart/JSON；同级声明冲突 pending，多 endpoint 声明按候选排序；文本预设正常对照可初始化 | 统一写入口及服务预设 fixture；待执行 |
| C07 缓存不决定结果 | 两个 workspace/scope、能力过滤目录、请求完成顺序变化；相同显式输入得到相同决定，失败后不使用上次成功结果授权新选择 | 目录加载器 mock 与纯函数确定性用例；待执行 |
| C08 用户动作 | 选择合法协议同时写 ID/清 pending；选撤下或缺失的新 ID 被拒且原值保留；保存当前撤下 ID 是无变化；清空只生成 pending | 写入口单测与选择器事件测试；待执行 |
| C09 隐式字段变化 | 改渠道 `interfaceType/apiFormat` 保留其他已有模型有效协议；改显示名无变化；改 capability 不匹配时 pending；真正换模型 ID 走新增规则 | channel 设置交互及写入口 fixture；待执行 |
| C10 全组合读取 | 四能力 × 显式/继承/旧默认/pending × loaded/空集/失败/未加载，穿过向导、刷新、normalize、保存重载后比较协议字段与有效结果；重复三次无漂移 | 参数化集成 fixture；待执行。无旧默认的组合按 unconfigured 断言 |
| C11 保存失败 | 保存请求失败保留编辑内容和 pending，不显示服务端保存成功；重试原内容不重选协议 | `model-config-repository` 与设置页保存 mock；待执行 |
| C12 真正出站 | 对文本看图、工具文本、音频、图片/视频任务实际导出入口注入 pending：网络/任务创建 spy 为零；正常旧引用为正对照；系统路由和工作流正常路径不被错误阻断 | `generation-task.ts`、`image.ts`、`audio.ts` 相关测试与调用点核对；待执行 |
| C13 旧配置不可执行 | 旧 ID 在目录缺失/禁用，或协议能力冲突：显示原 ID 和准确问题，不写 pending、不换协议；后台拒绝也不触发另一笔生成 | 设置组件与请求错误 mock；待执行 |
| C14 目录缺项与元数据 | 刷新缺少旧模型仍保留引用；新价格可更新，但声明不同协议时不覆盖原 ID、capability、authType 或协议参数 | `applyFetchedChannelModelCatalog`、BeefAPI 归一化集成；待执行 |
| C15 恢复不重选 | 旧图片按冻结请求和原幂等键重放；视频按原任务查询取回；切换当前目录/默认列表不改变原任务身份、不创建另一笔生成 | 沿用 `TestImageSubmission*` 与任务恢复用例；后台交叉回归待执行 |
| C16 UI 一致 | 现有选择器可见当前撤下 ID 但新模型选不到；pending 在向导、设置、提交错误中一致；明暗主题、保存与手填流程可用；不增加按钮/设置 | 本地浏览器合成场景，含当前主线凭据说明回归；待执行 |

验收应同时观察结果与副作用：只断言“默认函数返回空”不足以通过 C12；只看下拉列表隐藏不足以通过 R1-4/R2-3；只跑 `newModelProtocol` 单测不足以证明全调用链遵守写权限。

## 9. 后续实施顺序与交付条件

1. **先确认届时后台保护版本。** 复核 provider ID/别名、旧默认盘点、盘点失败和图片恢复证据。后台保护失败时不进入物理撤包；前端合同不能替代这些证明。
2. **先做唯一读写入口及最小纵向用例。** 同时接通新增模型、保存重载和一个实际提交入口；用 R1-4 证明 pending 全程保留且不出站。目录快照显式输入，旧读取规则与 Go fixture 一致。
3. **一次替换协议写入调用方。** 向导、目录合并、BeefAPI 归一化及模型设置按权限表一起调整；删除旧旁路，再执行 R1/R2 和 C01–C16。不要留下“统一入口已建，其余以后迁”的半套默认系统。
4. **最后才精简默认目录。** 在旧引用保存、重复刷新、干净安装可选列表与实际构建输入证据齐全后，按整理方案推进。实际撤哪些协议以该阶段批准的清单为准，本文件不提供新撤下名单。

后续最低验证命令按实际最终测试路径执行：在 `web/` 运行相关 Bun 专项测试及 `bun run typecheck`、`bun run lint`，另验证共享 JSON 的 Docker 前端构建；后端只跑受影响的 providerpreset/workspace/plugins 和恢复专项。本轮没有执行这些运行检查，也没有启动 dev server 或修改本机应用。

回退时保持 `protocolPending` 的解释能力，不能直接退到会忽略该字段的旧前端；遇到问题先停止精简目录，保留新读取/保存合同，回退选择列表与展示改动。配置备份与恢复使用现有机制，不通过批量删除 pending 或补默认值“修复”。物理撤包及后台升级的回退仍由对应阶段负责。

本轮设计交付检查：单一文档覆盖六类场景、写权限、旧默认和 pending、两轮九项问题、可复用与必重写清单；已按固定源码逐项自查。文档结构检查与本地链接检查只证明资料完整，不等于接口实现、运行验收或独立架构评审通过。

## 10. 源码导航与记忆交接

- [#44 设计与验证记录](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/docs/refactor/protocol-decision.md)。
- [#44 协议模块](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/web/src/lib/model-protocols.ts)：`savedModelProtocol`、`newModelProtocol`、`declaredProtocolForNewModel` 与会话目录。
- [#44 BeefAPI 归一化](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/web/src/stores/use-config-store.ts#L819)、[向导](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/web/src/lib/model-service-presets.ts#L35)、[目录合并](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/web/src/lib/channel-model-catalog.ts#L141)。
- [#44 回归用例](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/web/test/protocol-decision.test.ts)、[前后端共享用例](https://github.com/glanderness/BeefTV/blob/1c98775a7d447a93cb4fbac5f1413c71aba057a1/backend/internal/providerpreset/testdata/saved_protocol_cases.json)。
- 当前工作树：[模型配置](../../web/src/stores/use-config-store.ts)、[目录合并](../../web/src/lib/channel-model-catalog.ts)、[向导入口](../../web/src/pages/settings/model-service-editor.tsx)、[配置保存](../../web/src/services/model-config-repository.ts)、[生成任务](../../web/src/services/api/generation-task.ts)、[文本/图片入口](../../web/src/services/api/image.ts)、[音频入口](../../web/src/services/api/audio.ts)。

记忆状态：已在显式 `default` Space 检索，未找到可替代本任务的已确认协议合同；依据仍是当前任务、固定报告与源码。本文件为 `proposed`，不是 owner-confirmed 验收合同。后续检索应先读本文再读 #44 的历史修补记录；若用户确认实施，更新本文及验收记忆，不将建议自动写成已经完成的产品行为。

已主动保存建议稿检索索引到 nmem `39454530-9545-4db3-af45-83b4d65dd51c`，仅用于找到本文，不是验收批准记录；本轮没有另建本地记忆副本。本文仍是方案原文。
