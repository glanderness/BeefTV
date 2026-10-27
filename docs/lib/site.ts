/**
 * 站点常量与界面文案。
 *
 * 站点是独立域名（docs.beeftv.app），不挂官网子路径；官网只放一个链接。
 * 内容里引用站内资源一律写根路径（/images/...、/content-assets/...），不需要前缀。
 */
export const site = {
  lang: 'zh-CN',
  docsOrigin: 'https://docs.beeftv.app',
  productOrigin: 'https://beeftv.app',
  title: {
    default: 'BeefTV 文档',
    template: '%s · BeefTV 文档',
  },
  description: 'BeefTV 视频工作台的使用、开发与插件文档。',
  brandLabel: '文档',
  searchLabel: '搜索文档',
  navLinks: [
    { text: '官网', url: 'https://beeftv.app' },
    { text: '下载 BeefTV', url: 'https://beeftv.app/#download' },
  ],
  home: {
    eyebrow: 'BEEFTV 文档',
    title: ['从第一次安装，', '到第一个成片。'],
    lede: 'BeefTV 是本地优先的视频工作台：画布、素材和任务都留在你自己的电脑上，需要时再接自己的模型服务。',
    start: '开始阅读',
    guides: [
      { href: '/docs/overview/features', label: '已实现的功能清单' },
      { href: '/docs/overview/examples', label: 'Agent、Skills 与工作流案例' },
      { href: '/docs/backend/beeftv-cli', label: 'beeftv 命令行工具' },
      { href: '/docs/backend/local-development', label: '本地开发与调试' },
    ],
  },
};

/**
 * 界面文案统一用中文。
 * @fumadocs/base-ui 的 key 带上组件名（以及 aria-label 备注），所以这里按它的写法列。
 */
export const siteI18n = {
  locale: 'zh-CN',
  translations: {
    'Search(search trigger)': '搜索',
    'Open Search(search trigger)(aria-label)': '打开搜索',
    'Search(search dialog)': '搜索',
    'Close Search(search dialog)(aria-label)': '关闭搜索',
    'No results found(search dialog)': '没有找到相关文档',
    'Copy Markdown(page actions)': '复制 Markdown',
    'Copy Anchor Link(heading anchor)(aria-label)': '复制章节链接',
    'Copy Text(code block)(aria-label)': '复制代码',
    'Copied Text(code block)(aria-label)': '已复制',
    'On this page(table of contents)': '本页内容',
    'No Headings(table of contents)': '本页没有目录',
    'Previous Page(pagination)': '上一篇',
    'Next Page(pagination)': '下一篇',
    'Last updated on(page footer)': '更新于',
    'Edit on GitHub(edit page)': '在 GitHub 编辑',
    'Light(theme switcher)(aria-label)': '浅色',
    'Dark(theme switcher)(aria-label)': '深色',
    'System(theme switcher)(aria-label)': '跟随系统',
    'Toggle Theme(theme switcher)(aria-label)': '切换主题',
    'Choose a language(language switcher)': '选择语言',
    'Choose a language(language switcher)(aria-label)': '选择语言',
    'Open Sidebar(sidebar)(aria-label)': '打开文档目录',
    'Close Sidebar(sidebar)(aria-label)': '关闭文档目录',
    'Collapse Sidebar(sidebar)(aria-label)': '收起文档目录',
    'Toggle Menu(home layout header)(aria-label)': '打开或关闭菜单',
  },
};