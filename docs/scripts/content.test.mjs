import { test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const contentDir = 'content/docs';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(contentDir);
const pages = files.filter((file) => file.endsWith('.mdx'));

test('每一页都有 frontmatter title', () => {
  expect(pages.length).toBeGreaterThanOrEqual(22);
  for (const file of pages) {
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('---')).toBe(true);
    expect(text.match(/^title:\s*\S+/m)).not.toBeNull();
  }
});

test('页面不出现内部品牌、域名和渠道取值', () => {
  for (const file of pages) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    expect(text).not.toContain('beefapi');
    expect(text).not.toContain('enterprise.beefapi');
    expect(text).not.toContain('global.beefapi');
  }
});

test('meta.json 里的每一项都指向真实存在的页面或目录', () => {
  const metas = files.filter((file) => file.endsWith('meta.json'));
  expect(metas.length).toBeGreaterThanOrEqual(4);

  for (const file of metas) {
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    const dir = file.slice(0, file.lastIndexOf('/'));
    for (const entry of meta.pages ?? []) {
      if (/^---.*---$/.test(entry)) continue;
      const target = join(dir, entry);
      expect(existsSync(`${target}.mdx`) || existsSync(target) || existsSync(join(target, 'index.mdx'))).toBe(
        true,
      );
    }
  }
});

test('站内链接与站内图片都能落到真实文件', () => {
  for (const file of pages) {
    const text = readFileSync(file, 'utf8');

    for (const [, url] of text.matchAll(/\]\((\/docs[^)\s]*)\)/g)) {
      const slug = url.split('#')[0].replace(/^\/docs\/?/, '').replace(/\/$/, '');
      const base = join(contentDir, slug);
      expect(
        slug === ''
          ? existsSync(join(contentDir, 'index.mdx'))
          : existsSync(`${base}.mdx`) || existsSync(join(base, 'index.mdx')),
        `${file}: ${url}`,
      ).toBe(true);
    }

    for (const [, url] of text.matchAll(/\]\((\/images\/[^)\s]*)\)/g)) {
      expect(existsSync(join('public', url.replace(/^\//, ''))), `${file}: ${url}`).toBe(true);
    }
  }
});