import { DocsLayout } from 'fumadocs-ui/layouts/notebook';

import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';
import { site } from '@/lib/site';

export default function Layout({ children }: { children: React.ReactNode }) {
  const options = baseOptions();

  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...options}
      nav={{ ...options.nav, mode: 'top' }}
      sidebar={{
        collapsible: false,
        footer: (
          <nav className="md:hidden grid gap-3 pt-3 text-sm" aria-label="站点链接">
            {site.navLinks.map((link) => (
              <a key={link.url} href={link.url}>
                {link.text} ↗
              </a>
            ))}
          </nav>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}