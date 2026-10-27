# BeefTV 用户可见官网与公开文档清理记录

核对日期：2026-10-27

## 结论

本轮完成了官网公共文案和帮助页的两处真实问题修正，并把文档站现状、不能提前改的链接和保留的后端地址记录在这里。没有部署、没有改线上账号、支付或下载服务。

文档站 PR [#285](https://github.com/glanderness/BeefTV/pull/285) 已通过独立复查，但截至本记录仍未合并、未部署；因此官网本轮没有加入尚未可访问的 `docs.beeftv.app` 链接。

## 官网仓库改动

仓库：`Sunnyender-org/BeefTV-website`

工作树：`/Volumes/ExternalWork/Worktrees/BeefTV-website/visible-docs-20261027`

分支：`task/visible-docs-20261027`

提交：`2321b9e1d0582b419b377a0614a9f339235a0445`

文件：

- `dist/index.html`
  - 搜索摘要和 Open Graph 描述从“开源”改为“源码可用”，不再把当前许可说成标准开源。
  - GitHub 无障碍标签改为“源码仓库”。
  - “开始接入 API”改为“进入账户中心”，与按钮实际打开的页面一致。
  - 页脚的“MIT License”改为“许可说明”，链接到 BeefTV 的许可说明页。
- `dist/help/index.html`
  - 修正 macOS 安装说明：DMG 直接打开并拖入“应用程序”，只有 ZIP 需要先解压。
  - 补充 Linux DEB 安装说明。

实际下载地址仍保留现有更新源；这是运行中的下载合同，不把真实请求地址改成猜测的新域名。

## 文档站核对

来源：BeefTV 文档站 PR #285 的分支提交 `651bcaae` 及其独立复查记录。

已核对的结果：

- 内容源仍是 `docs/content/docs`，没有复制第二份专题内容。
- 文档站的页面正文已移除公开页面里的内部品牌、渠道取值和含内部标识的工作流截图；截图重新写回时会被构建校验拦截。
- 每页 Markdown 和 `llms-full.txt` 的站内链接已转换为 `https://docs.beeftv.app/docs/...` 绝对地址，并有产物检查。
- 固定 Wrangler 版本可以按提交的兼容日期启动本地静态预览。
- 独立复查报告为通过；站点仍未部署，不能把文档域名写成已上线入口。

维护者说明和证据文件仍可提到 BeefAPI 作为实现来源；这不属于面向普通使用者的页面文案。下载链接中的现有更新源域名也未改动，因为它是实际传输地址，不是展示名称。

## 验证

官网分支运行：

```text
bun run test
71 tests passed
```

另外通过 `git diff --check`，并检查官网公开 HTML：没有残留“开源”“MIT License”或“开始接入 API”这些旧展示文字；更新源 URL 保留为现有下载合同。

## 未做事项

- 未合并或部署文档站 PR #285。
- 未向官网写入尚未上线的 `docs.beeftv.app` 链接。
- 未更换更新源、API、账号、支付、余额或服务器。
- 未直接发布外部帖子、群消息或生产配置。
