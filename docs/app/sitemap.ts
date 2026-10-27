import type { MetadataRoute } from 'next';

import { source } from '@/lib/source';
import { site } from '@/lib/site';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${site.docsOrigin}/` },
    ...source.getPages().map((page) => ({ url: `${site.docsOrigin}${page.url}` })),
  ];
}