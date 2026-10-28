import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from 'fumadocs-ui/layouts/notebook/page';

import { getMDXComponents, createContentLink } from '@/components/mdx';
import { getPageImageUrl, getPageMarkdownUrl, source } from '@/lib/source';
import { site } from '@/lib/site';

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug ?? []);
  if (!page) notFound();

  const MDX = page.data.body;
  const ContentLink = createContentLink(source, page);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="docs-page-actions flex flex-wrap gap-3 items-center border-b pb-5">
        <MarkdownCopyButton markdownUrl={getPageMarkdownUrl(page).url} />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents({ a: ContentLink })} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug ?? []);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: `${site.docsOrigin}${page.url}` },
    openGraph: { images: getPageImageUrl(page).url },
  };
}