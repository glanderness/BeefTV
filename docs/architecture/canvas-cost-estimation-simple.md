# 画布费用估算：照主流做法的简化方案

核查日期 2026-10-27。本文只给调研结论和方案，不改代码。它取代 #64 的 `canvas-cost-estimation.md` 中「新建估算服务 + BeefAPI 批量报价接口 + 授权费用快照」的路线。

## 1. 结论

同类工具几乎都用同一种做法：

1. **价格跟着模型走**：每个模型带一条价格规则（单价 × 秒数／张数／分辨率档位）。
2. **客户端按节点当前参数直接算**，参数一改数字就变；不调用报价接口，不锁价、不存快照。
3. **在原本就有的位置显示**：节点或模型选择器旁边显示单价或本次价格；批量运行和助手确认时列出每个节点的价格，再给一个合计。
4. **算不出的标出来，不当 0 元**；合计只叫「已知部分」或「预计」，实际以账单为准。

BeefTV 照这个做，**不需要改 BeefAPI，不需要新服务，不需要费用快照**。BeefAPI 公开的企业价格目录（`/api/enterprise/catalog`）已经有图片、视频、配音、音乐的单价，BeefTV 刷新模型目录时顺手读一次存下来，写一个计算函数，在三个已有的确认位置把合计显示出来，再把结果放进助手的制作提议返回里。预计 **2.5 人日**。

## 2. 同类工具怎么做（已核实）

| 工具 | 单个节点 | 整次运行／整个工作流 | 助手怎么报预算 | 证据 |
| --- | --- | --- | --- | --- |
| ComfyUI（开源） | 付费节点在定义里声明 `price_badge`：一个 JSONata 表达式，依赖哪些参数（如 `0.0715 * widgets.duration`），前端按当前参数实时计算后显示在节点角标；结果类型只有 `usd`、`range_usd`（区间）、`text` 三种 | 官方前端 `graphCreditsBadges` 只**列出**画布里每个付费节点的价格，不做合计；社区插件 Comfyui_API-utils 在「运行」按钮悬停时把各节点角标相加 × 排队次数；算不出的不计入，标为「已知花费」 | 无 | [C1] [C2] [C3] [C4] |
| Flora / FAUNA | 节点上显示本次费用，随模型、分辨率、参数实时更新；2026-05 起直接显示美元 | — | Assist 模式下，FAUNA 列出要运行的节点和预计费用，用户同意后才生成 | [F1] [F2] [F3] |
| Figma Weave | 点中节点，右上角显示积分；秒数、分辨率变化时数字跟着变 | — | — | [W1] |
| Freepik Spaces | 模型选择器上有「Credits」标签，是默认参数下单次价格；悬停显示详情 | 官方没有整体合计 | — | [P1] |
| Krea Nodes | — | — | 节点助手检查完工作流后，按节点列出算力费用，用户说开始才运行 | [K1] |
| Runway Workflows | 按实际调用的模型步骤计价 | — | 开启「生成前询问」时，助手列出模型、提示词和本次预计积分后等待确认 | [R1] |
| Infinite Canvas（上游） | 2026-05 曾在生成按钮旁显示「本次预计消耗算力点 = 模型固定点数 × 张数」（`requestCreditCost`）；2026-07-05 提交 `9dd0dc2` 删掉，当前 `9cd3dea` 没有任何价格展示 | 无 | 无 | [U1] [U2] |

最常见、最简单的组合是：**节点或模型旁显示价格 + 确认时列清单和合计 + 算不出的标出来**。没有一家公开说自己做了服务端批量报价、价格版本或确认时的费用快照。上游 Infinite Canvas 做过最简单的「固定单价 × 数量」，后来因为改成纯前端、用户自带 Key 而整体删掉，没有能直接搬的代码，但说明「单价 × 数量、放在已有按钮旁」这条路在上游就是这么走的。

## 3. BeefTV 现在缺什么

- **价格数据只有视频的一部分**。`/v1/models` 只带 `video_pricing`，而且 BeefAPI 只给 H3 这类按秒计费的模型投影这个字段（`controller/model_video_capabilities.go` 中的 `projectVideoModelCapabilities`）。Seedance 这类按 Token 计费的视频、全部图片和音频，客户端都拿不到价格。
- **企业价格目录已经有全部数字**。2026-10-27 读取 `https://beeftv.app/api/enterprise/catalog`（无需登录）：52 个模型，其中图片 13 个（`image_price_table` 按质量 × 1K/2K/4K 列价，另有参考图单价；或 `per_request_cny`），视频 11 个（`per_second_cny` 按分辨率列价；Token 计费的模型另有 `video_official[].output_per_second_cny` 折算成每秒价），配音 `minimax-speech-2.8-*` 每百万字符 ¥200／¥350，音乐 `minimax-music-v3.0` 每次 ¥1。BeefTV 只连企业站点（`client.go` 要求 `market == "enterprise"`），这份目录就是用户实际付的价。
- **算价逻辑散在前端**。`web/src/lib/seedance-portrait.ts` 的 `estimateVideoTargetPrice` 只算按秒的视频；`canvas-assistant-copy.ts` 把它加成「预计费用：视频…约 ¥x；其余按渠道单价结算」；分镜批量确认写「当前没有可用价格数据」；超分节点有后端返回的先扣金额。
- **助手**只能从 `model.catalog` 看到部分视频单价，自己没有算好的数字。

## 4. 方案

### 4.1 改动清单（一共四处）

**① 价格数据：刷新目录时多读一次企业价格目录**（`backend/internal/beefapi`）

`RefreshCatalog` 在读 `/v1/models` 之后，再 GET 一次同源的 `/api/enterprise/catalog`，按 `model_name` 把整行价格存进对应模型的 profile，字段名 `pricing`（原样保存需要的几个字段，不做换算）。读失败就不写，不影响模型列表。现有 `videoPricing` 先保留，计算函数优先用 `pricing`。

不用改 BeefAPI。以后 BeefAPI 愿意把同一行价格放进 `/v1/models`，这里改一个地址即可。

**② 一个计算函数**（Go，放在 `backend/internal/modelcatalog` 下，约 150 行加测试）

```text
EstimateTarget(pricing, kind, params, referenceCount, text) -> { amount: "1.40" | null, basis: "1K 低质量 ¥0.35 × 4 张" }
```

规则只照目录字段直接算，不猜：

| 类型 | 计算 |
| --- | --- |
| 图片 | `image_price_table.output[质量][尺寸] × 张数 + 参考图单价 × 收费参考图数`；没有价表就用 `per_request_cny × 张数` |
| 视频 | `per_second_cny[分辨率] × 秒数 × 个数`（加参考图费用）；Token 计费的用 `video_official[分辨率].output_per_second_cny` 折算，文案写「约」 |
| 配音 | `input_cny ÷ 1,000,000 × 台词字数` |
| 音乐 | `per_request_cny × 次数` |
| 超分 | 不在这里算，继续用后端已返回的「先扣」金额，单独一行显示，不加进合计 |
| 其他 | 自带 Key、没有价格、参数缺失、按账单结算的参考生成：`amount = null`，写明原因 |

合计 = 所有 `amount` 不为空的项相加；只要有一项为空，就显示「已知部分 ¥x，另有 N 项暂无价格」。这和 ComfyUI 插件的「已知花费」一样。

前端的 `estimateVideoTargetPrice` 和 `formatProductionPriceSummary` 里的加法删掉，改用后端结果，保证只有一处算价。

**③ 让助手和外部工具拿到数字**（`backend/internal/operations`）

- `canvas.generation.propose` 的返回里加 `estimate`：每个节点的金额和依据，加合计。助手提议时就知道这次要多少钱，确认卡直接显示这个结果。这就是 Flora、Krea、Runway 的做法。
- `model.catalog` 的返回带上 `pricing`，助手挑模型时能比价。
- 想问「整个画布还要花多少」时，给 `canvas.get` 不够；加一个只读操作 `canvas.cost.estimate`（参数：`canvasId`，可选 `nodeIds`；不传就算所有已配好模型、还没有成品的生成节点），直接调用上面的函数。不联网、不写数据、不建任务。外部 MCP、CLI 通过现有的操作路由自动可用。

**④ 用户在已有位置看到合计**（`web/src`，不加新按钮）

- 助手制作提议卡：用 ③ 的结果替换现在的「预计费用：视频…」那一行。
- 分镜批量确认（`use-canvas-storyboard.ts`）、批量生成确认（`use-canvas-generation-batches.ts`）：把「当前没有可用价格数据」换成 `canvas.cost.estimate` 算出的合计。
- 模型选择器（`model-picker.tsx`）现有的「价格」弹层：从只显示视频单价扩展到图片、音频单价，跟 Freepik 在模型选择器上标价一样。

### 4.2 不做的东西（主流都不做）

- BeefAPI 新报价接口、批量报价、服务端锁价。
- 价格版本号、有效期、确认时保存费用快照、提交前重新核价。
- 预算上限、超预算拦截、新的预算设置页。
- 节点上实时变化的价格角标。ComfyUI、Weave 有，但 BeefTV 要在每个节点面板接参数变化，工作量超出 3 天，而且确认时已经能看到。真要做，下一步把计算函数在面板里调一次即可。

### 4.3 工作量（2.5 人日）

| 天 | 内容 |
| --- | --- |
| 第 1 天 | ① 读取并保存价格目录；② 计算函数和表格驱动的单测（用 10-27 目录里的真实数值各取一例） |
| 第 2 天 | ③ 提议返回 `estimate`、`canvas.cost.estimate`、`model.catalog` 带价格；助手提议卡改用后端结果 |
| 第 3 天上午 | ④ 两个批量确认框和模型选择器；在隔离的测试客户端里用假模型走一遍，只看显示，不点生成 |

### 4.4 这个版本做不到什么

- **数字是估算，不是账单**。像素分档（Seedream pro）、Token 计费视频的折算、参考生成按美元账单结算，实际扣费可能不一样；界面写「预计」「约」。
- **自带 Key 和自定义渠道没有价格**，显示「暂无价格」，不去别处找类似价格。
- **超分只显示先扣金额**，最终费用未知，不进合计（沿用 #56 的文案）。
- **不能保证花费不超过某个数**，也不记录用户当时确认的是多少钱。
- **只算画布上已有的节点**。分镜里还没准备成节点的行不算；助手先 `canvas.script.prepare` 生成草稿后再算即可。
- **价格跟上一次刷新目录时一致**，BeefAPI 改价后要等下一次刷新。

## 5. 实施前要核对的两点

1. 企业目录的 `model_name` 和 `/v1/models` 的模型 ID 是否一一对应（BeefAPI 用 `constant.ImageDefaultPriceKey` 查价，个别模型可能有别名）。对不上的模型显示「暂无价格」即可，不另做映射表。
2. 四款 Topaz 在目录里仍是 `per_request_cny = 27.1256`、`display_kind = image`，这是超分的先扣参考价，不是图片价。计算函数要按超分处理，不能当图片算进合计。

## 来源

- [C1] ComfyUI `comfy_api/latest/_io.py` 中的 `PriceBadge`／`PriceBadgeDepends`，提交 `426f5eea52a7ece1dd599fff4cb6cd1f352ddd24`；`comfy_api_nodes/` 下 300 处 `price_badge=`，结果类型统计：`usd` 235、`range_usd` 21、`text` 8。https://github.com/comfyanonymous/ComfyUI
- [C2] ComfyUI 前端 `src/systems/badgeSystem.ts`（`graphCreditsBadges`）、`src/renderer/extensions/linearMode/PartnerNodesList.vue`，提交 `10f8b084ded04435ff05fba589a1512068a1c2f8`。https://github.com/Comfy-Org/ComfyUI_frontend
- [C3] Comfy 文档「Account & credits」。https://docs.comfy.org/interface/credits
- [C4] Comfyui_API-utils README。https://github.com/njlent/Comfyui_API-utils
- [F1] Flora 更新「Dynamic Generation Costs」，2026-06-05。https://flora.ai/updates/shared-drives-smarter-fauna-dynamic-pricing-2026-06-05
- [F2] Flora 更新「Dollar Cost Display」，2026-05-21。https://florafauna.io/updates/export-to-drive-document-node-dollar-costs-2026-05-21
- [F3] FAUNA 文档，Assist 模式的确认流程。https://docs.flora.ai/editor/fauna
- [W1] Figma Weave Credit System。https://help.weavy.ai/en/articles/12267166-figma-weave-credit-system
- [P1] Freepik「Getting started with Spaces」。https://ru.freepik.com/ai/docs/getting-started-with-spaces
- [K1] Krea Node Agent 博客。https://www.krea.ai/blog/ai-workflow-agent
- [R1] Runway「Building and running Workflows with Agent」。https://help.runwayml.com/hc/en-us/articles/53645211363475-Building-and-running-Workflows-with-Agent
- [U1] Infinite Canvas `CHANGELOG.md` v0.0.8；提交 `2181b3b`（加入算力点）与 `9dd0dc2`（2026-07-05 删除节点面板的价格计算）。https://github.com/basketikun/infinite-canvas
- [U2] Infinite Canvas 当前提交 `9cd3deacbcc598361807afc16c059a80dd18b6f9`，`web/`、`canvas-agent/` 中没有价格相关代码。
- BeefAPI `e49bfcf325a1e5aa020b450828e04a6d066b1a36`：`controller/enterprise_workspace.go`（`GetEnterpriseCatalog`）、`controller/enterprise_prices.go`、`controller/model_video_capabilities.go`。
- BeefTV 基线 `4448543`：`backend/internal/beefapi/client.go`（`fetchModels`）、`catalog.go`、`catalog_refresh.go`；`backend/internal/operations/model_catalog.go`、`ops.go`；`web/src/lib/seedance-portrait.ts`、`web/src/pages/canvas/canvas-assistant-copy.ts`、`use-canvas-storyboard.ts`、`web/src/components/model-picker.tsx`。
