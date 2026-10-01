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
  ├─ repository/project_mutate.go（同一事务内的聚合写入）
  ├─ model
  ├─ kernel（结构化校验错误与 ID）
  ├─ prompts.ValidateStyleProfileJSON / ValidateStyleProfilePreset
  └─ Workflows 端口（app.projectWorkflowHost）
        ├─ EnsureBuiltinTemplate（全局模板，项目行之外）
        └─ PrepareDefault（只准备记录，不写库）

internal/localapp.ProjectPort
  └─ []project.Summary（不再引用 app 类型）

bootstrap.Open
  └─ svc.ProjectService() 作为 localapp.Projects
     LocalKernel 不再转发 ListProjects
```

禁止方向：`internal/project` 与 `internal/localapp` 不得 import `internal/app`，包括经类型传递的间接依赖。

## 领域已拥有的行为

- 项目列表/分页摘要，列表入口拒绝缺少 ID 或 `revision < 1` 的记录
- 创建项目：项目行、默认工作流实例/步骤、revision bump 在同一事务；`PrepareDefault` 失败则不落项目行
- 更新项目：按读取到的 revision 做内部 CAS；冲突返回 409。请求 JSON 仍无 `expectedRevision`（前端当前不传）
- 删除项目：进行中任务拒绝；画布脱离项目并改写 payload；项目侧生产行删除；账号素材库与画布任务保留
- 文件夹：父夹必须是当前用户已有记录，空 parentId 为根；搬家时原子递增 revision
- 复制项目：新身份、名称加「副本」、revision 归 1，章节正文与父子关系一并复制
- 章节创建与 revision bump 同一事务；导入/排序/删除/更新仍走原仓储事务
- 画布-章节关联：列 `project_id`、payload `projectId`、unit link、双方项目 revision 同一事务；未知 payload 字段保留。画布从旧项目改挂到新项目时删除旧 link 并 bump 旧项目
- 解除章节关联、解除项目关系；解除项目关系时删除 payload 中的 `projectId`，保留其余未知字段
- 归档项目不能再改章节或画布关联，也不能作为生成任务的业务项目；更新项目本身仍可解档
- 工作台 core/overview/unit summaries/canvas page 的仓储读取
- 测试/遗留 `Service{repo}` 构造不再懒写入共享 `projects` 字段；缺字段时每次返回无状态实例

## 写入原子性（本切片）

窄仓储 `repository/project_mutate.go` 持有事务，领域不把 `app.Service` 回调进事务。

| 写入 | 同一事务内 | 失败后 |
| --- | --- | --- |
| 创建项目 + 默认工作流 | 项目行、workflow instance/steps、revision+1 | 项目与实例都不留 |
| 创建章节 | unit 行 + 项目 revision | 不留孤立章节 |
| 关联画布章节 | canvas 列与 payload、link、新旧项目 revision | 列/payload/link 一致回滚 |
| 更新项目 | 归属 + `revision = expected` 的 CAS | 另一方完整保留 |
| 项目搬家 | folder_id + revision+1 | 位置与修订一起回滚 |
| 创建文件夹 | 父夹同用户存在性 + insert | 不出现无主 parentId |

内置工作流模板仍由 `EnsureBuiltinTemplate` 在项目事务外幂等写入（全局共享）。章节工作流 `createProjectWorkflow` 仍在 app：先 `CreateWorkflowInstance` 再 `BumpProjectRevision`，不是本切片的原子范围。

## 仍留在 app 的残余

这些实现与生成任务、角色版本修复或素材卡片装配缠在一起，尚未迁出。项目领域通过一次归属校验或 `Inspect` 快照接入，不复制规则。下一刀是这些算法，不是已经完成的聚合抽取。

| 残余 | 位置 | 仍在 app 的算法 |
| --- | --- | --- |
| `ProjectDetail` 装配 | `app/project.go` | 读前补偿后拼卡片：`reconcileCharacterTurnaroundTasks`、成功任务 `RegisterTaskOutputFromTask`、再 `Inspect` + `ProjectAssets` + `ProjectWorkflows` + `TasksWithOptions` |
| 项目素材 | `app/project_asset.go` | 链接/解除、分类与目录移动、新版本、确认候选、上传资源合成资产、`projectAssetSummary`；写后单独 `BumpProjectRevision` |
| 项目素材文件夹 | `app/project_asset_folder.go` | 素材库内文件夹 CRUD 与父夹解析 |
| 角色与声音 | `app/project_character.go` | 角色创建/更新、三视图替换、试听绑定、turnaround 任务回写与读取补偿、角色版本准备 |
| 镜头 | `app/project_shot.go` | 分镜创建/整章替换、修订、删除、镜头资产引用、资产候选；部分路径单独 bump revision |
| 工作流步骤机 | `app/project_workflow.go` | 内置模板确保、章节工作流实例创建（instance 与 revision 仍分两步）、步骤状态机与完成校验、任务产物登记、`ensureGeneratedProjectAsset` |
| 工作台卡片页 | `app/project_workbench_read.go` | `ProjectUnitWorkspace` 装配素材/工作流/任务；素材与候选分页 |

`Workflows` 是项目拥有的窄端口：只准备默认实例记录。步骤机、产物登记和章节工作流创建仍在 app。

## 兼容委托

`app` 的原方法名全部改为一次转发到 `internal/project`，HTTP JSON 字段不变。handler 在组合根迁移完成前可以继续调用 `app.Service`。`ProjectDetail` 是唯一仍在 app 编排的聚合读取：先做任务侧补偿，再 `Inspect`，再补素材/工作流/任务卡片。
