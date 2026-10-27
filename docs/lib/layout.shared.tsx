import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import { site } from './site';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="brand">
          <img src="/beef-icon.svg" alt="" width={26} height={26} />
          <strong>BeefTV</strong>
          <span className="brand-label">{site.brandLabel}</span>
        </span>
      ),
      url: '/docs',
    },
    githubUrl: 'https://github.com/glanderness/BeefTV',
    searchToggle: { full: { 'aria-label': site.searchLabel } },
    links: site.navLinks.map((link, index) => ({
      text: link.text,
      url: link.url,
      external: true,
      on: 'nav' as const,
      ...(index === site.navLinks.length - 1 ? { type: 'button' as const } : {}),
    })),
  };
}