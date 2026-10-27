# 插件保护：复审修改与验证记录（2026-10-27）

本文是本轮（架构师复审两条意见之后）的交付与验证记录，取代此前通过 tailnet 传输用的 `HANDOFF.md`——那份说明停留在第一轮（`eac4602`、66080 字节补丁），已过期，不作为参考。

设计与行为说明见 [plugin-retention.md](./plugin-retention.md)，本文只记“改了什么、怎么验的”。

## 本轮范围

1. **盘点失败不再等同于“没有待取回任务”**：`deferralFor` 区分三种情况——清单没变（不判断）、盘点读不出来（保留已安装定义并说明原因）、没有接入盘点（独立运行时，保持原行为）。同时把“是否算一次升级”改成只比较清单，重新打包但定义没变时不再误报推迟。
2. **前端兜底不再绕过撤下限制**：目录里该能力存在、但可选协议全被撤下时，`defaultProtocolForCapability` / `defaultProtocolForModel` / `beefApiVideoProtocol` 返回 `undefined`，新模型保持“待配置”，由设置页让用户选；只有目录完全为空（宿主没有撤下信息）才退回内置协议表，避免目录不可用时把新建连接堵死。

## 提交与基线

- 基线：`28f1b9a`（上一轮已推送的提交）
- 本轮改动：6 个代码/文档文件（`retention.go`、`retention_test.go`、`model-protocols.ts`、`use-config-store.ts`、`plugin-catalog-retired.test.tsx`、`plugin-retention.md`）+ 本文

## 验证环境

Mac 工作区 `/Volumes/ExternalWork/todos/workspaces/01a17934-be1a-7ae4-a4a3-92b5b18cb0a9`，Go 1.26.3 darwin/arm64，Bun 1.4.2。对比用临时 worktree 检出 `28f1b9a`，跑完删除。

## 结果

先跑 `sh plugin-packages/build-packages.sh`（输出 `embedded complete documentation into 86 protocol packages`），两边都跑。

| 检查项 | 本轮 | 基线 `28f1b9a` |
|---|---|---|
| `go test ./internal/plugins/` | ok 69.5s | ok 66.0s |
| `go test ./internal/app/ -run 'TestPluginReferences'` | 4 个用例 PASS，ok 1.1s | 4 个用例 PASS，ok 0.6s |
| `go test ./internal/workspace/` | ok 1.5s | ok 2.2s |
| `go test ./internal/protocol/` | ok 1.9s | ok 1.8s |
| `go test ./internal/repository/`（含 CGO/sqlite 用例） | ok 2.6s | ok 1.8s |
| `bun run typecheck`（tsc --noEmit） | 通过 | 通过 |
| `bun run lint`（eslint src test） | 通过 | 通过 |
| 前端用例（plugin-catalog-retired / manual-channel-protocol / channel-model-catalog / model-capabilities / plugin-category-sections） | 58 pass / 0 fail | 57 pass / 0 fail |

前端多出的 1 条是本轮新增的 `with no selectable protocol a new model stays unconfigured`。

全部通过，没有需要归因到基线的失败项。

## 没有覆盖的部分

- 本轮按复审要求只跑了新增用例与协议相关用例，没有重跑前端全量套件。上一轮记过：全量里 `test/settings-model-picker.browser.test.ts` 有 7 条“六类默认模型可见并可选择”在基线上同样失败（3 秒内等不到 `MODEL_PICKER_OPEN` 诊断事件），属于既有问题；本轮改动不涉及该文件的行为路径，但也没有再做一次基线对照。
- 验证全部基于本地合成配置与测试数据，没有读取任何真实用户凭证，没有发起任何生成请求。