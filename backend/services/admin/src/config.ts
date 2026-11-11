import { resolve } from 'node:path';
import { env, envInt } from '@chat-app/shared/config';

export function loadConfig() {
  return {
    port: envInt('PORT', 8090),
    /** 後台單頁(services/admin/public/index.html) */
    pagePath: new URL('../public/index.html', import.meta.url).pathname,
    /** browser-agent 的截圖與 manifest(compose 以唯讀掛載) */
    artifactRoot: resolve(env('BROWSER_AGENT_ARTIFACT_DIR', '/var/lib/browser-agent/artifacts')),
  };
}

export type AdminConfig = ReturnType<typeof loadConfig>;
