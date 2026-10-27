import { createFromSource } from 'fumadocs-core/search/server';

import { source } from '@/lib/source';

// 静态导出：索引在构建时算好，浏览器直接取 /api/search 这份 JSON。
// multilingual 分词覆盖中文，浏览器端用同一套分词（orama-static），不依赖服务端。
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, { language: 'multilingual' });