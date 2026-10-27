# 插件保护（只含后台）：验证记录（2026-10-27）

设计说明见 [plugin-retention.md](./plugin-retention.md) 和 [protocol-decision.md](./protocol-decision.md)，本文只记「这份改动带了什么、怎么验的」。

## 范围

从 main `d647039` 新开分支，只带 #33（`75f0695`）/ #44（`1c98775`）里的后台部分：`backend/internal/` 下的盘点、保留与升级推迟，`providerpreset` 的默认协议表和共用用例，相关测试和文档。没有带：

- 任何 `web/` 下的改动（包括 #44 复审仍有问题的 `use-config-store.ts`、`model-service-presets.ts`、`channel-model-catalog.ts`）；
- 根 `Dockerfile` 那一行：它只为前端构建复制 `protocol_defaults.json`，本 PR 的前端不读这个文件；后台用 `go:embed` 编进二进制，`backend/Dockerfile` 已复制整个 `backend/`；
- #44 分支从 main 合并来的其他单子的改动。

取法：只对 `backend/`、`docs/`、`CHANGELOG.md` 求 #44 分支相对它最后一次合并 main（`70aa2a3`）的差异，套到最新 main 上，没有冲突。之后按只含后台的情况改了：

- `protocol_defaults.json` 去掉只有前端用的 `preferred` 一组，后台不读它；
- `protocol_defaults.go` 和测试的注释不再说「前端读同一份文件」，改为「与前端现值一致，需手动保持」；
- 文档去掉前端部分，补上给前端的接口约定（`protocol-decision.md`）。

## 结果

Mac 工作区，先跑 `sh plugin-packages/build-packages.sh`（86 个协议包），再跑下列测试。基线 main `d647039` 在临时 worktree 里跑同一组（同样先放好协议包），跑完已删除。全部是离线测试，用合成配置，没有读取真实凭证，没有发起生成请求。

| 检查项 | 本 PR | 基线 main `d647039` |
| --- | --- | --- |
| `go build ./...` | 通过 | — |
| `go test ./internal/plugins/ ./internal/workspace/ ./internal/protocol/ ./internal/providerpreset/ ./internal/repository/`（含 CGO/sqlite） | 5 个包 ok，417 个用例（含子用例）通过，0 失败 | 5 个包 ok，373 通过，0 失败 |
| `go test ./internal/app/ -run 'TestPluginReferences\|ImageSubmission\|ImageRecovery\|ImageAutoRecovery\|RecoveryIdentity\|ProtocolPlugin'` | 98 通过，0 失败 | 94 通过，0 失败 |

基线通过的用例在本 PR 里全部仍然通过；多出的是新增的后台用例（`internal/app` 多 4 条 `TestPluginReferences*`，其余 5 个包多 33 个顶层用例及其子用例）。

## 没有覆盖的部分

- 没有跑 `go test ./...` 全量（一次超过 10 分钟，被中断），只跑了上面这组。
- 没有跑前端测试：本 PR 不改前端。
- 没有在真实客户端里升级一次版本观察；行为只由上面的单元/集成测试覆盖。
