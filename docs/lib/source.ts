import { posix } from 'node:path';

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

/** 正文里的图片和媒体文件，交给 absolutizeAssets 处理，不参与文档链接解析 */
const assetPattern = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mp3|m4a)$/i;

/**
 * 把一页正文里的文档内链解析成线上绝对地址。
 *
 * 正文是给 GitHub 直接读的，链接写法很杂：./backend/http-api.mdx、裸 beeftv-cli.mdx、
 * ../backend/environment-check、/docs/backend/http-api#任务诊断。导出的 Markdown 和
 * llms 全文里必须都是能打开的地址，否则「复制 Markdown」拿到的链接全指向 404。
 */
function resolveDocLink(href: string, page: DocPage) {
  const [rawPath, anchor = ''] = href.split('#');
  const path = rawPath.split('?')[0];
  const suffix = anchor ? `#${anchor}` : '';

  if (!path) return null;
  // 站点根路径（/docs/...、/images/...、/content-assets/...）直接补域名
  if (path.startsWith('/')) return `${site.docsOrigin}${path}${suffix}`;
  if (assetPattern.test(path)) return null;

  const target = source.getPage(
    posix
      .normalize(posix.join('.', ...page.slugs.slice(0, -1), path.replace(/\.mdx?$/, '').replace(/\/index$/, '')))
      .split('/')
      .filter((segment) => segment && segment !== '.'),
  );
  if (!target) return null;

  return `${site.docsOrigin}${target.url}${suffix}`;
}

function absolutizeDocLinks(markdown: string, page: DocPage) {
  return markdown.replace(/(\]\()([^)\s]+)(\))/g, (whole, open, href, close) => {
    // 外链（https://、mailto: 等）和页内锚点保持原样
    if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return whole;
    const url = resolveDocLink(href, page);
    return url ? `${open}${url}${close}` : whole;
  });
}

export async function getLLMText(page: DocPage) {
  // 用 raw 原文导出，避免图片被编译成 __img0 之类的占位符
  const raw = await page.data.getText('raw');
  const body = absolutizeDocLinks(
    absolutizeAssets(raw.replace(/^---[\s\S]*?---\s*/, '').replace(/^# .+\n+/, '')),
    page,
  );

  return `# ${page.data.title} (${site.docsOrigin}${page.url})\n\n${body}`;
}