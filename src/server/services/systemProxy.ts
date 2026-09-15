import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';

import { normalizeSiteProxyUrl, withExplicitProxyRequestInit } from './siteProxy.js';

/**
 * System proxy for one-off outbound fetches (downloads, registry lookups),
 * resolved from the standard environment variables only — HTTPS_PROXY /
 * HTTP_PROXY / ALL_PROXY, upper or lower case. Unset or invalid values
 * resolve to null (direct connection), so an environment without a proxy
 * keeps the exact pre-existing behaviour.
 */
export function resolveSystemProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  // Precedence mirrors dotenv (never overrides an already-set var): whatever
  // the container env carries wins over anything a stray .env would hold.
  const raw = env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy
    || env.ALL_PROXY || env.all_proxy
    || '';
  return normalizeSiteProxyUrl(raw);
}

/** Attach the system-proxy dispatcher (when one is configured) to a fetch
 *  init. The global dispatcher is a forced-direct agent (siteProxy.ts), so an
 *  env proxy only takes effect when passed explicitly as the dispatcher. */
export function withSystemProxyRequestInit(
  env: NodeJS.ProcessEnv,
  options?: UndiciRequestInit,
): UndiciRequestInit {
  return withExplicitProxyRequestInit(resolveSystemProxyUrl(env), options);
}

export type ProxyAwareFetch = <T = unknown>(
  url: string,
  init?: UndiciRequestInit & { dispatcher?: Dispatcher },
) => Promise<T>;
