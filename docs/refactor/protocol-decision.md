# 「用哪个协议」的统一决策点

## 结论

这一版把「一个模型用哪个协议」收到两处判断里，其余代码不再自己推算默认值：

| 问题 | 决策函数 | 读什么 | 不读什么 |
| --- | --- | --- | --- |
| 已保存的模型现在按哪个协议执行 | `savedModelProtocol()`（`web/src/lib/model-protocols.ts`），后端对应 `providerpreset.SavedModelProtocol()` | 只读已保存的配置 | 不看协议目录，撤下协议不会改动老配置 |
| 新加的模型给哪个协议 | `newModelProtocol()`（同一文件） | 协议目录及其状态 | 没法确认可选的协议不自动分配，改记 `protocolPending: true` |

已经提交的任务不归这两处判断：恢复时用任务里冻结的协议和请求（见下文「任务」）。

两端共用一份默认表 `backend/internal/providerpreset/protocol_defaults.json`（老配置的默认协议、新模型的优先顺序、按模型名推断能力的关键词），用例也共用一份 `backend/internal/providerpreset/testdata/saved_protocol_cases.json`。前端发请求用的协议，和后端启动盘点时算作「仍在使用」的协议，因此按同一套规则算出，不会出现「请求还在用，盘点却认为没人用」。

## 三件事分开

1. **能不能新选**：只看协议目录。目录有三种状态：
   - `loaded`：请求成功，能确认哪些协议存在、哪些已撤下；
   - `unavailable`：请求失败，只有前端写死的兜底清单。这份清单只能让用户手动选，`newModelProtocol()` 不会自动从里面挑；已知撤下的协议也会从清单里去掉；
   - 调用方手上没有目录（传空数组或不传）时，用本次会话最后一次加载并记下的目录（`recordProtocolCatalog`）；一次都没加载过，才用默认表里的老默认值，免得首次配置被卡住。
2. **老配置能不能照常用**：`savedModelProtocol()` 的顺序固定为：显式 `protocol` → 带 `protocolPending: true` 的没有协议 → 渠道的 `interfaceType` → 系统渠道、Gemini/Claude 格式不猜 → 按能力取老默认（文本 `chat-completion`、图片 `openai-image`、音频 `openai-audio`；视频没有默认）。缺 `protocol` 字段的老配置因此照旧用原来的默认，只有 `protocolPending: true` 才算待配置（架构师意见 1）。
3. **任务按什么定义执行**：仍由 #33 的后台盘点负责：有未完成任务就推迟同名插件升级，盘点失败就保守保留。这一单没有改任务的执行路径。

## 各调用方怎么接上

| 调用方 | 以前 | 现在 |
| --- | --- | --- |
| `resolveModelRequestConfig`（`use-config-store.ts`，发请求） | 自己按「显式 → 渠道 → 按能力补默认」推算，再特判 `protocolPending` | 直接调 `savedModelProtocol()` |
| `ensureModelProfilesWithUiDefaults`（编辑模型列表） | 对缺协议的老 profile 重新推默认，传 `[]` 时退回写死的表 | 已有 profile 走 `savedModelProtocol()`；新模型走 `newModelProtocol()`，推不出就记 `protocolPending` |
| `defaultProtocolForCapability` / `defaultProtocolForModel` | 各自带 `STANDARD_PROTOCOLS`、`FALLBACK_PROTOCOLS` 兜底 | 只是 `newModelProtocol()` 的薄包装，两张常量表已删除 |
| `fetchPluginProviderCatalog` 与写死的 `BUILTIN_OPENAI_PROTOCOLS` | 请求失败时把写死清单当成正常目录返回 | 改为 `loadProtocolCatalog()`，返回带状态的目录：失败时标 `unavailable`，并去掉已知撤下的协议；按能力过滤的请求不覆盖会话记录 |
| 设置页 `channel-model-settings.tsx` | 列表显示、首次建 profile 各自推算；切换能力时直接取默认 | 显示和首次建 profile 用 `savedModelProtocol()`（和请求一致）；切换能力走 `newModelProtocol()`，推不出就记 `protocolPending`；用户选了协议就清掉这个标记 |
| 模型服务向导 `serviceModelProfile`（`model-service-presets.ts`） | 只过滤 `enabled`，会把撤下协议分给新模型 | 候选（预设、端点提示、渠道协议）都经 `protocolSelectableForNewModel()` / `newModelProtocol()` 判断 |
| 拉取模型目录 `mergeFetchedChannelModelProfiles` | 新模型直接套模板协议 | 模板协议经 `newModelProtocol()`；厂商合约声明的协议若已知撤下则不用；推不出时保留模型、标记待配置，不再丢掉 |
| BeefAPI 视频 `beefApiVideoProtocol` | `defaultProtocolForCapability("video")` | `newModelProtocol("video")` |
| `ProtocolCardPicker` | 列出全部启用协议 | 撤下的协议只对已经在用它的模型显示 |
| 后端盘点 `SavedProtocolReferences`（`workspace/provider_config.go`） | 只数显式写出的 `protocol` | 每个 profile 和没有 profile 的已列模型都按 `SavedModelProtocol()` 计数，缺字段的老配置记在它实际使用的默认协议下 |
| 插件升级 `deferralFor`（`plugins/retention.go`） | 只看未完成任务 | 另外检查：新版本删掉或改名的 provider ID 如果还被已保存配置使用，也推迟升级（架构师意见 2）；ID 保留的升级照常进行 |

还有两处按 ID 判断的代码没有动：`channel-model-settings.tsx` 里按值查协议名称和请求信息的查询，以及后端各执行器内部 `Protocol == ""` 时报「未配置请求协议」的检查。它们都只读结果，不产生默认值。

## 任务与「按原身份重放」

图片提交恢复（`backend/internal/app/image_submission.go` 的 `sendImageSubmissionWith`）用冻结的请求和原幂等键重发同一个 POST，这一单没有改动（架构师意见 3）。前端的两个决策函数只在新建请求时用；恢复走后端冻结的快照，不会重新推协议，也不会换渠道。这组恢复用例本轮和基线 `75f0695` 都是 26 条全过。

## 决策矩阵与覆盖测试

前端用例在 `web/test/`，后端用例在 `backend/internal/`。

| 场景 | 预期 | 覆盖的测试 |
| --- | --- | --- |
| 显式协议的老配置，协议已撤下 | 照常用旧协议，不改写 | `protocol-decision.test.ts` 「request resolution follows the saved decision and ignores the catalog」；`plugin-catalog-retired.test.tsx` 前两条 |
| 缺 `protocol` 的老音频/图片 profile | 用 `openai-audio` / `openai-image` | 共用用例「legacy audio/image profile keeps …」（前端 `protocol-decision.test.ts`、后端 `TestSavedModelProtocolMatchesSharedCases`）；`manual-channel-protocol.test.ts` 「explicit capability is kept when protocol is missing」 |
| 带 `protocolPending: true` | 没有协议，渠道协议也不补 | 共用用例「pending profile …」两条；`plugin-catalog-retired.test.tsx` 「the unconfigured state survives …」 |
| 缺字段的老配置，后端盘点 | 计入它实际用的默认协议；`protocolPending` 不计 | `workspace` `TestSavedProtocolReferencesCountsChannelsAndProfiles`、`TestSavedProtocolReferencesCountsLegacyDefaultsAndSkipsPending` |
| 新模型，目录已加载且有可选项 | 按优先顺序挑可选的 | `plugin-catalog-retired.test.tsx` 「a retired protocol never becomes the default …」；`protocol-decision.test.ts` 「a loaded catalog is recorded …」 |
| 新模型，目录已加载但全部撤下 | 待配置 | `protocol-decision.test.ts` 「a loaded catalog with no selectable protocol …」；`plugin-catalog-retired.test.tsx` 「with no selectable protocol …」 |
| 新模型，目录请求失败 | 不自动分配，待配置；兜底清单去掉已知撤下项 | `protocol-decision.test.ts` 「an unavailable catalog never assigns …」「a failed request yields an unavailable fallback …」「a retired protocol stays out of a later fallback list」 |
| 新模型，调用方手上没有目录 | 用会话最后一次记下的目录 | `protocol-decision.test.ts` 「callers without a catalog use the one recorded this session」 |
| 首次运行，从没加载过目录 | 用老默认，不堵新建连接 | `protocol-decision.test.ts` 「with no catalog at all …」；`manual-channel-protocol.test.ts` 默认值用例 |
| 模型服务向导 / 拉取模型目录 | 不分配撤下协议；推不出时保留模型并标记待配置 | `protocol-decision.test.ts` 「the model-service editor …」「a fetched catalog model …」；`model-service-presets.test.ts`、`channel-model-catalog.test.ts` 原有用例 |
| 同名升级，有未完成任务 | 推迟 | `plugins` `TestDeferredUpgradeKeepsTheOldQueryDefinition`、`TestUpgradeAdoptsNewDefinitionOnceWorkIsDone` |
| 同名升级，删掉或改名了已保存配置在用的 ID | 推迟；没人再用后照常升级 | `plugins` `TestUpgradeThatDropsASavedProviderIDIsDeferred`（临时去掉这项检查后会失败） |
| 同名升级，ID 保留，只有已保存连接 | 照常升级 | `plugins` `TestSavedConnectionAloneNeverFreezesAnUpgrade` |
| 盘点失败 | 保留旧定义；新插件照常安装 | `plugins` `TestFailedAudit*` 三条、`TestRetainsOfficialPluginWhenAuditFails` |
| 撤下且无人引用 | 删除 | `plugins` `TestDropsOfficialPluginNobodyReferences` |
| 图片恢复按原身份重放 | 保留，不新建生成、不换渠道 | `app` `TestImageSubmission*`（含 `…DiskRestartReplaysOneGenerationAndCompletesOnce`、`…PermanentErrorsDoNotFallBackToAnotherRoute`） |

## 验证记录（2026-10-27，Mac 工作区）

先跑 `sh plugin-packages/build-packages.sh`（86 个协议包），再跑下列测试；基线 `75f0695` 在临时 worktree 里跑同一组，跑完已删除。

| 检查项 | 本轮 | 基线 `75f0695` |
| --- | --- | --- |
| `go test ./internal/plugins/` | ok | ok |
| `go test ./internal/workspace/` | ok（改了 1 条预期，新增 1 条） | ok |
| `go test ./internal/protocol/` | ok | ok |
| `go test ./internal/providerpreset/` | ok（新增共用用例） | ok |
| `go test ./internal/repository/`（含 CGO/sqlite） | ok | ok |
| `go test ./internal/app/ -run 'TestPluginReferences\|TestImageSubmission\|TestImageRejection\|TestImagePreparation'` | 26 pass | 26 pass |
| `bun run typecheck` / `bun run lint` | 通过 | 通过 |
| 前端 17 个协议相关用例文件 | 189 pass / 0 fail | 16 个文件 168 pass / 0 fail（基线没有 `protocol-decision.test.ts`） |

`TestSavedProtocolReferencesCountsChannelsAndProfiles` 改了预期：它的合成配置里有一个缺 `protocol` 的 profile 和一个没有 profile 的已列模型，旧预期认为它们不引用任何协议；按架构师意见 1，它们实际用 `chat-completion`，盘点必须算上，否则撤下 `chat-completion` 时会把它们正在用的插件删掉。

全部基于合成配置，没有读取真实凭证，没有发起生成请求。没有重跑前端全量套件（已知 `settings-model-picker.browser.test.ts` 在基线上有 7 条失败，见 [plugin-retention-verification.md](./plugin-retention-verification.md)）。

## 没有做的

- 任务记住提交时的插件版本（definition digest）：按 #39 报告第 5 节第六步另开一单。
- 不新增按钮或设置项；待配置的模型仍由设置页现有的协议选择让用户处理。
