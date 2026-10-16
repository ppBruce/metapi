import { describe, expect, it } from 'vitest';

import { parseProxyLogMetadata } from './proxyLogMeta.js';

describe('proxyLogMeta', () => {
  it('parses all supported proxy log prefixes', () => {
    expect(parseProxyLogMetadata(
      '[client:codex] [session:turn-1] [trace:req-abc] [downstream:/v1/responses] [upstream:/responses] [usage:self-log] [code:endpoint_all_down] [site:Aurora Relay] [status:502] boom',
    )).toEqual({
      clientKind: 'codex',
      sessionId: 'turn-1',
      traceId: 'req-abc',
      downstreamPath: '/v1/responses',
      upstreamPath: '/responses',
      usageSource: 'self-log',
      errorCode: 'endpoint_all_down',
      siteLabel: 'Aurora Relay',
      upstreamStatus: '502',
      messageText: 'boom',
    });
  });

  it('keeps the site/status locator tokens in the shared grammar', () => {
    // The locator tokens sit between the identifying prefixes and the body, so
    // the leading run is still stripped as one block and neither token leaks
    // into the displayed message.
    expect(parseProxyLogMetadata(
      '[trace:r_1bcda25825e9] [downstream:/v1/embeddings] [site:Aurora Relay] [status:502] unknown error',
    )).toEqual({
      clientKind: null,
      sessionId: null,
      traceId: 'r_1bcda25825e9',
      downstreamPath: '/v1/embeddings',
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      siteLabel: 'Aurora Relay',
      upstreamStatus: '502',
      messageText: 'unknown error',
    });

    // Status stays a raw string: `status:0` means "no upstream reply" and must
    // survive parsing instead of collapsing into a falsy number.
    expect(parseProxyLogMetadata('[status:0] upstream never answered').upstreamStatus).toBe('0');
  });

  it('keeps plain message text when no metadata prefixes exist', () => {
    expect(parseProxyLogMetadata('network timeout')).toEqual({
      clientKind: null,
      sessionId: null,
      traceId: null,
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      siteLabel: null,
      upstreamStatus: null,
      messageText: 'network timeout',
    });
  });

  it('handles mixed-case, partial, reordered, and empty metadata safely', () => {
    expect(parseProxyLogMetadata('[CLIENT:codex] [SESSION:turn-1] [TRACE:req-1] boom')).toEqual({
      clientKind: 'codex',
      sessionId: 'turn-1',
      traceId: 'req-1',
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      siteLabel: null,
      upstreamStatus: null,
      messageText: 'boom',
    });

    expect(parseProxyLogMetadata('[client:codex] boom')).toEqual({
      clientKind: 'codex',
      sessionId: null,
      traceId: null,
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      siteLabel: null,
      upstreamStatus: null,
      messageText: 'boom',
    });

    expect(parseProxyLogMetadata('[upstream:/x] [client:codex] [session:1] [trace:t9] msg')).toEqual({
      clientKind: 'codex',
      sessionId: '1',
      traceId: 't9',
      downstreamPath: null,
      upstreamPath: '/x',
      usageSource: null,
      errorCode: null,
      siteLabel: null,
      upstreamStatus: null,
      messageText: 'msg',
    });

    expect(parseProxyLogMetadata('')).toEqual({
      clientKind: null,
      sessionId: null,
      traceId: null,
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      siteLabel: null,
      upstreamStatus: null,
      messageText: '',
    });
  });
});
