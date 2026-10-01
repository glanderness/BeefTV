# 创作执行领域

状态：结构化 CreationRun 执行算法已迁入 `internal/creation`。pi 会话、AssistantTurn、`/create` 对话存储仍由其他切片拥有。本文记录当前真实依赖，不是完整重构完成证明。

## 边界

- 新包：`backend/internal/creation`
- 拥有：创作租约/代次/动作状态机、方案快照与 hash 校验、quote/confirm/submit 幂等、画布 mutation-diff 与受控写入事务
- 不拥有：pi Session、SQLite 业务轮次、`/create` 对话 CAS、任务准入/生命周期、画布规范事务协议、handler 路由
- 现行 UI `ApprovedToolExecution` 与分镜路径继续走本领域；它们不是已退场的旧 Agent
- 本包不得 import `internal/app`

## 实际依赖图

```
HTTP handler
  └─ app.Service 兼容方法（JSON 载荷暂留）
        └─ app.creationDomain() → internal/creation.Service

internal/creation.Service
  ├─ repository.Repository（CreationRun 行锁事务、submission、canvas、config signature）
  ├─ canvas.SaveDocumentWithHistory / ValidateSyncedPayload / capability.BuiltinRegistry
  ├─ modelcatalog.DecodeModelCapabilityConfig（文本参考图容量）
  ├─ assets.DocumentReferences（结果回写素材归属）
  └─ typed ports（app 适配，无 Service 回调方法袋）
        ├─ Tasks.Prepare  当前 CreateTask + creationPrepare 标记
        ├─ Tasks.Admit    createTaskWithStorageQuotaRepository
        ├─ Secrets.Protect
        ├─ Quota.ValidateRun / ValidateCanvas
        ├─ Media.ValidateDocument
        └─ TaskKinds.UsesWorkflow / UsesTextReplay
```

禁止方向：`internal/creation` 不得 import `internal/app`。

## 领域已拥有的行为

- 按 `clientKey` 幂等创建 CreationRun，内容 hash 冲突拒绝
- claim / heartbeat / release：45 秒租约，epoch CAS，旧 owner 不能续约或释放新租约
- save：revision CAS；`state.approved` 不能当作方案确认
- proposal-approve / invalidate：方案 hash、操作白名单、画布基线快照；同版本同 hash 重放不升 revision
- 确认 owner 拒绝 `model` / `assistant` / `agent` 等模型身份，确认不可由模型自授
- Prepare（quote）：创作任务约束、受管模型、协议占位校验；不落生成任务
- Approve：确认前再次核对执行配置指纹；lease + 方案 hash 保护
- Execute：同一 submission 回放同一 task；未知准入回执写入 ExecutionJSON 后不再发起新的付费准入
- 画布创建稳定幂等；提交按 snapshot hash 与批准 diff 校验；手工后续编辑不被批准补丁覆盖
- 结果回写只允许绑定到本 run 已成功任务的真实资源

## 任务准备缝（Lead 后续接线）

本工作树的 `task.CreateRequest` 尚无 `PrepareOnly` / `AdmissionID`。25ddcbf 已在任务准入切片加入这两个 `json:"-"` 字段，并计划替换 `CreateTaskRequest.creationPrepare`。

当前 adapter：

```go
taskReq.creationPrepare = &creationTaskPreparation{}
task, err := s.CreateTask(userID, taskReq)
```

领域 `TaskRequest.PrepareOnly` / `AdmissionID` 已预留。合入准入切片时只改 `creation_domain.go` 的 `fromCreationTaskRequest` / `Prepare`，把标记映射到 `task.CreateRequest.PrepareOnly`。不要从本切片 cherry-pick `task_creation.go` / `task/lifecycle.go` / `task/service.go`。

## 仍留在 app 的残余

| 残余 | 位置 | 原因 |
| --- | --- | --- |
| `CreationRequest` + `CreateTaskRequest` | `app/creation.go` | handler JSON 仍绑定 app 类型 |
| `creationTaskPreparation` | `app/creation.go` + `service.go` | 现有 CreateTask 私有 quote 标记；`service.go` 不在本切片写入范围 |
| Tasks/Secrets/Quota/Media/Kinds 适配 | `app/creation_domain.go` | 跨域组合：目录选型、密钥、配额、画布媒体、工作流识别 |
| `resolveAgentResourcePlaceholders` 包装 | `app/creation_agent_references.go` | `provider.go` 出站水合仍调用 app 函数 |
| `taskForOutput` | Execute 返回路径 | 任务读模型投影仍在 app |

## 未改

- schema / 数据历史
- handler / bootstrap / runtime / local_kernel / `app/service.go`
- `task_creation.go` 及任务准入/生命周期
- canvas service 与 operations 公共协议（只调用既有 `SaveDocumentWithHistory`）
- 前端、`ApprovedToolExecution`、分镜 UI

## 验证

领域与 app 创作测试使用临时 SQLite，不打真实上游。未知回执路径用 Tasks.Admit mock。完整重构未完成。
