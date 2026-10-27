import { notFound } from 'next/navigation';

import { getLLMText, getPageMarkdownUrl, source } from '@/lib/source';

export const revalidate = false;

/** 每页的 Markdown 原文：/llms.mdx/docs/<slug>/content.md */
export async function GET(_req: Request, { params }: RouteContext<'/llms.mdx/docs/[[...slug]]'>) {
  const { slug } = await params;
  // 末尾的 content.md 不是页面 slug 的一部分
  const page = source.getPage(slug?.slice(0, -1) ?? []);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: getPageMarkdownUrl(page).segments }));
}