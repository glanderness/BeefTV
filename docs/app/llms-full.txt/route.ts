import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

/** /llms-full.txt：所有文档拼成一份纯 Markdown */
export async function GET() {
  const pages = await Promise.all(source.getPages().map(getLLMText));

  return new Response(pages.join('\n\n'));
}