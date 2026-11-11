import { createRouter } from '@chat-app/shared/app';

/** 後台單頁 */
export function pageRoutes({ pagePath }: { pagePath: string }) {
  const r = createRouter();
  const html = Bun.file(pagePath);

  r.get('/', async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

  return r;
}
