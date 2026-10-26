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
| 生成任务 `tasks` | `repository.TaskProviderReferences()` | 排队/运行中的任务；已持有上游任务 ID 的失败任务（结果恢复还要查同一协议）；上游取消仍在进行中的已取消任务 |

不计数的情况：已完成任务、提交前就失败的（没有上游任务 ID）、上游取消已确认的任务、文本回放容器。

匹配用的是**协议 ID**而不是包 ID。例如 `openai-videos` 这个包对外提供的 provider ID 是 `newapi`，用户配置和任务里保存的都是 `newapi`，所以 `recordProviderIDs` 会把包 ID 和它声明的每个 provider ID 都纳入匹配。

`interfaceType` 也计入，因为更早的连接把协议存在渠道级字段上，没有逐模型 profile。

## 失败与保守策略

- 盘点读不到（配置损坏、数据库不可用）时，这一轮**保留全部**未随包发行的官方插件，理由写“插件引用盘点失败，已按保守策略保留该协议”。宁可多留一个插件，也不因为读不到配置而删掉用户正在用的协议。
- 没有接入盘点来源的运行时（例如只用文件 registry 的独立测试壳）保持原来的删除行为，避免把“未知”误当成“有人引用”。

## 与现有机制的关系

- **registry**：保留的记录原样留在已提交的 registry 里，清单字节不变（`TestRetentionIsDerivedAndNeverPersisted`），因此不会因为一次启动产生无谓写入。
- **启用状态**：用户手动停用的插件保留停用，不会被这一版重新启用（`TestRetainsDisabledOfficialPluginWithoutReenablingIt`）。
- **配置 revision 与备份**：本步不改写任何配置。本地配置只被解码读取，revision、备份文件、用户手改的字段都保持原样。
- **升级与回退**：发行包重新包含该插件后，记录照常由包刷新版本，撤下标记随之消失，用户停用状态保留（`TestUpgradeKeepsUserDisabledStateAndRetiresNothing`、`TestRollbackShipsPackageAgainAndClearsRetirement`）。
- **缺包**：包文件丢失不影响执行，因为适配器由已提交的清单生成；只有“重新下载插件包”会报自己的错误（`TestRetainsOfficialPluginWhosePackageFileIsMissing`）。

## 对外投影

- 插件中心接口 `View` 增加可选 `retention: {retired, reasons, unknown}`，说明为什么这个已撤下的插件还在。
- 协议目录接口 `ProviderCatalogItem` 增加 `retired` 与 `retiredReason`。
- 前端 `plugin-catalog.ts` 把这些标记带进 `ModelProtocolDefinition`。撤下的协议仍留在协议列表里，所以老模型照常显示自己保存的协议名称和请求信息；`ModelProtocolBrowser` 只是把它的选项置为不可选中，避免给新模型误选一个已经撤下的协议。

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
| 前端：撤下协议可解析、不可新选 | `web/test/plugin-catalog-retired.test.ts` |

## 证据限度

- 全部用本地合成配置和测试数据验证，没有读取任何真实用户凭证，没有发起任何生成请求，也没有连接任何厂商接口。
- 数据库相关用例需要 CGO（`go-sqlite3`）。本轮云端容器没有 C 编译器，`backend/internal/repository/provider_references_test.go` 与既有 16 个 SQLite 用例一样无法在此执行；其中取数条件另外用等价 SQL 在 SQLite 上核对了结果集，最终执行以 Mac 工作区或 CI 的 `go test ./...` 为准。
- 本步不评估厂商是否停服，也不判断某个协议是否还有真实可用性；它只回答“这份配置和这些任务还需不需要这个插件”。
- 只防将来：旧版本已经删掉的官方插件记录不会因为这次改动回来——它们的清单已不在 registry 里，无法凭空重建执行定义。这类用户的配置会显示协议未知，需要另行判断是否重新安装包含该包的版本。
