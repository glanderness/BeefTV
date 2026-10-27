# 文档站本地验证（2026-10-27）

文档站按 BeefAPI `docs-site/` 的结构搭：Fumadocs + Next.js 静态导出，`bun run preview` 在 `http://127.0.0.1:35407` 提供 `out/`。以下截图来自本地构建产物，不是线上页面——**域名 `docs.beeftv.app` 尚未部署**。

构建与检查：

- `cd docs && bun run build` → 25 个 html（站点首页、`/docs`、22 篇文档、404 与兜底页），静态导出共 74 个路由产物；`docs/out/` 约 18 MB（正文截图副本 3.7 MB、搜索索引 3.1 MB、社交卡片 1.1 MB）
- `cd docs && bun run test` → 11 个用例全过（内容校验 4 个 + 产物断言 7 个）
- `cd docs && bun run types:check` → 通过（`next typegen && tsc --noEmit`）
- 全站抓取：23 个页面全部 200、每页恰好一个 h1；60 个站内链接与页内资源全部命中产物，0 个死链
- 案例页 14 张仓库截图逐张滚入视口后全部加载（`naturalWidth > 0`），无破图；工作流小节原来那张带内部渠道标识的编辑器截图已从页面移除
- `wrangler dev --local`（Wrangler 4.129.0，`compatibility_date: 2026-09-07`）在 `http://127.0.0.1:35412` 起得来：60 个站内地址全部 200，导出的 Markdown 里 40 个 `docs.beeftv.app` 地址无一 404，`/content-assets/beeftv-character-workflow-editor.png` 返回 404（该图已不进产物）

## 截图

| 文件 | 内容 |
| --- | --- |
| `01-home-light.png` | 站点首页（浅色）：产品介绍、四个入口 |
| `02-docs-index-light.png` | 文档首页：左侧目录树、「复制 Markdown」、正文内链 |
| `03-cli-page-light.png` | 命令行手册（浅色）：面包屑、页头、右侧 16 条本页目录、3 个宽表格 |
| `04-cli-page-dark.png` | 同一页暗色主题：表格与行内代码可读 |
| `05-examples-page.png` | 案例页：仓库截图经 `content-assets` 正常显示，表格不错位 |
| `05-examples-workflow.png` | 案例页「工作流：单人物替换」小节：原截图位置改为节点配置表格 |
| `06-search-chinese.png` | 搜索「命令行」：静态索引下的中文分词命中，带分类与上下文摘要 |
| `07-sidebar-nav.png` | 点侧栏「插件」分组跳到插件系统页，当前项高亮 |
| `08-404-page.png` | 未知地址的中文 404，含「返回文档首页」 |
| `09-mobile-cli.png` | 390 px 宽视口：目录收进抽屉，正文不横向溢出（`scrollWidth 390 / innerWidth 390`），宽表格给出「左右滑动查看更多列」提示 |

搜索是点第一条结果跳转验证的（`/docs/backend/beeftv-cli`）。正文里的相对链接（`./environment-check`、`../backend/http-api` 等）在构建时解析成 `/docs/...` 真实地址，抓取阶段全部命中。

导出的 Markdown（每页 `content.md` 与 `llms-full.txt`）做了同样的解析：源码里的 `./backend/beeftv-cli.mdx`、裸 `beeftv-cli.mdx`、`../backend/http-api#任务诊断` 都变成 `https://docs.beeftv.app/docs/...` 绝对地址，截图变成 `https://docs.beeftv.app/content-assets/...`。`site.test.mjs` 会把这两类地址逐个映射回 `out/` 下的文件，有一个不存在就失败。

## 复现

```bash
cd docs
bun install
bun run build
bun run test
bun run preview                    # http://127.0.0.1:35407
bunx wrangler dev --local           # http://127.0.0.1:35412，验证 Workers 静态托管
```