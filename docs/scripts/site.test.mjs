import { test, expect, beforeAll } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { staticClient } from 'fumadocs-core/search/client/orama-static';

// 这些断言跑在构建产物上：先 `bun run build`，再 `bun run test`。
const out = 'out';

beforeAll(() => {
  if (!existsSync(join(out, 'docs.html'))) {
    throw new Error('缺少构建产物：先运行 bun run build');
  }
});

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

const htmlFiles = walk(out).filter((file) => file.endsWith('.html') && !file.includes('_not-found'));

function visible(html) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ');
}

test('首页和每一页文档都导出了，且每页只有一个一级标题', () => {
  expect(existsSync(join(out, 'index.html'))).toBe(true);
  expect(existsSync(join(out, 'docs.html'))).toBe(true);

  const pages = htmlFiles.filter((file) => file.includes('/docs'));
  expect(pages.length).toBeGreaterThanOrEqual(22);

  for (const file of htmlFiles) {
    const h1 = readFileSync(file, 'utf8').match(/<h1\b/g) ?? [];
    expect(h1, `${file} 有 ${h1.length} 个 h1`).toHaveLength(1);
  }
});

test('产物里不残留内部品牌，资源路径不带子路径前缀', () => {
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    expect(html.toLowerCase()).not.toContain('beefapi');
    expect(html).not.toContain('"/docs/_next/');
  }
  expect(readFileSync(join(out, 'docs.html'), 'utf8')).toContain('href="/_next/');
});

test('404 页面是中文并指回文档首页', () => {
  const notFound = visible(readFileSync(join(out, '404.html'), 'utf8'));
  expect(notFound).toContain('没有这个页面');
  expect(notFound).toContain('返回文档首页');
  expect(readFileSync(join(out, '404.html'), 'utf8')).toContain('href="/docs"');
});

test('sitemap 和 llms.txt 指向正式域名', () => {
  const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  expect(sitemap).toContain('https://docs.beeftv.app/docs/backend/beeftv-cli');

  const llms = readFileSync(join(out, 'llms.txt'), 'utf8');
  expect(llms).toContain('https://docs.beeftv.app/docs');

  const full = readFileSync(join(out, 'llms-full.txt'), 'utf8');
  expect(full).toContain('# ');
  expect(full).toContain('https://docs.beeftv.app/content-assets/');
});

test('每页都导出 Markdown 原文和社交卡片', () => {
  const markdown = join(out, 'llms.mdx/docs/backend/beeftv-cli/content.md');
  expect(existsSync(markdown)).toBe(true);
  expect(readFileSync(markdown, 'utf8')).toContain('beeftv');

  expect(existsSync(join(out, 'og/docs/backend/beeftv-cli/image.png'))).toBe(true);
  expect(existsSync(join(out, 'og/docs/image.png'))).toBe(true);
});

/** 导出的地址要能落回产物文件：/docs/x → out/docs/x.html，/content-assets/x.png → out/content-assets/x.png */
function outputPathFor(url) {
  let pathname = url.replace('https://docs.beeftv.app', '').split('#')[0].split('?')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // 保留原样，下面按文件不存在报错
  }
  const clean = pathname.replace(/\/$/, '').replace(/^\//, '');
  if (!clean) return join(out, 'index.html');
  return /\.\w+$/.test(clean) ? join(out, clean) : join(out, `${clean}.html`);
}

test('导出的 Markdown 里站内链接和素材都指向真实产物', () => {
  const exported = [
    ...walk(join(out, 'llms.mdx')).filter((file) => file.endsWith('content.md')),
    join(out, 'llms-full.txt'),
  ];
  expect(exported.length).toBeGreaterThanOrEqual(23);

  const targets = new Set();
  for (const file of exported) {
    const text = readFileSync(file, 'utf8');
    // 源码里的相对链接（./backend/x.mdx、裸 y.mdx、../backend/z）必须已经被解析掉
    expect(text, `${file} 还留着源码相对链接`).not.toMatch(/\]\((?!https?:|mailto:|\/|#)[^)\s]+\.mdx?\)/);

    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (href.startsWith('https://docs.beeftv.app/')) {
        expect(existsSync(outputPathFor(href)), `${file}: ${href} 没有对应产物`).toBe(true);
        targets.add(href.split('#')[0]);
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
        throw new Error(`${file}: 站内引用没有转成绝对地址 ${href}`);
      }
    }
  }

  // 页面链接和素材都要覆盖到，避免只转了一半
  expect([...targets].some((url) => url.includes('/docs/'))).toBe(true);
  expect([...targets].some((url) => url.includes('/content-assets/'))).toBe(true);
});

test('导出的搜索索引支持中文检索', async () => {
  const raw = readFileSync(join(out, 'api/search'), 'utf8');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(raw, { status: 200 });

  try {
    const client = staticClient({ from: 'https://docs-test.invalid/api/search', locale: 'zh-CN' });
    for (const [query, expected] of [
      ['命令行', '/docs/backend/beeftv-cli'],
      ['素材', '/docs/overview/features'],
      ['插件', '/docs/plugins/plugin-system'],
    ]) {
      const results = await client.search(query);
      expect(
        results.some((item) => item.url.split('#')[0] === expected),
        `搜索「${query}」没有命中 ${expected}`,
      ).toBe(true);
    }
    expect(await client.search('zzzznoexistingdocumentzzzz')).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});