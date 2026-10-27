# 撤下官方协议插件时的旧配置与未取回任务保护

## 结论

从这一版开始，启动时的官方插件清理不再“发行包里没有就删除”。`backend/internal/plugins/bootstrap.go` 的 `reconcileBuiltIns` 会先做一次引用盘点，只有当没有任何已保存配置和未取回结果的任务引用该协议时，才删除对应的官方插件记录。

被保留的插件：

- 继续用已提交的清单、包哈希和启用状态执行任务，老连接、老模型配置和原任务查询照常工作；
- 标记为**已撤下**（`retirement.retired`），不再提供给新的协议选择；
- 一旦最后一个引用消失，下一次启动就会按原逻辑清理，不需要人工干预，也没有第二个状态表。

本步只做保护，不删除任何插件包，也不改动 `#26` 即梦、`#27` 设置页凭证、`#28` Runway 结果映射正在修复的文件。

## 判定依据

引用盘点读取三处已有数据，没有新增状态来源：

| 来源 | 读取方式 | 计入的引用 |
| --- | --- | --- |
| 本地模型配置 `local-model-config.json` | `workspace.ProviderConfig.SavedProtocolReferences()`，只读解码，不改写文件、不轮换备份、不返回凭证 | `channels[].interfaceType`、`channels[].protocol`、`channels[].modelProfiles[].protocol` |
| 系统渠道模型 `channel_models` | `repository.ChannelModelProtocolReferences()` | 未软删除行的 `protocol` |
| 生成任务 `tasks` | `repository.TaskProviderReferences()`，协议取自任务输入的 `config.interfaceType` | 排队/运行中的任务；已持有上游任务 ID 的失败任务（结果恢复还要查同一协议）；上游取消仍在进行中的已取消任务 |

不计数的情况：已完成任务、提交前就失败的（没有上游任务 ID）、上游取消已确认的任务、文本回放容器。

任务的协议**不能**从 `tasks.provider` 列读出来：普通 BYOK 任务的该列是空的，系统路由任务是 `managed`，真正决定执行的协议在任务输入的 `config.interfaceType`。所以取数时同时读这两处并按任务去重；只按 `provider` 查询会漏掉真实在跑的任务，用户改过连接后就会误删它还要用的插件。

匹配用的是**协议 ID**而不是包 ID。例如 `openai-videos` 这个包对外提供的 provider ID 是 `newapi`，用户配置和任务里保存的都是 `newapi`，所以 `recordProviderIDs` 会把包 ID 和它声明的每个 provider ID 都纳入匹配。

`interfaceType` 也计入，因为更早的连接把协议存在渠道级字段上，没有逐模型 profile。

## 失败与保守策略

- 盘点读不到（配置损坏、数据库不可用）时，这一轮**保留全部**未随包发行的官方插件，理由写“插件引用盘点失败，已按保守策略保留该协议”。宁可多留一个插件，也不因为读不到配置而删掉用户正在用的协议。
- 没有接入盘点来源的运行时（例如只用文件 registry 的独立测试壳）保持原来的删除行为，避免把“未知”误当成“有人引用”。
- 主配置缺失时**读备份**：正常读取路径会用 `.bak` 恢复，所以“主文件不存在”不等于“没有配置”。只剩有效备份时盘点照常计数；两个文件都没有才是真正首次启动；备份也读不出来按失败处理（保留全部）。

## 升级同名包时先看未取回结果的任务

撤下一个包只是撤下的情形之一；同名包升级同样会替换执行定义（查询路径、结果解析）。任务没有绑定插件版本，取回结果时用的是当前 registry，所以升级会改变旧任务的取回方式。方案 7.3 第 3 条要求：这类包在任务活跃期间不替换执行定义。

实现：替换前比较已提交记录与新包，只有在**定义确实变化**且**仍有未取回结果的任务**引用该协议时，这一轮保留旧记录（清单、包哈希、启用状态都不动），新包下一次启动再采用。因此：

- 已保存连接本身**不会**冻结升级——只有未完成任务才会，否则每个在用的插件都会永远停在旧版本；
- **只推迟已有安装记录的升级**：发行包里全新、尚未安装的插件没有旧定义可保留，盘点失败时照常安装；否则一次配置读取失败就会让本次发行新增的插件静默缺席；
- **盘点失败也会推迟升级**：“盘点失败”和“没有接入盘点”是两回事。前者说明这台机器确实有待取回任务的可能，只是读不出来，因此保留已安装定义；后者（只用自己的 registry 的独立运行时）保持原行为。代价要写明：配置长期损坏时，同名插件会一直停在旧版本，直到盘点恢复正常——宁可晚升级，也不拿旧任务的取回方式去赌；
- 是否“算一次升级”只比较清单（执行定义）。重新打包但定义没变时（例如只刷新了包路径/哈希）不算，避免把同版本的重新打包误报成推迟；
- 推迟期间插件仍随包发行，所以照常可选，只是 `retention.reasons` 会说明“升级已推迟”；
- 副作用要说清楚：一个长期挂着的失败任务（保留上游 ID、等人工取回）会持续推迟该插件的升级，直到用户重试或处理掉这个任务。这是按方案 7.3.3“没有版本关联就暂不升级”做的取舍，方向是宁可晚升级，也不让旧任务被新定义取回。

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
- 前端 `plugin-catalog.ts` 把这些标记带进 `ModelProtocolDefinition`。撤下的协议仍留在协议列表里，所以老模型照常显示自己保存的协议名称和请求信息；`ModelProtocolBrowser` 只是把它的选项置为不可选中。
- 光把选项禁用还不够：默认协议由 `defaultProtocolForCapability()` 决定，它原先只看 `enabled`。新增 `selectableProtocol()`（`enabled` 且未撤下）用于默认选择、协议分组和设置页的兜底选择，而按值查名称/请求信息的路径不变，所以旧配置保存的协议不会被改写。
- **兜底也必须遵守撤下限制**：目录里有这个能力、但可选协议全是撤下的，函数返回 `undefined`，新模型保持“待配置”，由设置页让用户自己选；绝不退回内置协议表（`FALLBACK_PROTOCOLS`）。只有目录完全为空（宿主没有撤下信息）时才用内置表，避免目录不可用时把新建连接堵死。受此影响，`defaultProtocolForCapability`/`defaultProtocolForModel`/`beefApiVideoProtocol` 的返回类型都放宽为可空，调用方按“未配置”处理。
- **“待配置”要能被下游认出来**：只让函数返回 `undefined` 不够——模型列表编辑（`ensureModelProfilesWithUiDefaults`，调用时不带目录）和提交请求（`resolveModelRequestConfig`，只读本地配置）都会再调一次默认选择，把 `openai-image` 补回去。所以撤下的能力会被记成 profile 上的 `protocolPending: true`：
  - 它和“缺 `protocol` 字段”是不同状态——后者是老配置的写法，语义仍是“用文档里的默认值”（`explicit capability is kept when protocol is missing` 这个既有用例依赖它，不能改）；
  - `ensureModelProfilesWithUiDefaults` 见到它就原样保留，不再重新推导；
  - `resolveModelRequestConfig` 见到它就不补默认协议，请求保持未配置；
  - 用户之后自己选了协议，这个标记随新 profile 一起消失。

插件中心里针对撤下插件的文案标签属于下一步（`P1-B 精简默认目录`），本步不加界面元素。

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
| 升级改查询路径时有未取回任务 → 保留旧定义 | `TestDeferredUpgradeKeepsTheOldQueryDefinition` |
| 任务结束后下一次启动采用新版本 | `TestUpgradeAdoptsNewDefinitionOnceWorkIsDone` |
| 只有已保存连接时不冻结升级 | `TestSavedConnectionAloneNeverFreezesAnUpgrade` |
| 盘点失败时升级同名包 → 保留已安装定义 | `TestFailedAuditDefersUpgradeOfShippedPlugin` |
| 盘点失败但包没变 → 照常采用，不误报推迟 | `TestFailedAuditStillAdoptsAnUnchangedPackage` |
| 盘点失败但插件尚未安装 → 照常安装 | `TestFailedAuditStillInstallsNewShippedPlugin` |
| 安装 / 启停 / 卸载后撤下标记仍在 | `TestRetentionSurvivesUnrelatedPluginChanges` |
| 仅剩备份时仍能盘点；两个文件都没有才是空 | `TestSavedProtocolReferencesReadsRecoverableBackup`、`TestSavedProtocolReferencesWithoutBothFilesIsEmpty` |
| 任务协议取自 `config.interfaceType`（真实入参形状） | `TestTaskProviderReferencesResolvesTheDispatchedProtocol`、`TestTaskProtocolsReadsTheDispatchedProtocol`、`TestInputProtocolIgnoresCredentials` |
| 前端：撤下协议可解析、不可新选 | `web/test/plugin-catalog-retired.test.tsx` |
| 前端：新模型不会默认选中撤下协议 | 同上，`a retired protocol never becomes the default of a new model` |
| 前端：没有可选协议时保持待配置，不退回内置表 | 同上，`with no selectable protocol a new model stays unconfigured` |
| 前端：待配置状态经模型列表编辑与提交请求后仍保留 | 同上，`the unconfigured state survives saving the model list and submitting a task` |

## 证据限度

- 全部用本地合成配置和测试数据验证，没有读取任何真实用户凭证，没有发起任何生成请求，也没有连接任何厂商接口。
- 数据库相关用例需要 CGO（`go-sqlite3`）。本轮云端容器没有 C 编译器，`TestTaskProviderReferencesResolvesTheDispatchedProtocol`、`TestChannelModelProtocolReferencesIgnoresRemovedRows` 与既有 16 个 SQLite 用例一样无法在此执行；协议解析规则另有不依赖数据库的 `TestTaskProtocolsReadsTheDispatchedProtocol` 覆盖，最终仍以 Mac 工作区或 CI 的 `go test ./...` 为准。
- 本步不评估厂商是否停服，也不判断某个协议是否还有真实可用性；它只回答“这份配置和这些任务还需不需要这个插件”。
- 只防将来：旧版本已经删掉的官方插件记录不会因为这次改动回来——它们的清单已不在 registry 里，无法凭空重建执行定义。这类用户的配置会显示协议未知，需要另行判断是否重新安装包含该包的版本。
