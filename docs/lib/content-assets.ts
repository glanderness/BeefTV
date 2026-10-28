const protocolLike = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 判断正文里的路径是否指向仓库内素材（如 ../../../../assets/readme/x.png）。
 * 这类文件在构建时被复制到 public/content-assets/，对外按文件名访问。
 */
export function isRepoAsset(href: string): boolean {
  if (protocolLike.test(href) || href.startsWith('/') || href.startsWith('#')) return false;

  return /(^|\/)assets\//.test(href);
}

export function contentAssetUrl(href: string): string {
  const name = href.split('#')[0].split('?')[0].split('/').pop() ?? href;

  return `/content-assets/${name}`;
}