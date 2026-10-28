import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Provider } from '@/components/provider';
import { site } from '@/lib/site';

import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.docsOrigin),
  title: site.title,
  description: site.description,
  icons: { icon: '/beef-icon.svg' },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang={site.lang} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}