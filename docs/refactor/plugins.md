# 协议插件域拆分

本切片把协议插件的 registry、包校验、安装/卸载、并发缓存和启用合同从 `internal/app` 抽到 `internal/plugins`。`app.Service` 只保留可见委托、管理员鉴权和审计。这不是完整产品重构。

## 边界

- 域入口：`backend/internal/plugins`
- 生产权威：SQLite `SystemSetting` 键 `plugin_registry` 保存已提交的 registry 记录。平台可用性与卸载时的用户状态删除走同一条 `Store.CommitPluginRegistry` 事务。
- 包字节：内容哈希寻址的文件系统 blob，先写入并 fsync，再提交数据库。
- 内存：事务成功后才把已物化的 `plugins` / `protocol.Registry` 指针发布到 live；发布本身不再做会失败的 IO。
- 旧 `plugin_registry.json`：一次性导入源。导入后不再用磁盘覆盖数据库。文件损坏时失败并保留字节。
- 独立文件模式：`plugins.NewRuntime` 仍可供测试使用。生产 `app.newService` 在暴露适配器前绑定 Store。
- `internal/app` 适配：类型别名、`pluginRuntime` 包装、`pluginDomain()` 委托
- 官方声明式包身份、上传自定义渠道/插件能力保持不变
- 本切片不改上游 wire payload、媒体尺寸策略、协议包 ID

## 生产调用图

`HTTP handler` → `app.Service`（鉴权/审计）→ `pluginDomain()` → `plugins.Service`（策略）→ `plugins.Runtime`（在 `mutationMu` 下 stage blob、`CommitPluginRegistry`、publishLive）。`app.newService` 用 `plugins.NewRuntimeWithStore(dataDir, plugins.NewRepositoryStore(repo))` 构造 runtime。

## 调用方迁移

新代码应依赖 `internal/plugins` 的导出类型与 `plugins.Service`。`app` 上的 `PluginView` / `InstallPlugin` / `PluginStatesForUser` 等是过渡别名和委托，不要在这里补第二份实现。

仍留在 `app` 的原因：管理员鉴权、`appendAdminAudit`、`FeatureEnabled`（系统插件对普通用户可见性）、`PluginProviderCatalog` 以及生成路径对 `protocolRegistry()` 的读取。

## 下一阶段仍在 app 的依赖

- `PluginProviderCatalog` / `protocolRegistry` / `canonicalProtocolID`：生成与渠道设置仍从 `app.Service` 读 registry
- `PluginsForUser`：功能开关 `FeatureSystemPlugins` 仍在 app/platform
- HTTP handler、`RequireAdmin`、管理员审计
- `generation.OfficialPluginPackageDir` 与 `LoadOfficialFallbackRegistry`：官方包目录和启动回退 registry 仍在 generation，plugins 只调用目录解析
- 前端内置应用插件（Eagle、审美批改、编辑器壳等）本身仍不由协议 runtime 装载，只走管理策略
- bootstrap / localapp 仍通过 `app.NewLocal` 构造 runtime；本切片只把生产初始化绑到 Store

## 合同收紧

`Runtime.mutationMu` 覆盖 registry 提交和平台/用户状态持久化。宿主每次调用都会新建 `plugins.Service`，生命周期锁必须落在持久 `Runtime` 上。`SetUserEnabled` 与卸载共用这把锁。

上传安装、系统插件启用、卸载都先把包字节落到磁盘，再在一条事务里提交 registry 与平台状态（卸载同时删除用户/平台状态），成功后才发布 live。未提交的 blob 可以暂时孤儿存在，不得删除 live 或已提交记录仍引用的包。

读不了权威数据库或遗留 registry 格式损坏时失败关闭，不返回空成功。

`List` 按 JSON 契约拷贝 metadata。拷贝失败返回不含原 map 的安全视图，不把可变别名交给调用方。
