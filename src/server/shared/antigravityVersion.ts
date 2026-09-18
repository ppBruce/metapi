/**
 * Antigravity client version tracking.
 *
 * The upstream `/v1internal:*` surface is sensitive to the client version
 * advertised in `User-Agent`. A pinned version silently rots: once Google
 * retires it, requests start failing in ways that look like auth or capacity
 * errors. CLIProxyAPI polls Antigravity's release feed for this reason; we do
 * the same, but lazily instead of from a background daemon.
 *
 * `antigravityUserAgent()` never blocks and never throws: it returns the
 * cached version immediately and schedules an out-of-band refresh when the
 * cache is stale. Requests therefore always use a known-good string, at worst
 * one refresh interval behind.
 */

const ANTIGRAVITY_RELEASES_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app/releases';

/** Used until the first successful fetch, and whenever the feed is unreachable. */
export const ANTIGRAVITY_FALLBACK_VERSION = '1.21.9';

const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** Node client UA that the control-plane (`loadCodeAssist`) UA appends. */
export const ANTIGRAVITY_NODE_API_CLIENT_UA = 'google-api-nodejs-client/10.3.0';

type VersionCache = {
  version: string;
  expiresAt: number;
  inFlight: Promise<void> | null;
};

const cache: VersionCache = {
  version: ANTIGRAVITY_FALLBACK_VERSION,
  expiresAt: 0,
  inFlight: null,
};

function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function fetchAntigravityLatestVersion(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(ANTIGRAVITY_RELEASES_URL, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`antigravity releases API returned status ${response.status}`);
    }
    const releases: unknown = await response.json();
    if (!isJsonArray(releases) || releases.length <= 0) {
      throw new Error('antigravity releases API returned empty list');
    }
    const first = releases[0];
    const version = (
      first && typeof first === 'object' && !Array.isArray(first)
        ? (first as Record<string, unknown>).version
        : undefined
    );
    if (typeof version !== 'string' || !version.trim()) {
      throw new Error('antigravity releases API returned empty version');
    }
    return version.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh the cache at most once concurrently. On failure the previous value is
 * kept and its expiry pushed out, so a flapping feed cannot turn into a fetch
 * per request.
 */
function scheduleAntigravityVersionRefresh(): Promise<void> {
  if (cache.inFlight) return cache.inFlight;
  const task = fetchAntigravityLatestVersion()
    .then((version) => {
      cache.version = version;
      cache.expiresAt = Date.now() + VERSION_CACHE_TTL_MS;
    })
    .catch(() => {
      if (!cache.version) cache.version = ANTIGRAVITY_FALLBACK_VERSION;
      cache.expiresAt = Date.now() + VERSION_CACHE_TTL_MS;
    })
    .finally(() => {
      cache.inFlight = null;
    });
  cache.inFlight = task;
  return task;
}

/** Latest known Antigravity version. Cheap, synchronous, never throws. */
export function antigravityLatestVersion(): string {
  if (Date.now() >= cache.expiresAt) {
    void scheduleAntigravityVersionRefresh();
  }
  return cache.version || ANTIGRAVITY_FALLBACK_VERSION;
}

/** Runtime UA for generateContent / streamGenerateContent / model listing. */
export function antigravityUserAgent(): string {
  return `antigravity/${antigravityLatestVersion()} darwin/arm64`;
}

/** Longer UA required by the `loadCodeAssist` control-plane call. */
export function antigravityLoadCodeAssistUserAgent(): string {
  return `${antigravityUserAgent()} ${ANTIGRAVITY_NODE_API_CLIENT_UA}`;
}

/** Test-only: restore module state so cases cannot leak into each other. */
export function resetAntigravityVersionCacheForTests(): void {
  cache.version = ANTIGRAVITY_FALLBACK_VERSION;
  cache.expiresAt = 0;
  cache.inFlight = null;
}

/** Test-only: await any refresh started by `antigravityLatestVersion()`. */
export function flushAntigravityVersionRefreshForTests(): Promise<void> {
  return cache.inFlight ?? Promise.resolve();
}
