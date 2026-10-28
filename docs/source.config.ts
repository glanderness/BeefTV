import { defineConfig } from 'fumadocs-mdx/config';

import remarkDropLeadingH1 from './lib/remark-drop-leading-h1.mjs';

/**
 * 全局 MDX 选项。
 *
 * - remarkDropLeadingH1：去掉正文开头重复的一级标题（页面标题由 frontmatter 渲染）。
 * - remarkImageOptions.useImport 关掉：正文里的截图引用的是仓库内的原始路径
 *   （docs/content/docs 里写成 ../../../../assets/readme/x.png），交给打包器做静态
 *   import 会把路径解析错。关掉后图片保留普通 src，由 components/mdx.tsx 的 img
 *   组件改指向构建产物里的副本。
 */
export default defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [remarkDropLeadingH1, ...plugins],
    remarkImageOptions: {
      useImport: false,
    },
  },
});