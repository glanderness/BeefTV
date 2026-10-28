import { llms } from 'fumadocs-core/source';

import { source } from '@/lib/source';
import { site } from '@/lib/site';

export const revalidate = false;

/** /llms.txt：整站目录，链接写成绝对地址 */
export function GET() {
  return new Response(llms(source).index().replace(/\]\((\/[^)]+)\)/g, `](${site.docsOrigin}$1)`));
}