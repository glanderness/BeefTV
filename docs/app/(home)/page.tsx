import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { site } from '@/lib/site';

export default function HomePage() {
  return (
    <main className="welcome">
      <p className="eyebrow">{site.home.eyebrow}</p>
      <h1>
        {site.home.title[0]}
        <br />
        {site.home.title[1]}
      </h1>
      <p>{site.home.lede}</p>
      <Link className="welcome-start" href="/docs">
        {site.home.start} <ArrowRight size={18} />
      </Link>
      <nav className="welcome-guides" aria-label="文档入口">
        {site.home.guides.map((guide) => (
          <Link key={guide.href} href={guide.href}>
            {guide.label} <ArrowRight size={17} />
          </Link>
        ))}
      </nav>
    </main>
  );
}