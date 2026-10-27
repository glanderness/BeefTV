# 撤下官方协议插件时的旧配置与未取回任务保护

## 结论

从这一版开始，启动时的官方插件清理不再“发行包里没有就删除”。`backend/internal/plugins/bootstrap.go` 的 `reconcileBuiltIns` 会先做一次引用盘点，只有当没有任何已保存配置和未取回结果的任务引用该协议时，才删除对应的官方插件记录。

被保留的插件：

- 继续用已提交的清单、包哈希和启用状态执行任务，老连接、老模型配置和原任务查询照常工作；
- 标记为**已撤下**（插件中心 `retention.retired`、协议目录 `retired`），供前端把它排除在新的协议选择之外（前端接入在后续一步，见下文「对外投影」）；
- 一旦最后一个引用消失，下一次启动就会按原逻辑清理，不需要人工干预，也没有第二个状态表。

本步只做后台保护，不删除任何插件包，不改前端代码。

## 判定依据

引用盘点读取三处已有数据，没有新增状态来源：

| 来源 | 读取方式 | 计入的引用 |
| --- | --- | --- |
| 本地模型配置 `local-model-config.json` | `workspace.ProviderConfig.SavedProtocolReferences()`，只读解码，不改写文件、不轮换备份、不返回凭证 | `channels[].interfaceType`、`channels[].protocol`、`channels[].modelProfiles[].protocol` |
| 系统渠道模型 `channel_models` | `repository.ChannelModelProtocolReferences()` | 未软删除行的 `protocol` |
| 生成任务 `tasks` | `repository.TaskProviderReferences()`，协议取自任务输入的 `config.interfaceType` | 排队/运行中的任务；已持有上游任务 ID 的失败任务（结果恢复还要查同一协议；任务表里没有 ID、但请求日志 `api_call_logs` 里有的也算，人工取回会从日志补回这个 ID，盘点只读不改）；上游取消仍在进行中的已取消任务 |

不计数的情况：已完成任务、提交前就失败的（没有上游任务 ID）、上游取消已确认的任务、文本回放容器。

任务的协议**不能**从 `tasks.provider` 列读出来：普通 BYOK 任务的该列是空的，系统路由任务是 `managed`，真正决定执行的协议在任务输入的 `config.interfaceType`。所以取数时同时读这两处并按任务去重；只按 `provider` 查询会漏掉真实在跑的任务，用户改过连接后就会误删它还要用的插件。

匹配用的是**协议 ID**而不是包 ID。例如 `openai-videos` 这个包对外提供的 provider ID 是 `newapi`，用户配置和任务里保存的都是 `newapi`，所以 `recordProviderIDs` 会把包 ID、它声明的每个 provider ID，以及运行时 `Registry.Resolve` 还能解析到这些 provider 的别名（如 `openai-video`）都纳入匹配。别名规则统一由 `protocol.ResolvableIDs` 给出，判断“是否还有人用”和“新版本能否解析”都用它，不另写一份。

`interfaceType` 也计入，因为更早的连接把协议存在渠道级字段上，没有逐模型 profile。

## 失败与保守策略

- 盘点读不到（配置损坏、数据库不可用）时，这一轮**保留全部**未随包发行的官方插件，理由写“插件引用盘点失败，已按保守策略保留该协议”。宁可多留一个插件，也不因为读不到配置而删掉用户正在用的协议。
- 没有接入盘点来源的运行时（例如只用文件 registry 的独立测试壳）保持原来的删除行为，避免把“未知”误当成“有人引用”。
- 主配置缺失时**读备份**：正常读取路径会用 `.bak` 恢复，所以“主文件不存在”不等于“没有配置”。只剩有效备份时盘点照常计数；两个文件都没有才是真正首次启动；备份也读不出来按失败处理（保留全部）。

## 正常更新与删除被引用协议分别处理

正常维护更新通过现有启动流程更新同一份 registry，即使仍有未取回任务也安装。旧任务需要新版修复才能取回时，“有任务就保留旧定义”会形成循环。#78 已复现这一问题，修复和可重跑证据见 [video-protocol-upgrade-verification.md](./video-protocol-upgrade-verification.md)。

`deferralFor` 比较新旧清单真正可解析的 provider ID 与别名，继续复用 `protocol.ResolvableIDs`，包名不能冒充协议 ID：

- 新版本保留所有原 ID：照常更新，任务继续使用原 ID、原上游任务编号和原凭据。盘点失败也不阻止这种更新。
- 新版本删除或改名某个 ID / 旧别名：只有该 ID 仍被保存配置或未取回任务使用时才推迟。任务上游 ID 仅在日志中、运行中、取消未确认也受保护。其他仍保留的 provider 的任务不阻止更新。
- 删除 ID 且盘点失败：无法判断旧引用，保留原记录；整包撤下的保守保留规则不变。
- 新插件尚未安装：没有旧记录可保留，盘点失败仍安装。定义未变化的重新打包不误报推迟。
- 推迟期间仍随包发行的插件保持可选，只在 `retention.reasons` 说明原因；启停状态、包缓存和 registry 提交继续走原机制。

**ID 相同不证明请求兼容。** 维护者必须验证旧任务回执、原 ID 查询、新建请求以及必要请求头和地址拼接。真正不兼容的协议应使用新 ID，同时提供旧 ID 的实现；不增加厂商白名单、更新开关或另一份运行注册表。

本次没有数据迁移，也不通过删除任务、清空上游 ID 或重新生成来解除冻结。回退发行包会重新安装其旧清单，并可能重新带回解析缺陷；不能保证回退后仍可取回。

## 与现有机制的关系

- **registry**：保留的记录原样留在已提交的 registry 里，清单字节不变（`TestRetentionIsDerivedAndNeverPersisted`），因此不会因为一次启动产生无谓写入。
- **启用状态**：用户手动停用的插件保留停用，不会被这一版重新启用（`TestRetainsDisabledOfficialPluginWithoutReenablingIt`）。
- **配置 revision 与备份**：本步不改写任何配置。本地配置只被解码读取，revision、备份文件、用户手改的字段都保持原样。
- **升级与回退**：发行包重新包含该插件后，记录照常由包刷新版本，撤下标记随之消失，用户停用状态保留（`TestUpgradeKeepsUserDisabledStateAndRetiresNothing`、`TestRollbackShipsPackageAgainAndClearsRetirement`）。
- **缺包**：包文件丢失不影响执行，因为适配器由已提交的清单生成；只有“重新下载插件包”会报自己的错误（`TestRetainsOfficialPluginWhosePackageFileIsMissing`）。

## 标记在所有重建路径上重新附加

`retention` 是每次启动推导出来的，不写进 registry。因此插件集合只要重建一次（安装、卸载、启用/停用），就必须重新附加标记，否则用户切换另一个插件之后，已撤下的协议会重新变成可选。所有重建路径统一走 `Runtime.build()`（`persist.go`），启动、安装、启停、卸载共用同一条。

## 对外投影

- 插件中心接口 `View` 增加可选 `retention: {retired, reasons, unknown}`，说明为什么这个已撤下的插件还在。
- 协议目录接口 `ProviderCatalogItem` 增加 `retired` 与 `retiredReason`。

本 PR 只交后台。现在的前端还不读 `retired` / `retention` 这两个字段，所以对用户来说：

- 被保留的协议会像普通启用协议一样出现在协议列表里，老配置照常显示、照常执行，这是本步要的效果；
- 它暂时**不会**被标成不可新选，新模型仍可能选到它。本 PR 不撤下任何协议包，所以只有等「精简默认列表」那一步真正撤下协议时才会出现这种情况；那一步会同时让前端读这两个字段，按[协议决策的接口约定](./protocol-decision.md)把撤下协议排除在新选择之外。

插件中心里针对撤下插件的文案标签也属于那一步，本步不加界面元素。

## 覆盖的场景

| 场景 | 位置 |
| --- | --- |
| 老配置引用 → 保留并标记，按 provider ID 可执行 | `backend/internal/plugins/retention_test.go` `TestRetainsOfficialPluginReferencedBySavedConfiguration` |
| 只有未取回结果的任务引用 → 保留 | `TestRetainsOfficialPluginForUnretrievedTaskOnly` |
| 无人引用 → 仍然删除，registry 不残留 | `TestDropsOfficialPluginNobodyReferences` |
| 盘点失败 → 保守保留 | `TestRetainsOfficialPluginWhenAuditFails` |
| 包被用户停用 → 保留且不重新启用 | `TestRetainsDisabledOfficialPluginWithoutReenablingIt` |
| 缺包 → 仍可执行，下载单独报错 | `TestRetainsOfficialPluginWhosePackageFileIsMissing` |
| 升级 → 版本刷新、停用状态与引用保留 | `TestUpgradeKeepsUserDisabledStateAndRetiresNothing` |
| 回退 → 重新随包发行后撤下标记消失 | `TestRollbackShipsPackageAgainAndClearsRetirement` |
| 撤下标记不写进 registry | `TestRetentionIsDerivedAndNeverPersisted` |
| 无盘点来源的运行时保持原行为 | `TestRuntimeWithoutAuditStillDropsRemovedOfficialPlugin` |
| 本地配置 / 渠道模型 / 任务三处引用合并 | `backend/internal/app/plugin_references_test.go` |
| 本地配置只读解码（含加密快照） | `backend/internal/workspace/provider_config_references_test.go` |
| 任务与渠道模型的取数范围 | `backend/internal/repository/provider_references_test.go` |
| 只用旧别名 `openai-video` 的配置或任务 → 保留 | `TestRetainsOfficialPluginReferencedOnlyByLegacyAlias` |
| 只用旧别名的配置：新版本仍解析该别名 → 升级；不再解析 → 推迟 | `TestUpgradeDroppingAnAliasOnlyReferenceIsDeferred` |
| 失败任务的上游 ID 只在请求日志里 → 计入且不回写 | `TestTaskProviderReferencesCountsFailedTaskRecoverableFromRequestLog` |
| 有未取回任务的正常更新 → 采用并持久化查询修复 | `TestUpgradeAdoptsQueryFixWithPendingTask` |
| 任务仍在时重复启动 → 保持新版、registry 不反复改写 | `TestUpgradeStaysInstalledWhileWorkIsPending` |
| 只有已保存连接时不冻结升级 | `TestSavedConnectionAloneNeverFreezesAnUpgrade` |
| 盘点失败且升级删除 ID → 保留已安装定义 | `TestFailedAuditDefersUpgradeOfShippedPlugin` |
| 盘点失败且保留原 ID → 更新，用户停用状态不变 | `TestFailedAuditAllowsUpgradeKeepingProviderIDs` |
| 仅任务引用 ID / 旧别名 → 保留时更新、删除时推迟 | `TestUpgradeReferenceRemoval` |
| 多 provider 包 → 只检查被删除 ID 的引用 | `TestUpgradeMultiProviderOnlyChecksRemovedReferences` |
| SQLite 旧 registry、失败任务行/日志 ID、运行中任务 → 正常启动后取回 | `backend/internal/app/video_protocol_upgrade_test.go` |
| SQLite 只有任务引用被删除 ID；回退旧请求、重新升级取回 | `backend/internal/app/video_protocol_retention_test.go` |
| 盘点失败但包没变 → 照常采用，不误报推迟 | `TestFailedAuditStillAdoptsAnUnchangedPackage` |
| 盘点失败但插件尚未安装 → 照常安装 | `TestFailedAuditStillInstallsNewShippedPlugin` |
| 安装 / 启停 / 卸载后撤下标记仍在 | `TestRetentionSurvivesUnrelatedPluginChanges` |
| 仅剩备份时仍能盘点；两个文件都没有才是空 | `TestSavedProtocolReferencesReadsRecoverableBackup`、`TestSavedProtocolReferencesWithoutBothFilesIsEmpty` |
| 任务协议取自 `config.interfaceType`（真实入参形状） | `TestTaskProviderReferencesResolvesTheDispatchedProtocol`、`TestTaskProtocolsReadsTheDispatchedProtocol`、`TestInputProtocolIgnoresCredentials` |

## 证据限度

- 全部用本地合成配置和测试数据验证，没有读取真实用户凭证或连接厂商接口；新建路径只向本地假上游发 POST，原任务取回为零 POST。
- 数据库相关用例需要 CGO（`go-sqlite3`），已在 Mac 工作区跑过，见 [plugin-retention-verification.md](./plugin-retention-verification.md)。
- 本步不评估厂商是否停服，也不判断某个协议是否还有真实可用性；它只回答“这份配置和这些任务还需不需要这个插件”。
- 只防将来：旧版本已经删掉的官方插件记录不会因为这次改动回来——它们的清单已不在 registry 里，无法凭空重建执行定义。这类用户的配置会显示协议未知，需要另行判断是否重新安装包含该包的版本。
