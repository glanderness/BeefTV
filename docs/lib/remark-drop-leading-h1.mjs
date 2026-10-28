/**
 * 去掉正文开头的一级标题。
 *
 * docs/content/docs 里的 mdx 大多在 frontmatter 之后写一行 `# 标题`，这是为了让网页上
 * 直接读源码也能看清标题。文档站的页面标题由 frontmatter 的 title 渲染，正文再出现一次
 * 就会重复，所以这里在编译时把紧跟在 frontmatter 后的第一个 h1 摘掉。
 *
 * 只处理文档最开头的那个 h1，正文中间的标题不动。
 */
export default function remarkDropLeadingH1() {
  return (tree) => {
    const children = tree.children ?? [];
    if (children.length === 0) return;

    // frontmatter 由 remark-frontmatter 解析成 yaml 节点，跳过它找正文第一个节点
    const index = children.findIndex((node) => node.type !== 'yaml' && node.type !== 'toml');
    const first = children[index];

    if (first?.type === 'heading' && first.depth === 1) {
      children.splice(index, 1);
      // 标题后面紧跟的空行在 mdast 里本来就不存在，无需额外清理
    }
  };
}