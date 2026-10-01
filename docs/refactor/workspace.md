# 工作区切片：配置、身份、备份 helper

本页是 Lead 接线备忘，不是产品备份验收，也不是完整重构完成声明。

## ProviderConfig

- 实现：`backend/internal/workspace/provider_config.go`
- 同一工作区数据目录的多个 `NewProviderConfig` 句柄共享一把进程内互斥锁；锁键是 canonical 绝对路径（含已存在前缀的符号链接解析）。
- 现有调用方不必再加锁。`app.Read/SaveLocalModelConfig` 每次仍会新建句柄，CAS 与脱敏密钥保留不再跨句柄竞态。
- 无关工作区互不阻塞。
- 读路径看到的是 rename 之后的完整文档/revision。写路径只接受当前主文件；主文件损坏时 `SaveLocalModelConfig` / `SaveLocalModelConfigRevision` 失败，不覆盖、不凭备份恢复后替换。
- 损坏主文件时读路径仍可从 `.bak` 恢复展示。这不能当作写成功。

Lead 接线：组合根继续持有一个 `*workspace.ProviderConfig` 作为 `localapp.ProviderConfigPort`。不必改调用方加锁。

## 身份

- 实际规则：`workspace.Service` + `workspace.Repository`
- `WorkspaceOwner(id) (*model.User, error)` 与 `localapp.WorkspacePort` 方法集对齐
- `LocalPrincipal`：`username=local`，`role=admin`，`status=active`，ID/姓名/时间来自 `model.Workspace`
- 不是通用用户/管理系统
- `app/local_identity.go` 只保留 `AuthUser` JSON 和薄封装；`Service.WorkspaceIdentity()` 返回领域服务

Lead 根切示例（本切片不改 bootstrap）：

```go
localapp.Options{
    Workspace: workspace.NewService(repo),
}
```

`repository.Repository` 已满足 `workspace.Repository`。不要为了身份去改 schema。

## 备份 helper

`workspace.Backup` / `workspace.Restore` 在本仓库没有生产调用方。桌面 ZIP 导入导出属于剪辑/画布/素材前端：

- `web/src/lib/canvas/canvas-export.ts`
- `web/src/pages/canvas/index.tsx` 画布 ZIP 导入
- `web/src/pages/assets/asset-transfer.ts`

缺失的生产缝：没有任何 HTTP/CLI/Wails/bootstrap 路径调用这个 tar.gz helper。本切片只修 helper 自身的归档完整性，不新增第二条备份 UX 或 CLI。

helper 现约束：拒绝来源目录内的归档（避免自包含）、错误路径关闭 reader、发布前读完 gzip 校验、发布时目标已存在则拒绝、拒绝越界路径/符号链接/特殊文件。
