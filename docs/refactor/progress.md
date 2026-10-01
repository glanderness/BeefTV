# 完整重构实施记录

本文件记录开发候选的真实状态；不是发布证明。范围与验收以 [实施合同](./implementation-contract.md) 为准。

## 已核实基线

- 15266ba 合并正式 v1.6.21 与 Agent 候选；035bb49 固定完整重构范围。
- 独立验证：`cd backend && go test ./internal/database ./internal/generation ./internal/beefapi ./internal/handler`。新工作树先运行 `./plugin-packages/build-packages.sh`，否则官方协议包缺失会导致 registry 测试失败。构建协议包后 generation 通过。
- 独立验证：`cd backend && go test ./internal/generation ./internal/app` 通过，app 用时 168.348 秒。
- 独立验证：`cd web && bun install --frozen-lockfile && bun run typecheck` 通过。
- 以上仅证明合并基线；不代表下列工作已完成，也不替代真实客户端、模型和发布包验收。

## 第一批并行实现

所有工作树固定于 15266ba，只有 Lead 向集成分支合入。Grok 不执行发布、真实数据写入或付费模型调用。

| 责任 | Grok job | 写入范围 | 集成前核查 |
| --- | --- | --- | --- |
| 迁移身份与实际结构 | 20261002-005355-delegate-035f0aa6 | database | 历史编号碰撞、结构缺失、未知列保留、失败重试 |
| Agent 宿主运行时 | 20261002-005355-delegate-4c14270a | 宿主 lifecycle、新 runtime、必要 bootstrap 接线 | 进程唯一 Wait、配置与凭据隔离、停止/恢复 |
| 公共业务操作 | 20261002-005355-delegate-53bc028d | operations、agentops 适配、canvas 合同 | 授权先于重放、事务与回执、无 app 反向依赖 |
| 生成结果可靠交付 | 20261002-005638-delegate-f5527881 | app/task、结果交付、task repository | 界面关闭仍可落地、故障重试不重复付费/节点 |
| 剪辑与导出完整性 | 20261002-005638-delegate-2ab89e9b | timeline、merge、export-integrity、zip | 实际音轨/字幕、执行器语义一致、备份引用 |
| 官方 pi 会话与事件 | 20261002-005825-continue-4b74edc3 | agent-host、助手事件投影 | dispose、官方持久化、隔离加载、取消/压缩/重试 |
| 画布页面职责 | 20261002-010449-delegate-75be177f | project 页面、新私有 controller | 不以巨型 hook 搬家代替解耦、保留交互 |
| 协议插件领域 | 20261002-010449-delegate-0a5e6e6c | plugins、app 插件适配 | 单一注册表/变更所有者、实际实现退出 app |

## 基线回归排查

直接 `cd web && bun test`：2311 pass / 10 skip / 37 fail。该命令绕过仓库隔离入口，`mock.module` 污染后续文件。逐文件复核后，除浏览器运行时未指定路径外全部通过。

已修复一处实际合并回归：明确 `local_storage_failed` 的准入失败保留“尚未提交生成”；普通数据库错误仍不推断上游是否接单。`bun test test/generation-error.test.ts`：64 pass / 0 fail。

正确全量入口：`cd web && CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' bun run test`。结果 2389 pass / 0 fail / 10 skip，退出 0。使用仓库 `scripts/run-test-suite.mjs` 的既有隔离规则，没有删测试。

## 独立审查与合入

| 切片提交 | 独立验证 | 决定 |
| --- | --- | --- |
| database 2d8b3ce | 完整生产 diff 与历史 DDL 夹具审查；`go test ./internal/database -count=1` 通过，2.426s | 合入为 331857a；公开文档跟进 |
| runtime 17f5f35 | runtime/handler/bootstrap 测试通过 | 暂不合入；新领域反向依赖 app、请求级临时 Host 必须修正；继续 job 20261002-011135-continue-c3772d17 |
| editing b9fb278 | 实际 native FFmpeg + 执行/计划/完整性测试，29 pass / 0 fail | 暂不合入；共享 worker 取消所有权、空备份限制、实际 native 调用边界需修正；继续 job 20261002-011554-continue-f082d24e |

第二批项目领域：job 20261002-011319-delegate-63acf902，工作树固定 0d29c11，负责项目实际规则退出 app、消除 project/localapp 反向依赖。仅允许项目相关接线，不能改生成、素材、宿主或插件核心。

## 后续审查与并行接入

- runtime 修正 a7dd50b 独立测试通过：assistantruntime 1.663s、assistant 1.155s、handler 3.064s、bootstrap 14.861s；合入 ecda201 / 1218b3e。Lead 进一步移除独立路由注册的无 Close 所有者 Host 兜底，集成 handler/bootstrap 通过。
- pi 5541435：54 pass / 0 fail；额外确定性复现并发 replace 泄漏和 current.json 写失败后的状态分裂，未合入。继续 20261002-012611-continue-352b1416。
- generation fdf34aa：未合入；恢复仍依赖 GET、元数据覆盖与错误吞没待修。继续 20261002-012722-continue-ab34e728，实现后台恢复和实际 taskdelivery 领域。
- plugins e03031e：未合入；同包重装失败可能删除旧包、管理状态回滚存在并发窗口。继续 20261002-012809-continue-39115e00。
- operations 7000765：聚焦四包独立测试通过；修复调用身份 fail-closed 并接入人工画布保存，继续 20261002-012045-continue-a38f46d6。
- Agent 业务轮次：20261002-011801-continue-a7418435，固定 331857a，assistantturns + schema 10；官方 pi 保留会话事实，SQLite 负责业务轮次和撤销事务。
- 模型目录/能力/渠道：20261002-012935-continue-dead2721，固定 1218b3e；实际规则退出 app，保留上游参数合同。

以上都在独立工作树；尚未进入发布验收，没有新增真实模型费用。

## 第二轮审查

- editing 911bc1a / 708fc35 / 0c9d91b 已进入集成。Lead 复现取消当前工作时，后续租约拿到已终止预热 worker 的竞态，直接修正所有权转交与 dispose；36 项聚焦测试、2 项真实浏览器 worker 测试和 typecheck 通过。实际原生/浏览器共用内容计划继续由 20261002-014317-continue-8982ff92 实现。
- project fc96599 独立 project/localapp/handler/bootstrap 测试通过；仍有章节/关联分步写入、更新无 CAS 和父文件夹归属问题，继续 20261002-013550-continue-babf5c0c，尚未合入。
- assistantturns 408c16e 独立迁移/领域/应用聚焦测试通过；旧 JSON 双写、Begin 未优先迁移旧 ID、清理后可重导入、损坏 scope 静默降级必须修正。继续 20261002-014449-continue-1ca2e878，尚未合入 schema 10。
- 资源真实领域：20261002-013215-delegate-6c5c1bb2，固定 673e320；保持现有生成存储方法适配，不能与交付 worker 重复拥有任务逻辑。
- 旧 Agent 退场：20261002-013853-delegate-63e3a533，固定 673e320；只移除已验证无活跃入口的实现，保留历史数据及现有功能仍使用的公共规则。
- CPU 数据处理基线已记录于 [performance.md](./performance.md)，并非 UI 或数据库端到端性能结论。

## 后续必须继续的范围

### 第三轮集成核查

- pi `5541435` + `ea763e8` 已合入 `0174d60` / `561073e`。独立官方 SDK 宿主测试 75 pass / 0 fail；前端事件投影测试 40 pass / 0 fail。
- 在 `372a835` 上按仓库隔离入口完成全量前端回归：2414 pass / 0 fail / 12 skip，退出 0。跳过项不是已验收；剪辑真实媒体仍需专项输出验证。
- 项目核心 `fc96599` + `362a491` 合入 `2ade7a4` / `f065ae0`；独立 project/repository/localapp/bootstrap/handler 通过。项目素材、角色、分镜、工作流实际领域继续 `20261002-015848-continue-a98109ad`。
- 旧 Agent 退场 `50931cf` 合入 `6666186`；独立 app 全包 179.928s，handler/bootstrap/generation/database/repository 通过。历史表保留，现行 pi 入口保留。
- 模型规则 `fbf25da` 合入 `5f416c8`，Lead 保留非字符串 metadata 的严格读取语义（`d750b18`）。独立 modelcatalog 与 app 相关能力/渠道/助手/Seedance 测试通过。模型服务与路由实际归属继续 `20261002-020309-continue-bb37025d`；Provider 执行另由 `20261002-020308-continue-35d509a8` 负责。
- assistantturns `408c16e` + `f26c674` 合入 `64aa600` / `80a493f`，schema 10。独立迁移、轮次和 app 聚焦测试通过。旧 JSON 为只读输入；SQLite 为唯一业务轮次账本。
- operations `7000765` / `96593b0` / `94f2f31` 进入集成 `d29fe0e` / `69666a9` / `3a826bc`；独立后端五包通过，前端 36 pass。人工提交日志仍有 IO 失败、scope 切换与取消后身份保留缺口，继续 `20261002-020021-continue-4a95b35b`，本次合入不代表该边界验收完成。
- Lead 已在操作事务里接入轮次开放校验，修正遗留 JSON 读取测试；agentops/operations/assistantturns 独立集成测试通过。覆盖预检后结算拒绝写入、先提交的写入被结算记录、缺少轮次事务校验时失败关闭。
- 画布组合 `8963bb4` 合入 `3286bfe`；独立 11 文件 125 pass / 0 fail。页面仍有后续职责与异步写入边界要收口，不能只以行数变化为完成证据。
- 交付恢复继续 `20261002-015749-continue-0dfdf1f7`，补公平扫描与失败资源重试；资源继续 `20261002-015750-continue-d01fd274`；插件继续 `20261002-020352-continue-c1b4f643`，补数据库卸载事务与失败后的内存视图一致性。三者尚未合入。

1. 人工 UI 已接入公共操作，继续补提交日志持久化失败、scope 切换与未知响应后的幂等身份保留。
2. 配合后端结果交付切换前端 materializer/consumer，完成节点/消息与回执的原子绑定，避免两个执行者同时交付。
3. Agent 业务轮次已改为 SQLite 单一账本并接入操作事务；继续在整合后验证确认、撤销及会话恢复。
4. 模型目录、Provider/Protocol/Transport、RunningHub 的实际实现归属；插件状态与包文件的失败恢复。
5. 工作区、项目、素材、配置与生命周期接线。project/localapp 已解除 app 反向依赖，LocalKernel/task facade 的生产组合根仍需切换到实际领域服务。
6. 旧 Agent 活跃实现已移除；整合中持续守住历史数据保留和旧任务拒绝边界。
7. 真实媒体输出、备份还原、平台升级、性能对比、完整回归、独立复审和新候选付费验收。

### 第四轮审查与交付衔接

- 整合快照 `6840b32`：前端 typecheck 和 `go test ./...` 通过。此前独立重跑 app 全包 193.509s，handler/bootstrap 43.788s/49.708s，operations/agentops/assistantturns/modelcatalog/project/localapp 均通过。不是最终候选全量验收。
- 生成交付 `373fd84` 独立 task/taskdelivery/app 聚焦测试通过，合入 `baec6fd` / `f9a101f` / `d9a97ac`。包含后台公平扫描、同资源身份恢复、READY 所有权校验；节点绑定仍只是意图。后续 `20261002-022438-continue-54fd462d` 负责原子画布绑定和前端交付切换。
- 任务运行时 `d6b8db8` 尚未合入。Lead 发现空 ResultWriter 造成虚假 Applied、Commit 失败状态、StartLoop 重入与槽位释放问题，继续 `20261002-021807-continue-0e6afbed`。
- 资源 `84175ac` / `1e279f3` 尚未合入。继续 `20261002-021808-continue-6370b477`，补删除事务中的运行任务引用检查，以及同一工作区多个服务句柄的 PENDING 所有权。
- 剪辑计划 `484eaaa` 尚未合入。Lead 发现图片分支无限音源未限定输出时长、执行器可覆盖计划参数、采样率与混音策略不一致，继续 `20261002-022311-continue-9d7dc656`；要求实际媒体输出与空工作区 ZIP 还原。
- RunningHub 实际协议域由 `20261002-021904-delegate-ea62673e` 独立实现，固定 `6840b32`，与通用 Provider 切片不重叠。
- 创作页对话原为 IndexedDB 唯一持久状态。`20261002-022128-delegate-0883fddd` 负责 SQLite aggregate、CAS、旧缓存幂等导入与删除 tombstone，为原子消息绑定提供事务端口；schema 11 只保留给该切片，尚未合入。

不得将第一批 worker 完成、目录分包或旧版验收报告写作“完整重构完成”。后续变更需按实际依赖顺序实现与验证。
