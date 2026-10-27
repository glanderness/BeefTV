# 「已保存的模型按哪个协议执行」：后台盘点的判断规则

## 结论

启动盘点（见 [plugin-retention.md](./plugin-retention.md)）要知道每个已保存模型**实际**用哪个协议执行，否则会把老配置正在用的插件当成没人用而删掉。后台用一个函数回答这件事：

`providerpreset.SavedModelProtocol(channel, saved)`（`backend/internal/providerpreset/protocol_defaults.go`），只读已保存的配置，不看协议目录，所以协议被撤下也不会改变它对老配置的判断。

顺序固定为：

1. profile 上显式写的 `protocol`；
2. 带 `protocolPending: true` 的 profile：没有协议（现在的前端不会写这个字段，留给后续前端「待配置」状态用）；
3. 渠道的 `interfaceType`；
4. 系统渠道、Gemini / Claude 格式的渠道：不猜，没有协议；
5. 按能力取老默认：文本 `chat-completion`、图片 `openai-image`、音频 `openai-audio`；视频没有默认。能力取 profile 的 `capability`，没有就按模型名推断。

这和现在前端发请求时的 `resolveModelRequestConfig`（`web/src/stores/use-config-store.ts`）一致：缺 `protocol` 字段的老音频 profile 发请求用 `openai-audio`，盘点也把它算在 `openai-audio` 下（架构师在 #39 的意见 1）。

老默认和按模型名推断能力的关键词放在 `backend/internal/providerpreset/protocol_defaults.json`，内容与前端 `web/src/lib/model-protocols.ts` 里的 `FALLBACK_PROTOCOLS`、`inferProtocolCapabilityFromModel` 现值相同。**前端现在不读这个文件**，两边改动时要手动保持一致，直到前端接入（见下文「给前端的接口约定」）。因此 Docker 构建不需要复制这个文件：后台用 `go:embed` 编进二进制，`backend/Dockerfile` 复制整个 `backend/` 目录；根 `Dockerfile` 只构建前端，前端不引用它。

## 后台各处怎么用

| 调用方 | 以前 | 现在 |
| --- | --- | --- |
| 本地配置盘点 `SavedProtocolReferences`（`workspace/provider_config.go`） | 只数显式写出的 `protocol` | 每个 profile 和没有 profile 的已列模型都按 `SavedModelProtocol()` 计数，缺字段的老配置记在它实际使用的默认协议下；`protocolPending` 不计 |
| 插件升级 `deferralFor`（`plugins/retention.go`） | 任意未取回任务都推迟整包更新 | 只在新版删除或改名的 provider ID / 别名仍被配置或任务使用时推迟；新旧两侧均按 `resolvableProviderIDs` 比较，插件 ID 本身不算；保留原 ID 的维护更新继续，兼容性由回归验证，见 [升级验收](./video-protocol-upgrade-verification.md) |

已经提交的任务不归这个函数管：任务的协议取自任务输入里冻结的 `config.interfaceType`。图片提交恢复（`backend/internal/app/image_submission.go` 的 `sendImageSubmissionWith`）用冻结的请求和原幂等键重发同一个 POST，这一单没有改动（架构师意见 3）。

## 给前端的接口约定（后续「精简默认列表」那一步照此接入）

本 PR 不改前端。后台新增的字段前端暂时不用，现有行为不变。之后接入时：

**可以只读、不能改语义的：**

- 协议目录 `ProviderCatalogItem.retired`（布尔）和 `retiredReason`（文本）；插件中心 `View.retention: {retired, reasons, unknown}`。`retired` 为真表示本发行版已不带这个包、只为老配置和未取回任务保留，它仍可执行、仍出现在目录里。`retiredReason` 在「升级已推迟」时也会有内容，但此时 `retired` 为假，协议照常可选。
- `protocol_defaults.json` 里的 `legacy` 和 `capabilityKeywords`：这是「老配置按什么执行」的定义，盘点依赖它。前端可以改为从这个文件导入（导入后根 `Dockerfile` 的前端构建阶段要像另外两份合约 JSON 一样复制它），但不能在前端另写一份不同的默认值。
- 已保存配置的执行协议：前端发请求时必须和 `SavedModelProtocol()` 的顺序一致。显式 `protocol`、渠道 `interfaceType`、缺字段时的老默认，都不能因为协议目录里该协议已撤下而改写或清空。

**可以由前端决定、改动协议选择的：**

- 新模型、新连接的默认协议：可以排除 `retired` 的协议，也可以按自己的优先顺序挑。
- 推不出可选协议时，可以在 profile 上写 `protocolPending: true` 表示「待配置」；后台盘点和 `SavedModelProtocol()` 已经认这个字段（不计数、不补默认）。写了它的 profile，前端发请求也不能补默认协议。
- 用户手动选了协议后，清掉 `protocolPending`。

`backend/internal/providerpreset/testdata/saved_protocol_cases.json` 是这套规则的用例，前端接入后可以直接拿来跑同一组用例。

## 覆盖的测试

| 场景 | 预期 | 测试 |
| --- | --- | --- |
| 显式协议、老音频/图片 profile、`protocolPending`、渠道协议、视频无默认、系统/Gemini 渠道 | 见用例文件 | `providerpreset` `TestSavedModelProtocolMatchesSharedCases`（11 条）、`TestInferModelCapability` |
| 缺字段的老配置，后端盘点 | 计入它实际用的默认协议；`protocolPending` 不计 | `workspace` `TestSavedProtocolReferencesCountsChannelsAndProfiles`、`TestSavedProtocolReferencesCountsLegacyDefaultsAndSkipsPending` |
| 同名维护更新，有未完成任务但原 ID 保留 | 照常更新，重复启动保持新版 | `plugins` `TestUpgradeAdoptsQueryFixWithPendingTask`、`TestUpgradeStaysInstalledWhileWorkIsPending` |
| 同名升级，删掉或改名了已保存配置在用的 ID | 推迟；没人再用后照常升级 | `plugins` `TestUpgradeThatDropsASavedProviderIDIsDeferred` |
| 同名升级，删掉或改名了只有任务在用的 ID / 旧别名 | 推迟 | `plugins` `TestUpgradeReferenceRemoval`、`app` `TestVideoProtocolUpgradeRetainsRemovedTaskIDs` |
| 同上，但插件 ID 与旧 provider ID 同名 | 推迟 | `plugins` `TestUpgradeRenamingAProviderNamedLikeItsPluginIsDeferred`；别名仍能解析时照常升级：`TestUpgradeKeepingALegacyAliasIsAdopted` |
| 同名升级，ID 保留，只有已保存连接 | 照常升级 | `plugins` `TestSavedConnectionAloneNeverFreezesAnUpgrade` |
| 盘点失败 | 撤下/删 ID 保留；全保留 ID 的更新、新插件照常安装 | `plugins` `TestFailedAudit*`、`TestRetainsOfficialPluginWhenAuditFails` |
| 撤下且无人引用 | 删除 | `plugins` `TestDropsOfficialPluginNobodyReferences` |
| 图片恢复按原身份重放 | 保留，不新建生成、不换渠道 | `app` `TestImageSubmission*`、`TestImageAutoRecovery*`、`TestImageRecovery*` |

验证记录见 [plugin-retention-verification.md](./plugin-retention-verification.md)。

## 没有做的

- 前端读取 `retired` / `protocolPending`、新模型不默认选撤下协议：留到「精简默认列表」那一步，按上面的约定接入。
- 任务记住提交时的插件版本（definition digest）：原 #39 的长期备选，#78/#80 未采用，也不是本次正常更新的前置条件。
