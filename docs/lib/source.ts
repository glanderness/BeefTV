import { loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

import { docsContentRoute, docsImageRoute, docsRoute } from './shared';
import { site } from './site';

/**
 * 内容源就是仓库里的 docs/content/docs，不再生成第二份。
 * includeProcessedMarkdown 让每页都能导出 Markdown 原文（复制按钮 / llms）。
 */
const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: metaSchema },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
});

type DocPage = (typeof source)['$inferPage'];

export function getPageImageUrl(page: DocPage) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: '/' + [page.locale, ...docsImageRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export function getPageMarkdownUrl(page: DocPage) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: '/' + [page.locale, ...docsContentRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

/** 仓库内的截图在站点上是 /content-assets/<文件名>，正文里的相对路径要换成绝对地址 */
function absolutizeAssets(markdown: string) {
  return markdown
    .replace(/\]\((?:\.\.\/)+assets\/[^)]*?\/([^/)]+)\)/g, `](${site.docsOrigin}/content-assets/$1)`)
    .replace(/\]\(\/images\//g, `](${site.docsOrigin}/images/`);
}

export async function getLLMText(page: DocPage) {
  // 用 raw 原文导出，避免图片被编译成 __img0 之类的占位符
  const raw = await page.data.getText('raw');
  const body = absolutizeAssets(raw.replace(/^---[\s\S]*?---\s*/, '').replace(/^# .+\n+/, ''));

  return `# ${page.data.title} (${site.docsOrigin}${page.url})\n\n${body}`;
}