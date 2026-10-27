import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="welcome">
      <p className="eyebrow">404</p>
      <h1>没有这个页面。</h1>
      <p>地址可能写错了，或者这一页已经改名。回文档首页重新找，或者用顶栏的搜索。</p>
      <Link className="welcome-start" href="/docs">
        返回文档首页
      </Link>
    </main>
  );
}