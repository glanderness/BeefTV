# Codex 按模型上下文窗口与压缩阈值（GPT-6.1-Sol 100 万 / 60 万）

状态：**已落地并读回**（2026-10-28）。范围：本机 Todos 的 Codex 运行时（`$HOME/.tds/codex-home`），不涉及 BeefTV 产品代码。

## 结论

- GPT-6.1-Sol 的实际运行配置已按模型级生效：**有效上下文窗口 1,000,000**、**自动压缩阈值 600,000**。
- 落地方式不是顶层 `model_context_window` / `model_auto_compact_token_limit`（那两个键是**整个 CODEX_HOME 全局**的），而是 `model_catalog_json` 指向的**模型目录副本**，因此**同机其他模型（含 GPT-6-Astra）不受影响**。
- 已隔离实测：目录里的 `context_window` / `max_context_window` / `effective_context_window_percent` / `auto_compact_token_limit` 四个字段都按模型生效；`auto_compact_token_limit` 是**真的会触发压缩**的（见 §4）。

## 1. 为什么必须走模型目录

Codex CLI 0.160.1 的顶层键只有全局语义：

- `model_context_window`：*Context window tokens available to the active model*，一个 CODEX_HOME 一份，对该 home 里所有模型生效。
- `model_auto_compact_token_limit`：*Token threshold that triggers automatic history compaction (unset uses model defaults)*，同样全局。
- 配置档 `$CODEX_HOME/<name>.config.toml` 只在传 `--profile` 时叠加；tds 不传，且它同样是全局选择，无法按模型区分。
- 顶层没有 `[models.<id>]` 这类按模型的上下文表。

`model_catalog_json` 是唯一按模型的入口：它是**整份目录替换**（不是合并），每个模型条目自带窗口与压缩阈值，所以可以只改目标模型。

## 2. 改动位置与前后值

改动前（`$HOME/.tds/codex-home/config.toml`，sha256 `fc121ea10f7e710445fb29637fb048b5a33db8383ff4bd66d7a8870a4e5578df`，已备份为 `config.toml.bak-20261028-sol1m`）只有 tds 写入的 `[features] apps = false` 与 `[apps._default] enabled = false`，两个目标键都不存在。

改动后新增（顶层，必须在任何表头之前）：

```toml
model_catalog_json = "$HOME/.tds/codex-home/model-catalog.json"
```

新增文件：

- `$HOME/.tds/codex-home/model-catalog.json`：本机实时目录（10 个模型）的副本，只改 `gpt-6.1-sol` 一项。
- `$HOME/.tds/codex-home/refresh-model-catalog.sh`：重新拉取实时目录并重新套用覆盖。

| 模型 | 字段 | 改动前 | 改动后 |
| --- | --- | --- | --- |
| gpt-6.1-sol | context_window / max_context_window | 500000 / 872000 | 1000000 / 1000000 |
| gpt-6.1-sol | effective_context_window_percent | 95 | 100 |
| gpt-6.1-sol | auto_compact_token_limit | 未设（模型默认） | 600000 |
| gpt-6.1-sol | **实际生效窗口** | 475000 | **1000000** |
| 其余 9 个模型 | 全部字段 | — | 未改动（如 gpt-6-astra 仍 272000 / 872000 / 95 / 默认） |

口径说明：Codex 对外使用的有效窗口 = `min(配置或目录的窗口, max_context_window) × effective_context_window_percent`。默认 95% 是 CLI 自留的余量；Sol 的模型文档总窗口是 1,050,000，把可用窗口设为 1,000,000 仍留 50,000 余量，因此这里用 `percent = 100` 拿到整整 100 万。

## 3. 读回证据

| 检查 | 命令（`CODEX_HOME=$HOME/.tds/codex-home`） | 结果 |
| --- | --- | --- |
| 配置解析 | `codex doctor --json` | `config.load ok`、`config.toml parse ok`、无被忽略的键 |
| 目录生效 | `codex debug models` | Sol = 1000000 / 1000000 / 100 / 600000；其余 9 个模型原值不变 |
| 平台模型列表 | app-server `model/list` | 仍返回 8 个可见模型（与改动前一致） |
| **真实会话读回** | 以真实 CODEX_HOME 起 app-server、ephemeral 线程跑一回合 | `thread/tokenUsage/updated` 的 `modelContextWindow = 1000000`（此前 475000） |

生效时机：tds 每个回合都新起 `codex app-server`，配置在启动时读取，所以**下一个回合起生效**，不需要重启 Todos、不影响正在跑的回合。

## 4. 隔离实测：目录里的压缩阈值真的会触发压缩

压缩阈值平时无法在不灌满上下文的情况下观察，所以用极小阈值做对照实验（独立临时 CODEX_HOME，只链接同一份 auth.json，不影响 agent home）：

1. 顶层 `model_auto_compact_token_limit = 5000` + 连续两回合 → 第二回合出现 `contextCompaction` 项（**对照组成立**，说明测试方法有牙齿）。
2. 目录里 `gpt-6.1-sol.auto_compact_token_limit = 5000`（不写顶层键）+ 连续两回合 → 同样出现 `contextCompaction`，同时 `modelContextWindow = 1000000`。

即：**按模型的压缩阈值确实按模型生效**。第一回合不触发是正常的（历史为空，阈值在后续回合开始时按累积上下文判断）。

## 5. 未测项（不要当成已验）

- **没有**真正跑到 600,000 才压缩：只验证了阈值被读取且能触发压缩，未触达 60 万。
- **没有**验证上游接受超过 872,000 token 的输入：账号实时目录给的 `max_context_window` 是 872000，而模型文档写 1,050,000；本次只证明 Codex 侧按 100 万记账，未证明上游在 87 万以上一定不报错。
- 冻结目录的长期代价见 §6。

## 6. 代价与维护

`model_catalog_json` 是整份替换，因此目录**被冻结**：新模型不会自己出现，已有模型的系统提示（`model_messages`）停在生成当天。刷新方式：

```sh
$HOME/.tds/codex-home/refresh-model-catalog.sh
```

脚本会在临时 CODEX_HOME 里重新拉取实时目录，再套用文件内 `OVERRIDES` 的按模型覆盖后写回。已实测可重复运行且结果一致。

另注：`config.toml` 由 tds 在**文件缺失时**重写为默认内容，所以手工加的 `model_catalog_json` 行会随文件一起被重建而丢失；删过该文件就重新加一行。

## 7. 与「Astra 700k / 500k」的关系

同一个 CODEX_HOME 里 Sol 与 Astra 共用一份目录，所以**两个模型可以各设一组值**：

- 正确做法：在 `model-catalog.json` 的 `OVERRIDES` 里加 `gpt-6-astra`（`context_window` / `max_context_window` = 700000、`effective_context_window_percent` = 100、`auto_compact_token_limit` = 500000），再跑刷新脚本。`refresh-model-catalog.sh` 里已留注释示例。
- **不要**改用顶层 `model_context_window = 700000`：那是全局值，会把 Sol 从 100 万拉回 700000（配置值会被目录的 max 夹住，再乘百分比）。

## 8. 变更记录

- 2026-10-28：调研官方配置面、隔离实测按模型机制（窗口 + 压缩触发）、落地 Sol 1000000/600000 并读回；记录未测项与 Astra 配合方式。
