import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * 静态导出：产物是一组 html + 静态资源，交给 Cloudflare Workers 静态托管。
 * 站点有自己的域名（docs.beeftv.app），不挂官网子路径，所以没有 basePath。
 *
 * @type {import('next').NextConfig}
 */
const config = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default withMDX(config);