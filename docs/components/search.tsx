'use client';

import {
  SearchDialog as SearchDialogRoot,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { staticClient } from 'fumadocs-core/search/client/orama-static';
import { useI18n } from 'fumadocs-ui/contexts/i18n';

/**
 * 站点静态导出，搜索索引是构建时生成好的 JSON（app/api/search）。
 * 默认就从 /api/search 取；localStorage 只用来记住最近查询，不额外配后端。
 */
export function SearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const { search, setSearch, query } = useDocsSearch({
    client: staticClient({ locale }),
  });

  return (
    <SearchDialogRoot search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      </SearchDialogContent>
    </SearchDialogRoot>
  );
}