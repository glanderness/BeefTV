# 切片：模型目录 / 能力合同 / 渠道配置抽到 `modelcatalog`

把渠道模型能力归一化、校验、目录脱敏、SKU/变体合同和助手渠道选择从 `internal/app` 抽到 `backend/internal/modelcatalog`。UI、Agent 与普通生成走同一套规则。本包不得 import `internal/app`。

## 边界

- 新包：`backend/internal/modelcatalog`
- 能力类型、`CapabilitySpec`、`ModelRequestIntent`、公开渠道目录投影、渠道模型配置 DTO 以本包为权威来源；`app` 用类型别名保留既有 JSON 字段名
- 协议插件仍由插件 worker 拥有。本包只注入 `ProtocolLookup`（`LookupFromRegistry` 适配 `protocol.Registry.Resolve`，只读 ID / Enabled / UnavailableReason / Categories[0]）
- 仓储不反向 import。`ChannelModelLookup` 由 `Service.channelModelLookup` 接到 `repo.ChannelModelByKey`
- 授权仍在 Service 边界：`RequireAdmin`、登录校验、资源归属检查留在 `app`
- 未改：`protocol_plugins.go` / `protocol_registry.go` / `plugin_management.go` / `workflow_plugins.go` / `internal/plugins`；生成任务投递/恢复/生命周期；`provider.go` 出站编排与媒体水合；前端；`project` / `localapp`

## 实际算法已搬家

- 能力默认值、归一化、配置校验、`CapabilitySpecFromModelCapabilityConfig`
- 任务能力校验（图片/视频/参考素材/单档位分辨率钉死）、Seedance 2.x 官方 overlay 与像素下限
- `MatchCapability`、意图推导、SKU 选择器、变体匹配
- 公开系统渠道目录脱敏与 intent 过滤（损坏能力 JSON 读路径隔离，写路径失败关闭）
- 渠道合同、变体规格、上游键级联重命名、协议别名经 `ProtocolLookup`
- 前台产品规格覆盖校验、渠道规格投影、默认参数
- 助手渠道/协议选择（`assistant.Provider` 合同不变；BeefAPI 托管密钥由 app 注入）

`app` 只保留：HTTP/仓储/功能开关、工作流 provider 分支、路由目录缓存与 route attempt 生命周期、上游目录拉取、插件目录扩展、`TestAdminChannelModel` 真实探测。

## 调用图（现状）

```
HTTP 目录
  handler -> Service.ModelCatalog
    FeatureFrontendModels
      开：PublicLogicalModels（app 列表 + MatchCapability 领域）
      关：repo.SystemChannels/ChannelModels -> modelcatalog.PublicSystemChannelCatalog

渠道保存
  RequireAdmin -> NormalizeChannelModelContract(lookup)
               -> NormalizeChannelModelVariants
               -> CascadeUpstreamRename
               -> NormalizeModelCapabilityConfigForModel
               -> repo.SaveChannelModelWithVariants

任务准入
  Service.ValidateTaskCapability
    工作流接口：app validateWorkflowProvider*
    其余：modelcatalog.ValidateConfiguredTask + ChannelModelByKey

助手
  Service.assistantConfig（读本地快照）
  -> modelcatalog.ResolveAssistantProvider
       ManagedCredentialLookup = BeefAPI 托管渠道查密钥（app）
  -> assistant.Provider / UnavailableError
```

生成执行仍从 `task_creation` / `provider.go` 进入；能力校验与 MatchCapability 已指向领域实现。`generation.ModelCapabilityConfig` 仍是生成包内的重复类型，尚未切换。

## 剩余 provider / transport 边界

- `provider.go` 仍拥有 `canvasGenerationInput` / `providerConfig` / `providerMedia`、出站 HTTP、媒体水合、`withSystemPrompt`。领域校验经 `taskInputFromCanvas` 显式拷贝字段；Grok 图片提示词字节由适配器先算 `ComposedPromptBytes`
- `normalizeVideoResolution` 的权威实现在领域；`provider_video.go` 出站仍走 app 包装
- `FetchChannelModelCatalog` HTTP 与 `extendChannelModelCatalog` 插件合并仍在 app
- `ResolveLogicalModel`、route attempt 持久化/切换、健康封锁仍在 app（生成 worker）
- 前台逻辑模型 CRUD / `PublicLogicalModels` 列表组装仍在 app，规则函数已委托
- 本地 `local_channel_models.go` / `local_model_config.go` 仍是桌面快照 I/O
- 未猜测新的上游限制，未改 pi 版本

## 验证

插件包缺失会导致 `请选择有效的模型请求协议`；这是夹具，不是本切片回归。先构建：

```bash
./plugin-packages/build-packages.sh
cd backend
go test ./internal/modelcatalog -count=1
go test ./internal/app -count=1 -timeout 180s \
  -run 'TestNormalizeChannelModelContract|TestSaveAdminChannelModel|TestSanitizeChannelModel|TestChannelModelMatchesIntent|TestMatchCapability|TestCapabilitySpec|TestValidateTaskCapability|TestResolveAssistant|TestValidateVideoTask|TestValidateImageTask|TestSKUSelector|TestModelRequestIntent'
```

本切片实测：`go test ./internal/modelcatalog -count=1` 通过；构建协议包后 105 个既有 model/capability/channel/assistant 测试通过。零付费上游调用，无真实 App/DB/GUI。

## 未做

- 生成包能力类型去重并改为 import `modelcatalog`
- 路由尝试生命周期迁出 app
- 上游目录 HTTP / provider 插件扩展迁出
- `provider.go` 出站与媒体编排
- 前端目录 UI
