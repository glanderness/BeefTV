# 协议插件域拆分

本切片把协议插件的 registry、包校验、安装/卸载、并发缓存和启用合同从 `internal/app` 抽到 `internal/plugins`。`app.Service` 只保留可见委托、管理员鉴权和审计。这不是完整产品重构。

## 边界

- 域入口：`backend/internal/plugins`
- 运行时所有者：`plugins.Runtime`（`plugin_registry.json`、包文件、官方包缓存、`protocol.Registry` 快照、mutation 锁）
- 管理合同所有者：`plugins.Service`（官方应用策略、用户/平台可用性、工作流启用）
- `internal/app` 适配：类型别名、`pluginRuntime` 包装、`pluginDomain()` 委托
- 官方声明式包身份、上传自定义渠道/插件能力保持不变
- 本切片不改上游 wire payload、媒体尺寸策略、协议包 ID

## 调用方迁移

新代码应依赖 `internal/plugins` 的导出类型与 `plugins.Service`。`app` 上的 `PluginView` / `InstallPlugin` / `PluginStatesForUser` 等是过渡别名和委托，不要在这里补第二份实现。

仍留在 `app` 的原因：管理员鉴权、`appendAdminAudit`、`FeatureEnabled`（系统插件对普通用户可见性）、`PluginProviderCatalog` 以及生成路径对 `protocolRegistry()` 的读取。

## 下一阶段仍在 app 的依赖

- `PluginProviderCatalog` / `protocolRegistry` / `canonicalProtocolID`：生成与渠道设置仍从 `app.Service` 读 registry
- `PluginsForUser`：功能开关 `FeatureSystemPlugins` 仍在 app/platform
- HTTP handler、`RequireAdmin`、管理员审计
- `generation.OfficialPluginPackageDir` 与 `LoadOfficialFallbackRegistry`：官方包目录和启动回退 registry 仍在 generation，plugins 只调用目录解析
- 前端内置应用插件（Eagle、审美批改、编辑器壳等）本身仍不由协议 runtime 装载，只走管理策略
- bootstrap / localapp 仍通过 `app.NewLocal` 构造 runtime，本切片未改组合根

## 合同收紧

安装/启用/卸载在 reload 失败时回写 registry。新上传在平台状态保存失败时卸载该新插件；覆盖已有自定义插件时不卸载旧版本。
