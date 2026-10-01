# 项目领域抽取

状态：项目聚合（身份、归属、修订、文件夹、章节、画布关联）已迁入 `internal/project`。素材卡片、工作流步骤机和生成任务仍由 `app` 提供协作实现。本文记录当前真实依赖，不是完成证明。

## 实际依赖图

```
HTTP handler
  ├─ localapp.ProjectPort.ListProjects        → internal/project.Service
  └─ app.Service 其余项目路由（兼容委托）
        └─ app.Service.projectDomain()        → internal/project.Service

internal/project.Service
  ├─ repository.Repository（项目/文件夹/章节/画布关系/封面资源/活跃任务计数）
  ├─ model
  ├─ kernel（结构化校验错误与 ID）
  ├─ prompts.ValidateStyleProfileJSON / ValidateStyleProfilePreset
  └─ Workflows 端口（app.projectWorkflowHost）
        ├─ EnsureBuiltinProjectWorkflowTemplate
        └─ createProjectWorkflow(projectID, "", "project")

internal/localapp.ProjectPort
  └─ []project.Summary（不再引用 app 类型）

bootstrap.Open
  └─ svc.ProjectService() 作为 localapp.Projects
     LocalKernel 不再转发 ListProjects
```

禁止方向：`internal/project` 与 `internal/localapp` 不得 import `internal/app`，包括经类型传递的间接依赖。

## 领域已拥有的行为

- 项目列表/分页摘要，列表入口拒绝缺少 ID 或 `revision < 1` 的记录
- 创建/更新/删除项目，更新时递增 revision，封面必须是当前用户已就绪的图片
- 文件夹创建与项目搬家（目标夹必须属于同一用户；空 folderId 表示移出）
- 复制项目：新身份、名称加「副本」、revision 归 1，章节正文与父子关系一并复制
- 章节创建/读取/更新/导入/排序/删除，并 bump 项目 revision
- 画布-章节关联、解除章节关联、解除项目关系；解除时删除 payload 中的 `projectId`，保留其余未知字段
- 删除项目：进行中任务拒绝；画布脱离项目并改写 payload；项目侧生产行删除；账号素材库与画布任务保留
- 归档项目不能再改生产数据，也不能作为生成任务的业务项目
- 工作台 core/overview/unit summaries/canvas page 的仓储读取

## 仍留在 app 的残余

这些实现与生成任务、角色版本修复或素材卡片装配缠在一起，尚未迁出。项目领域通过一次归属校验或 `Inspect` 快照接入，不复制规则。

| 残余 | 位置 | 原因 |
| --- | --- | --- |
| `ProjectDetail` 装配 | `app/project.go` | 需要 `ProjectAssetSummary`、`ProjectWorkflowDetail`、`TaskSummary` |
| 读取时角色三视图补偿、工作流产物补登记 | `app/project.go` `ProjectDetail` / `ProjectCore` | 依赖任务结果与角色版本写入 |
| 项目素材链接/版本/候选/目录 | `app/project_asset.go`、`project_asset_folder.go` | 素材库身份、引用与生成结果绑定 |
| 角色与声音 | `app/project_character.go` | 角色版本、试听资源、任务回写 |
| 镜头与候选资产 | `app/project_shot.go` | 分镜修订与资产引用 |
| 工作流步骤机与产物登记 | `app/project_workflow.go` | 模板、步骤状态、任务输出 |
| `ProjectUnitWorkspace` 与素材分页 | `app/project_workbench_read.go` | 装配素材卡片、工作流与任务 |

`Workflows` 是项目拥有的窄端口，不是把整个 `app.Service` 或 GORM 查询暴露给领域。创建项目失败时仍按原规则回滚项目行。

## 兼容委托

`app` 的原方法名全部改为一次转发到 `internal/project`，HTTP JSON 字段不变。handler 在组合根迁移完成前可以继续调用 `app.Service`。`ProjectDetail` 是唯一仍在 app 编排的聚合读取：先做任务侧补偿，再 `Inspect`，再补素材/工作流/任务卡片。
