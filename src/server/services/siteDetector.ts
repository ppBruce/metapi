import { detectPlatform } from './platforms/index.js';
import { analyzePrimarySiteUrl } from '../../shared/sitePrimaryUrl.js';
import { withAccountProxyOverride } from './siteProxy.js';

/** Total detection budget; per-request management timeouts are 30s each. */
export const DETECTION_BUDGET_MS = 25_000;

/**
 * Detect the platform behind a URL.
 *
 * A site that is only reachable through a proxy must be probed through it.
 * `siteProxy.ts` installs a forced-direct global dispatcher and resolves a
 * site's proxy from its stored row — but detection runs *before* the row
 * exists (the operator is still filling the form), so there is nothing to
 * resolve and the probe would go direct and time out. The form's proxy field
 * therefore travels in as an explicit override, which
 * `withAccountProxyOverride` applies to every fetch issued inside this async
 * context (both the adapter probes and the title / OpenAI-compatible
 * fallbacks).
 */
export async function detectSite(
  url: string,
  options?: { proxyUrl?: string | null; timeoutMs?: number },
) {
  const analyzed = analyzePrimarySiteUrl(url);
  const detectionUrl = analyzed.canonicalUrl;
  const persistedUrl = analyzed.persistedUrl || detectionUrl;
  if (!detectionUrl) return null;

  const probe = async () => {
    const adapter = await detectPlatform(detectionUrl);
    if (!adapter) return null;
    return { url: persistedUrl, platform: adapter.platformName };
  };

  // A misconfigured proxy makes every probe wait out its own 30s management
  // timeout, one after another — the form would sit on "检测中" for minutes.
  // Bound the whole detection so the operator gets an answer either way.
  const budgetMs = options?.timeoutMs ?? DETECTION_BUDGET_MS;
  let timer: NodeJS.Timeout | undefined;
  const bounded = Promise.race([
    withAccountProxyOverride(options?.proxyUrl, probe),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  return bounded;
}
