import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import type { LoaderConfig, LoaderOutput, Page } from 'fumadocs-core/source';

import { GuideTable } from '@/components/guide-table';
import { contentAssetUrl, isRepoAsset } from '@/lib/content-assets';

const protocolLike = /^[a-z][a-z0-9+.-]*:/i;

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // 正文里的仓库素材引用（../../../../assets/...）要改指向构建产物里的副本
    img: MdxImage,
    table: GuideTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

/**
 * 正文里的图片有两类来源：
 * - 仓库内的截图（mdx 里写成 ../../../../assets/readme/x.png），构建时被复制到 public/content-assets/
 * - docs/public 下的站内图片（写成 /images/x.png），原样输出即可
 */
function MdxImage({ src, alt, ...props }: ComponentProps<'img'>) {
  const resolved = typeof src === 'string' && isRepoAsset(src) ? contentAssetUrl(src) : src;

  return <img src={resolved} alt={alt ?? ''} loading="lazy" {...props} />;
}

/**
 * 正文里的链接：
 * - 指向仓库素材文件（例如 assets/readme/CAPTURE.md、assets/readme/x.mp3）的路径改指向站点副本
 * - 相对的 .mdx / 目录路径解析成站内页面地址，兼容 ./x.mdx、./x、../backend/x 这类写法
 * - 站内绝对路径（/docs/...）、外链和锚点沿用默认链接组件
 */
export function createContentLink<C extends LoaderConfig>(source: LoaderOutput<C>, page: Page) {
  const DefaultLink = defaultMdxComponents.a;

  return function ContentLink({ href, ...props }: ComponentProps<'a'>) {
    if (typeof href !== 'string') return <DefaultLink href={href} {...props} />;
    if (isRepoAsset(href)) return <a href={contentAssetUrl(href)} {...props} />;

    return <DefaultLink href={resolvePageHref(href)} {...props} />;
  };

  function resolvePageHref(href: string) {
    if (href.startsWith('/') || href.startsWith('#') || protocolLike.test(href)) return href;

    const [path, hash] = href.split('#', 2);
    const slugs: string[] = [];

    for (const segment of `${dirOf(page.path)}/${path}`.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        slugs.pop();
        continue;
      }
      slugs.push(segment);
    }

    const last = slugs.at(-1) ?? '';
    if (last.endsWith('.mdx')) slugs[slugs.length - 1] = last.slice(0, -'.mdx'.length);
    else if (last.endsWith('.md')) return href; // 仓库内的普通 markdown 不发布
    if (slugs.at(-1) === 'index') slugs.pop();

    const target = source.getPage(slugs);
    if (!target) return href;

    return hash ? `${target.url}#${hash}` : target.url;
  }
}

function dirOf(path: string) {
  const index = path.lastIndexOf('/');

  return index === -1 ? '' : path.slice(0, index);
}

export const mdxComponents = {
  img: MdxImage,
} satisfies MDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}