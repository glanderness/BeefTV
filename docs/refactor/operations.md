# 操作层切片：产品中立 operations API

Agent 操作层抽成工作区共用的 `operations` 核：注册表、幂等键、调用方身份和事务回执。当前已接入内置助手、CLI/MCP，以及桌面手工 UI 的正常保存（`canvas.document.commit`）。初次创建/导入仍走独立 PUT；生成结果提交仍走 `PUT /canvas-projects/:id/generated-assets`，待交付切片接入。`agentops` 只保留本机凭据与助手范围适配。

## 依赖方向

`handler` / `cmd/beeftv` → `agentops`（鉴权适配）→ `operations`（核）→ `canvas` / `model`

`app.Service` 通过 `BindDomain` 实现 `operations.DomainBinder`，是薄适配，操作核不再 import `internal/app`。

`Domain` 方法不接受 `*gorm.DB`。事务绑定只出现在 `DomainBinder.BindDomain(tx)` 与 `Store` 内部。

## 公共 API

```go
registry := operations.NewRegistry(binder, store) // binder 通常是 *app.Service
operations.RegisterDefaultOps(registry)

result, err := registry.Execute(operations.Request{
    Context: ctx,
    Op:      "canvas.nodes.create",
    OpID:    operationID, // 写操作必填；只读操作禁止
    UserID:  userID,
    Caller:  operations.ManualCaller(false), // 或 AssistantCaller / ExternalCaller
    Params:  params,                         // JSON；也可把 operationId 放在 params 里
    TurnID:  "",                             // 仅内置助手回合填写
})

receipt := result.Receipt(turnID)
listed := registry.List(operations.ManualCaller(false))
```

### 调用方

| 构造 | Kind | 能力发现 |
| --- | --- | --- |
| `ManualCaller(readOnly)` | `manual` | 10 项，写操作 schema 带必填 `operationId` |
| `ExternalCaller(readOnly)` | `external` | 同上 |
| `AssistantCaller(scope, readOnly)` | `assistant` | 7 项（无 `asset.list` / `canvas.search` / `canvas.document.commit`）；写操作 schema 不暴露 `operationId` |

`Caller.Scope` 是 `Authorizer`（`Visible` / `Allows`）。空指针不能赋给该接口，否则会变成带类型的 nil。手工/外部调用方遇到带类型的空范围时仍发现完整 10 项。显式 `assistant` 且没有活范围时，能力发现为空、执行拒绝；宿主在回合外应传入空的 `AssistantScope` 适配器，才能发现 7 项且执行全部拒绝。未知 `Kind` 失败关闭。桌面 React 没有 owner token：操作入口用 `RuntimeDependencies.DesktopTrust` 加 loopback/同源识别受信任手工 UI，记为 `caller=manual`。未授信的 loopback 客户端没有整页写权限。

### 结果信封

`Result`：`op`、`opId`、`replayed`、`result`、`revision`、`caller`。

`Receipt()` 给手工 UI / 助手结算用。存储仍写既有 `agent_op_records`，不另起一份。

### 操作目录

只读：`canvas.get`、`canvas.search`、`asset.list`、`asset.get`、`task.get`、`canvas.generation.propose`

写入：`canvas.node.update`、`canvas.nodes.create`、`canvas.edge.create`、`canvas.document.commit`

`canvas.document.commit` 是顶层文档覆盖，必须带 `expectedRevision` 与稳定 `operationId`，在回执事务里校验并应用到当前画布。不创建画布，不接受任意数据库补丁语言。未触及的顶层字段、ID、资源引用校验、CAS 与回执原子性保持不变。助手范围默认拒绝该操作。

`canvas.generation.propose` 只登记提议，不生成、不扣费；禁止携带 `opId`。

### HTTP

`GET /api/ops` 与 `POST /api/ops/:op` 仍是本机入口。响应多一个 `caller` 字段（`manual` / `assistant` / `external`）。外部 CLI/MCP 的 operationId 语义不变：写操作必须提供稳定幂等键，重试复用，不同 payload 冲突。授权发生在回放之前。

## 仍由其他切片拥有

任务 worker/provider、数据库迁移、model schema、Agent 宿主生命周期、画布 UI 页面（`project.tsx`）、助手侧栏、时间线/合并/导出库。

生成结果提交仍走 `PUT /canvas-projects/:id/generated-assets`，待交付切片接入。`project.tsx` / 媒体工具仍通过 `syncLocalCanvasSnapshot` 调仓库；该桥接已改为同一条 `canvas.document.commit`，页面文件本身未改。

## 回合与写入事务

`internal/assistantturns` 的 schema v10 保存业务轮次；旧 JSON 只作为历史导入来源。官方 pi 的模型会话仍由 SDK `SessionManager` 保存。

`operations.Store.Run` 在插入回执后、执行业务写入前调用 `TurnGuard.VerifyOpenAssistantTurnInTx(tx, userID, turnID, canvasID)`，在同一事务验证轮次归属、画布和开放状态。非空 `TurnID` 缺少 guard 时失败关闭；校验失败同时回滚回执和业务写入。手工 UI / CLI / MCP 的空 `TurnID` 不归入助手轮次。授权先于回执重放；重放不会把已提交操作重新归入另一个轮次。
