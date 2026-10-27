# BeefTV 文档站

把仓库里的 `docs/content/docs/` 发布成一个独立文档站：Fumadocs + Next.js 静态导出，产物是一组 html 文件，托管在 Cloudflare Workers 上，域名规划为 `https://docs.beeftv.app`。

内容只有一个源，就在 `docs/content/docs/`。文档站不复制、不生成第二份正文；正文里的截图仍按仓库相对路径引用 `assets/readme/`，构建前复制到 `public/content-assets/`（生成目录，不提交）。

## 与 BeefAPI `docs-site/` 的关系

这套工程是从 BeefAPI 仓库（`Sunnyender-org/beefapi`，分支 `codex-enhance`）的 `docs-site/` 复制改造的，目录结构、依赖版本、构建方式、搜索与 llms/sitemap/404 的写法都保持一致。

复制过来、结构保留的部分：

| 文件 | 说明 |
| --- | --- |
| `next.config.mjs` | `output: 'export'`、`images.unoptimized`、`createMDX()` |
| `package.json`、`bun.lock` | 依赖名与版本对齐，用 Bun 安装（见下方差异） |
| `lib/site.ts` | 站点常量与界面文案表 |
| `lib/source.ts` | `defineDocs('content/docs')` + `loader`，`includeProcessedMarkdown` |
| `lib/shared.ts`、`lib/layout.shared.tsx` | 路由常量、顶栏与导航 |
| `app/layout.tsx`、`app/(home)/*`、`app/docs/*` | 首页 / 文档页布局，`DocsLayout` 用 notebook 布局 |
| `app/api/search/route.ts` | 静态搜索索引（`staticGET`） |
| `app/llms.txt`、`app/llms-full.txt`、`app/llms.mdx/*` | 给模型的目录、全文和每页 Markdown 原文 |
| `app/sitemap.ts`、`app/robots.ts`、`app/not-found.tsx` | 站点地图、robots、中文 404 |
| `components/provider.tsx`、`components/search.tsx` | `RootProvider` + 静态搜索对话框 |
| `components/guide-table.tsx` | 宽表格横向滚动与键盘操作 |
| `public/_headers`、`public/_redirects` | Workers 静态托管用的响应头与重定向 |
| `wrangler.jsonc` | Workers 静态托管配置 |

改掉的部分：

- **只有一套站点，没有双市场**：BeefAPI 用同一套代码构建海外与企业两站（`DOCS_MARKET`），BeefTV 只有一站，所以删掉了 `docsMarket`/`isEnterpriseDocs` 分支、`wrangler.enterprise.jsonc`，以及 `prepare-content.mjs` 里的双语内容生成。
- **托管方式**：原方案是 `basePath: '/docs'` 挂官网子路径，现改为独立子域 + Workers 静态托管，`basePath` 和所有 `/docs` 前缀相关逻辑（`stripBasePath`、`siteAssetUrl`、自写的静态预览服务器）全部删掉。
- **内容源**：BeefAPI 从 `web/src/data/*-docs-md` 和 `openapi.json` 生成内容；BeefTV 直接读 `docs/content/docs`，`prepare-content.mjs` 改成「复制素材 + 内容校验」，不再生成 mdx。
- **没有 API 参考页**：删掉了 `fumadocs-openapi`、`@fumadocs/api-docs`、`components/api-reference.tsx`、`parameter-table.tsx`、`response-example-body.tsx`、`lib/openapi.ts`、`lib/api-presentation.ts`、`lib/code-usages.ts` 及其测试，也没有 `public/openapi.json`。
- **品牌与文案**：站名、域名、导航、`llms.txt` 链接全部换成 BeefTV 与 `docs.beeftv.app`；正文里原来出现 BeefAPI 的地方（渠道名、企业连接、内部字段取值）改成中性表述或删掉取值，页面上不出现内部品牌、域名和渠道数。
- **依赖版本**：BeefAPI 里用 `^` 范围版本的依赖在本仓库全部写死具体版本。

新增的部分（BeefAPI 里没有）：

- `lib/remark-drop-leading-h1.mjs`：内容源里的 mdx 正文开头有一行 `# 标题`（方便在 GitHub 上直接读），文档站页面标题由 frontmatter 渲染，编译时摘掉重复的那行。
- `lib/content-assets.ts` + `components/mdx.tsx`：把正文里的 `../../../../assets/readme/x.png` 改指向 `/content-assets/x.png`，并把相对的 `.mdx` / 目录链接解析成站内页面地址。
- `scripts/prepare-content.mjs`：复制被引用的仓库素材，并校验 frontmatter、`meta.json`、站内链接与站内图片。
- `scripts/content.test.mjs`、`scripts/site.test.mjs`：内容与产物校验（见下）。

## 本地命令

```bash
cd docs
bun install
bun run build          # prepare:content + next build，产物在 docs/out/
bun run preview        # http://127.0.0.1:35407
bun run dev            # http://127.0.0.1:35407，热更新
bun run types:check    # next typegen && tsc --noEmit
bun run test           # bun test scripts（含产物断言，需先 build）
```

`bun run test` 分两部分：`content.test.mjs` 只看内容源（不需要构建），`site.test.mjs` 断言 `out/` 的产物（页面数量、每页一个 h1、没有内部品牌、404 文案、sitemap 与 llms 域名、每页 Markdown 与社交卡片、中文搜索命中）。

## 产物结构

`docs/out/` 主要目录：

| 路径 | 内容 |
| --- | --- |
| `index.html` | 站点首页 |
| `docs.html`、`docs/**/*.html` | 文档页（`/docs` 与 `/docs/<分类>/<页面>`） |
| `api/search` | 静态搜索索引（2.7 MB，构建时算好） |
| `llms.txt`、`llms-full.txt`、`llms.mdx/**` | 给模型的目录、全文与每页 Markdown |
| `og/docs/**/image.png` | 每页社交卡片（23 张，1.1 MB） |
| `content-assets/` | 从 `assets/readme/` 复制的正文截图（约 3.3 MB） |
| `_next/` | JS/CSS 等静态资源 |
| `404.html` | 未知路径的兜底页 |
| `_headers`、`_redirects` | Workers 静态托管的响应头与重定向 |

## 部署到 Cloudflare Workers（下一步，本轮未执行）

这一步会写入线上环境并绑定域名，所以需要在动手前确认。前置条件：Cloudflare 账号已开通 Workers，`beeftv.app` 的 DNS 托管在同一个账号下（自定义域要求如此）。

1. 构建并本地核对：`cd docs && bun run build && bun run test`，`bun run preview` 点一遍首页、文档页、搜索和 404。
2. 登录 Cloudflare：`cd docs && bunx wrangler login`（或在 CI 里用 `CLOUDFLARE_API_TOKEN`）。
3. 首次部署：`cd docs && bunx wrangler deploy`。`wrangler.jsonc` 里 `assets.directory` 指向 `./out`，`not_found_handling` 为 `404-page`，所以未知路径用 `404.html` 兜底。
4. 接域名：`wrangler.jsonc` 已经声明 `routes: [{ pattern: "docs.beeftv.app", custom_domain: true }]`，部署时 Cloudflare 会为这个子域自动建 DNS 记录并签证书，不需要在官网仓库或服务器上改任何东西。若先不接域名，把 `routes` 整段删掉，用 `workers_dev` 给的 `*.workers.dev` 地址先看效果。
5. 上线后核对：`/`、`/docs`、一个具体页面、`/llms.txt`、`/sitemap.xml`、`/api/search`、一个不存在的路径（应返回 404 页面）。
6. 官网只需在 `Beeftv-website` 加一个指向 `https://docs.beeftv.app` 的链接；不需要子路径反代，也不需要改官网构建。

回滚：`bunx wrangler deployments list` 看历史版本，`bunx wrangler rollback <version-id>` 回到上一个完整版本。不要先删自定义域。

持续部署（可选，留给下一步）：可以照 BeefAPI 的做法加一个 GitHub Actions 工作流，在 `docs/**` 变更时 `bun install --frozen-lockfile && bun run build && bun run test`，把 `docs/out` 作为 artifact 上传，再用 `wrangler deploy` 发布。本轮没有加工作流，避免动到现有 CI 的触发范围。

## 内容规则

- 新增页面：在 `content/docs/<分类>/` 下建 `.mdx`，frontmatter 写 `title`（建议同时写 `description`），并把文件名加进同目录 `meta.json` 的 `pages`。
- 图片：优先写 markdown 图片语法。仓库内的截图用相对路径 `../../../../assets/readme/x.png`（GitHub 和站点都能显示）；站内图片放 `public/images/`，用 `/images/x.png` 引用。
- 站内链接：可以写 `/docs/backend/http-api`，也可以写相对路径 `./http-api.mdx`、`../backend/environment-check`，构建时都会解析成真实页面地址。
- 页面是给外部用户看的：不写内部供应商名称、渠道 ID、内部字段取值和内部仓库路径。仓库内未发布的说明（`docs/refactor/` 等）要用绝对 GitHub 链接引用。
- `bun run build` 会在 `prepare:content` 阶段校验 frontmatter、`meta.json` 条目、站内链接与站内图片，缺失会直接失败，不会带着坏链接发出去。

## 已知事项

- `scripts/audit-public-docs.sh` 目前仍会因 `docs/superpowers/` 失败，这个问题在本次改动之前就存在（`main` 上同样有这 11 个文件，与本工程无关）。本次让它跳过 `docs/node_modules`、`docs/.next`、`docs/.source` 和 `docs/out`（构建产物不是仓库文档），脚本里的链接检查部分单独跑是通过的：`public documentation audit passed (161 files)`。
- 公开仓库不托管 PR artifact，`docs/**` 的改动只在本地构建验证，产物不入库。