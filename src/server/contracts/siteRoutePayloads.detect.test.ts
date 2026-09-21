import { describe, expect, it } from 'vitest';
import { parseSiteDetectPayload } from './siteRoutePayloads.js';

describe('parseSiteDetectPayload', () => {
  it('accepts a url without a proxy', () => {
    const parsed = parseSiteDetectPayload({ url: 'https://example.com' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.url).toBe('https://example.com');
    expect(parsed.success && parsed.data.proxyUrl).toBeUndefined();
  });

  it('keeps the proxy the operator typed so detection can use it', () => {
    const parsed = parseSiteDetectPayload({
      url: 'https://example.com',
      proxyUrl: 'http://127.0.0.1:7890',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.proxyUrl).toBe('http://127.0.0.1:7890');
  });

  it('rejects a non-string proxy', () => {
    const parsed = parseSiteDetectPayload({ url: 'https://example.com', proxyUrl: 42 });

    expect(parsed.success).toBe(false);
  });

  it('still requires a url', () => {
    expect(parseSiteDetectPayload({ proxyUrl: 'http://127.0.0.1:7890' }).success).toBe(false);
  });
});
