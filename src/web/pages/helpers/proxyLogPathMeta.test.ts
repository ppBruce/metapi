import { describe, expect, it } from 'vitest';
import { parseProxyLogPathMeta } from './proxyLogPathMeta.js';

describe('parseProxyLogPathMeta', () => {
  it('parses downstream and upstream paths from prefixed message', () => {
    const parsed = parseProxyLogPathMeta('[downstream:/v1/responses] [upstream:/v1/chat/completions] {"error":"x"}');
    expect(parsed.downstreamPath).toBe('/v1/responses');
    expect(parsed.upstreamPath).toBe('/v1/chat/completions');
    expect(parsed.errorMessage).toBe('{"error":"x"}');
  });

  it('supports historical upstream-only logs', () => {
    const parsed = parseProxyLogPathMeta('[upstream:/v1/messages] messages is required');
    expect(parsed.downstreamPath).toBe(null);
    expect(parsed.upstreamPath).toBe('/v1/messages');
    expect(parsed.errorMessage).toBe('messages is required');
  });

  it('strips legacy client and session prefixes while keeping them available for display', () => {
    const parsed = parseProxyLogPathMeta('[client:codex] [session:turn-123] [downstream:/v1/responses] boom');
    expect(parsed.clientFamily).toBe('codex');
    expect(parsed.sessionId).toBe('turn-123');
    expect(parsed.downstreamPath).toBe('/v1/responses');
    expect(parsed.errorMessage).toBe('boom');
  });

  it('keeps plain message when no metadata exists', () => {
    const parsed = parseProxyLogPathMeta('network timeout');
    expect(parsed.downstreamPath).toBe(null);
    expect(parsed.upstreamPath).toBe(null);
    expect(parsed.siteLabel).toBe(null);
    expect(parsed.upstreamStatus).toBe(null);
    expect(parsed.errorMessage).toBe('network timeout');
  });

  it('parses the site and upstream-status locator tokens of a failed row', () => {
    const parsed = parseProxyLogPathMeta(
      '[trace:r_1bcda25825e9] [downstream:/v1/embeddings] [site:Aurora Relay] [status:502] unknown error',
    );
    expect(parsed.traceId).toBe('r_1bcda25825e9');
    expect(parsed.downstreamPath).toBe('/v1/embeddings');
    expect(parsed.siteLabel).toBe('Aurora Relay');
    expect(parsed.upstreamStatus).toBe('502');
    expect(parsed.errorMessage).toBe('unknown error');
  });

  it('keeps status:0 as recorded and leaves rows without locator tokens untouched', () => {
    // `status:0` means "the upstream never replied" — coercing it to a number
    // would turn it falsy and drop the only clue the row has.
    expect(parseProxyLogPathMeta('[site:Aurora Relay] [status:0] upstream never answered').upstreamStatus)
      .toBe('0');

    // Rows written before the locator existed (and successful rows) keep the
    // exact shape they had: nulls here, untouched message text.
    const legacy = parseProxyLogPathMeta('[downstream:/v1/responses] boom');
    expect(legacy.siteLabel).toBe(null);
    expect(legacy.upstreamStatus).toBe(null);
    expect(legacy.errorMessage).toBe('boom');
  });
});
