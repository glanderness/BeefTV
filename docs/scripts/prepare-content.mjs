#!/usr/bin/env node
/**
 * 构建前的准备与校验：内容源只有一份（docs/content/docs），这里只做三件事。
 *
 * 1. 复制正文引用的仓库素材。mdx 里按仓库相对路径引用截图（例如
 *    ../../../../assets/readme/x.png），这样在 GitHub 上直接读源码也能看到图；
 *    静态站只能提供 public/ 下的文件，所以构建前把被引用的文件复制到
 *    public/content-assets/（生成目录，已忽略，素材只有一份源文件）。
 * 2. 校验每一页都有 frontmatter title；meta.json 里的 pages 都指向真实存在的页面。
 * 3. 校验站内链接（/docs/...）和站内图片（/images/...）都有对应文件。
 *
 * 任何一条不通过就退出码 1，避免把坏链接发到线上。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = join(projectRoot, 'content', 'docs');
const publicDir = join(projectRoot, 'public');
const outputDir = join(publicDir, 'content-assets');

// markdown 链接与图片里指向仓库 assets/ 的相对路径（外部链接如 GitHub 绝对地址不算）
const assetPattern = /\]\((?!https?:|\/)([^)\s]*assets\/[^)\s]+)\)/g;
// 站内页面链接，例如 /docs/backend/http-api#锚点
const pageLinkPattern = /\]\((\/docs[^)\s]*)\)/g;
// 站内图片，例如 /images/canvas-version-history.png
const siteImagePattern = /\]\((\/images\/[^)\s]+)\)/g;

/**
 * 这些截图里仍带着内部渠道标识（模型选择器显示内部品牌），不能出现在公开页面上。
 * 原来用于案例页工作流小节，已改用正文表格说明；谁再把它们写回 mdx，构建直接失败。
 */
const blockedAssets = new Set(['beeftv-character-workflow-editor.png']);

const errors = [];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
      }),
  );
}

/** /docs/a/b → content/docs/a/b.mdx 或 content/docs/a/b/index.mdx */
function pageExists(url) {
  const clean = url.split('#')[0].split('?')[0];
  const slug = clean.replace(/^\/docs\/?/, '').replace(/\/$/, '');
  const base = join(contentDir, slug);
  if (slug === '') return existsSync(join(contentDir, 'index.mdx'));
  return ['', '.mdx'].some((suffix) =>
    existsSync(suffix === '' ? join(base, 'index.mdx') : `${base}${suffix}`),
  );
}

function checkMetaJson(file) {
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  const dir = dirname(file);
  for (const entry of meta.pages ?? []) {
    if (typeof entry !== 'string' || /^---.*---$/.test(entry)) continue;
    const target = join(dir, entry);
    if (!existsSync(`${target}.mdx`) && !existsSync(target)) {
      errors.push(`${relative(projectRoot, file)}: pages 里的 ${entry} 没有对应文件`);
    }
  }
}

function main() {
  rmSync(outputDir, { recursive: true, force: true });

  const copied = new Map();
  let pages = 0;

  for (const file of walk(contentDir)) {
    const relativeFile = relative(projectRoot, file);

    if (file.endsWith('meta.json')) {
      checkMetaJson(file);
      continue;
    }
    if (!file.endsWith('.mdx')) continue;

    pages += 1;
    const text = readFileSync(file, 'utf8');
    const meta = frontmatter(text);

    if (!meta?.title) errors.push(`${relativeFile}: 缺少 frontmatter title`);

    for (const [, href] of text.matchAll(assetPattern)) {
      const source = resolve(dirname(file), href);
      const name = href.split('/').pop();

      if (!existsSync(source)) {
        errors.push(`${relativeFile}: 引用的素材不存在 ${href}`);
        continue;
      }

      if (blockedAssets.has(name)) {
        errors.push(`${relativeFile}: ${name} 含内部标识，不能用在公开页面上`);
        continue;
      }

      const previous = copied.get(name);
      if (previous && previous !== source) {
        errors.push(`素材重名：${name}，来自 ${previous} 与 ${source}`);
        continue;
      }
      if (previous) continue;

      mkdirSync(outputDir, { recursive: true });
      cpSync(source, join(outputDir, name));
      copied.set(name, source);
    }

    for (const [, url] of text.matchAll(pageLinkPattern)) {
      if (!pageExists(url)) errors.push(`${relativeFile}: 站内链接没有对应页面 ${url}`);
    }

    for (const [, url] of text.matchAll(siteImagePattern)) {
      const clean = url.split('#')[0].split('?')[0];
      if (!existsSync(join(publicDir, clean.replace(/^\//, '')))) {
        errors.push(`${relativeFile}: 站内图片不存在 ${url}`);
      }
    }
  }

  const bytes = [...copied.keys()].reduce(
    (total, name) => total + statSync(join(outputDir, name)).size,
    0,
  );

  if (errors.length > 0) {
    console.error(`内容校验发现 ${errors.length} 个问题：`);
    for (const line of errors) console.error(`  ${line}`);
    process.exit(1);
  }

  console.log(
    `content: ${pages} 页；content-assets: ${copied.size} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB`,
  );
}

main();