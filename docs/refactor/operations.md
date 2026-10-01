# 操作层切片：产品中立 operations API

Agent 操作层抽成工作区共用的 `operations` 核。手工 UI、内置助手、外部 CLI/MCP 走同一套注册表、幂等键、调用方身份和事务回执。`agentops` 只保留本机凭据与助手范围适配。

## 依赖方向

`handler` / `cmd/beeftv` → `agentops`（鉴权适配）→ `operations`（核）→ `canvas` / `model`

`app.Service` 通过 `BindDomain` 实现 `operations.DomainBinder`，是薄适配，操作核不再 import `internal/app`。

`Domain` 方法不接受 `*gorm.DB`。事务绑定只出现在 `DomainBinder.BindDomain(tx)` 与 `Store` 内部。

## 公共 API（供后续手工 UI 接入）

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
| `ManualCaller(readOnly)` | `manual` | 9 项，写操作 schema 带必填 `operationId` |
| `ExternalCaller(readOnly)` | `external` | 同上 |
| `AssistantCaller(scope, readOnly)` | `assistant` | 7 项（无 `asset.list` / `canvas.search`）；写操作 schema 不暴露 `operationId` |

`Caller.Scope` 是 `Authorizer`（`Visible` / `Allows`）。空指针不能赋给该接口，否则会变成带类型的 nil，能力发现会被收成助手集合。

### 结果信封

`Result`：`op`、`opId`、`replayed`、`result`、`revision`、`caller`。

`Receipt()` 给手工 UI / 助手结算用。存储仍写既有 `agent_op_records`，不另起一份。

### 操作目录

只读：`canvas.get`、`canvas.search`、`asset.list`、`asset.get`、`task.get`、`canvas.generation.propose`

写入：`canvas.node.update`、`canvas.nodes.create`、`canvas.edge.create`

`canvas.generation.propose` 只登记提议，不生成、不扣费；禁止携带 `opId`。

### HTTP

`GET /api/ops` 与 `POST /api/ops/:op` 仍是本机入口。响应多一个 `caller` 字段（`manual` / `assistant` / `external`）。外部 CLI/MCP 的 operationId 语义不变：写操作必须提供稳定幂等键，重试复用，不同 payload 冲突。授权发生在回放之前。

## 仍由其他切片拥有

前端接入、任务 worker/provider、数据库迁移、model schema、Agent 宿主生命周期。
