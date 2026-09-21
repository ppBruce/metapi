/**
 * Shared builder for the same-origin site favicon proxy URL.
 *
 * Kept in its own module so both the site badge (SiteBadgeLink) and the model
 * badge (BrandIcon) can fall back to the upstream site's own icon without
 * importing each other.
 */
export function buildFaviconUrl(rawUrl?: string | null, siteId?: number | null): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const siteQuery = typeof siteId === 'number' && Number.isSafeInteger(siteId) && siteId > 0
      ? `&siteId=${siteId}` : '';
    return `/api/site-favicon?url=${encodeURIComponent(url.origin)}${siteQuery}`;
  } catch {
    return null;
  }
}
