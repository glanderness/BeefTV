'use client';

import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';

import { SearchDialog } from '@/components/search';
import { siteI18n } from '@/lib/site';

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider search={{ SearchDialog }} i18n={siteI18n}>
      {children}
    </RootProvider>
  );
}