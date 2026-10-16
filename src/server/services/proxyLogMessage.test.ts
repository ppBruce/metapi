import { describe, expect, it } from 'vitest';
import {
  composeProxyLogMessage,
  isUninformativeProxyLogBody,
  proxyLogFailureLocator,
} from './proxyLogMessage.js';

describe('composeProxyLogMessage', () => {
  it('adds downstream path metadata before plain errors', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/responses',
      errorMessage: 'upstream failed',
    })).toBe('[downstream:/v1/responses] upstream failed');
  });

  it('keeps existing upstream metadata and avoids duplicate prefixes', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/responses',
      errorMessage: '[upstream:/v1/chat/completions] bad request',
    })).toBe('[downstream:/v1/responses] [upstream:/v1/chat/completions] bad request');
  });

  it('returns metadata-only message when no error text exists', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/chat/completions',
      upstreamPath: '/v1/messages',
      errorMessage: null,
    })).toBe('[downstream:/v1/chat/completions] [upstream:/v1/messages]');
  });

  it('returns null when nothing can be recorded', () => {
    expect(composeProxyLogMessage({
      downstreamPath: null,
      upstreamPath: null,
      errorMessage: '',
    })).toBe(null);
  });

  it('adds client and session metadata ahead of path metadata', () => {
    expect(composeProxyLogMessage({
      clientKind: 'codex',
      sessionId: 'codex-session-123',
      downstreamPath: '/v1/responses',
      errorMessage: 'upstream failed',
    })).toBe('[client:codex] [session:codex-session-123] [downstream:/v1/responses] upstream failed');
  });

  it('adds request-level trace metadata without replacing session ids', () => {
    expect(composeProxyLogMessage({
      clientKind: 'codex',
      sessionId: 'codex-session-123',
      traceId: 'r_abc123',
      downstreamPath: '/v1/responses',
      errorMessage: 'upstream failed',
    })).toBe('[client:codex] [session:codex-session-123] [trace:r_abc123] [downstream:/v1/responses] upstream failed');
  });

  it('reuses existing client, session and trace metadata without duplication', () => {
    expect(composeProxyLogMessage({
      clientKind: 'claude_code',
      sessionId: 'session-123',
      traceId: 'r_xyz',
      downstreamPath: '/v1/messages',
      errorMessage: '[client:claude_code] [session:session-123] [trace:r_xyz] [upstream:/v1/messages] bad request',
    })).toBe('[client:claude_code] [session:session-123] [trace:r_xyz] [downstream:/v1/messages] [upstream:/v1/messages] bad request');
  });
});

describe('composeProxyLogMessage failure locator', () => {
  it('appends site and upstream status after the prefixes and before an unusable body', () => {
    const composed = composeProxyLogMessage({
      clientKind: 'codex',
      sessionId: 'codex-session-123',
      traceId: 'r_abc123',
      downstreamPath: '/v1/chat/completions',
      upstreamPath: '/v1/messages',
      errorCode: 'upstream_error',
      siteLabel: 'Relay One',
      upstreamStatus: 500,
      errorMessage: 'unknown error',
    });

    expect(composed).toBe(
      '[client:codex] [session:codex-session-123] [trace:r_abc123] [downstream:/v1/chat/completions] '
      + '[upstream:/v1/messages] [code:upstream_error] [site:Relay One] [status:500] unknown error',
    );
    // Locator tokens must sit after every existing prefix and before the body.
    const text = composed as string;
    expect(text.indexOf('[site:Relay One]')).toBeGreaterThan(text.indexOf('[code:upstream_error]'));
    expect(text.indexOf('[status:500]')).toBeGreaterThan(text.indexOf('[site:Relay One]'));
    expect(text.indexOf('unknown error')).toBeGreaterThan(text.indexOf('[status:500]'));
  });

  it('matches the production "unknown error" embeddings row and stays re-parseable', () => {
    // Real DB sample: [trace:r_1bcda25825e9] [downstream:/v1/embeddings] unknown error
    expect(composeProxyLogMessage({
      errorMessage: '[trace:r_1bcda25825e9] [downstream:/v1/embeddings] unknown error',
      siteLabel: 'Aurora Relay',
      upstreamStatus: 502,
    })).toBe('[trace:r_1bcda25825e9] [downstream:/v1/embeddings] [site:Aurora Relay] [status:502] unknown error');
  });

  it('enriches an empty body and an empty-content verdict, which are equally unlocatable', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/responses',
      siteLabel: 'Aurora Relay',
      upstreamStatus: 200,
      errorMessage: null,
    })).toBe('[downstream:/v1/responses] [site:Aurora Relay] [status:200]');

    expect(composeProxyLogMessage({
      downstreamPath: '/v1/responses',
      siteLabel: 'Aurora Relay',
      upstreamStatus: 502,
      errorMessage: 'Upstream returned empty content (reasoning only)',
    })).toBe('[downstream:/v1/responses] [site:Aurora Relay] [status:502] Upstream returned empty content (reasoning only)');
  });

  it('records whichever locator half is known', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/search',
      siteLabel: 'Aurora Relay',
      upstreamStatus: 0,
      errorMessage: 'unknown error',
    })).toBe('[downstream:/v1/search] [site:Aurora Relay] unknown error');

    expect(composeProxyLogMessage({
      downstreamPath: '/v1/search',
      siteLabel: '   ',
      upstreamStatus: 503,
      errorMessage: 'unknown error',
    })).toBe('[downstream:/v1/search] [status:503] unknown error');
  });

  it('leaves an informative body byte-identical even when the locator is available', () => {
    const upstreamJson = '{"error":{"message":"insufficient quota","type":"upstream_error"}}';
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/embeddings',
      siteLabel: 'Aurora Relay',
      upstreamStatus: 429,
      errorMessage: upstreamJson,
    })).toBe(`[downstream:/v1/embeddings] ${upstreamJson}`);

    const classified = 'Upstream response matched failure keyword: quota exceeded';
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/chat/completions',
      errorCode: 'quota_or_credit',
      siteLabel: 'Aurora Relay',
      upstreamStatus: 429,
      errorMessage: classified,
    })).toBe(`[downstream:/v1/chat/completions] [code:quota_or_credit] ${classified}`);

    const modelVerdict = 'unsupported model: gpt-5.1-codex';
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/responses',
      siteLabel: 'Aurora Relay',
      upstreamStatus: 400,
      errorMessage: modelVerdict,
    })).toBe(`[downstream:/v1/responses] ${modelVerdict}`);
  });

  it('keeps the pre-change output byte-identical when no locator data is passed', () => {
    expect(composeProxyLogMessage({
      traceId: 'r_1bcda25825e9',
      downstreamPath: '/v1/embeddings',
      errorMessage: 'unknown error',
    })).toBe('[trace:r_1bcda25825e9] [downstream:/v1/embeddings] unknown error');

    expect(composeProxyLogMessage({
      downstreamPath: '/v1/chat/completions',
      errorMessage: 'Upstream returned empty content',
    })).toBe('[downstream:/v1/chat/completions] Upstream returned empty content');

    expect(composeProxyLogMessage({
      downstreamPath: '/v1/chat/completions',
      errorMessage: '',
    })).toBe('[downstream:/v1/chat/completions]');

    expect(composeProxyLogMessage({ errorMessage: '' })).toBe(null);
  });

  it('normalizes a site name into the token grammar instead of breaking the line', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/embeddings',
      siteLabel: '  Relay [EU]\nOne  ',
      upstreamStatus: 500,
      errorMessage: 'unknown error',
    })).toBe('[downstream:/v1/embeddings] [site:Relay EU One] [status:500] unknown error');
  });
});

describe('proxyLogFailureLocator', () => {
  it('only locates failed rows, so success logs never grow tokens', () => {
    expect(proxyLogFailureLocator({ status: 'success', siteName: 'Aurora Relay', upstreamStatus: 200 }))
      .toEqual({ siteLabel: null, upstreamStatus: null });
    expect(proxyLogFailureLocator({ status: 'retried', siteName: 'Aurora Relay', upstreamStatus: 500 }))
      .toEqual({ siteLabel: null, upstreamStatus: null });
    expect(proxyLogFailureLocator({ status: null, siteName: 'Aurora Relay' }))
      .toEqual({ siteLabel: null, upstreamStatus: null });
  });

  it('drops unknown site/status instead of recording a half-true locator', () => {
    expect(proxyLogFailureLocator({ status: 'failed', siteName: undefined, upstreamStatus: 0 }))
      .toEqual({ siteLabel: null, upstreamStatus: null });
    expect(proxyLogFailureLocator({ status: 'failed', siteName: 'Aurora Relay', upstreamStatus: Number.NaN }))
      .toEqual({ siteLabel: 'Aurora Relay', upstreamStatus: null });
    expect(proxyLogFailureLocator({ status: 'failed', siteName: 'Aurora Relay', upstreamStatus: 502 }))
      .toEqual({ siteLabel: 'Aurora Relay', upstreamStatus: 502 });
  });

  it('composes into a locatable failed row', () => {
    expect(composeProxyLogMessage({
      downstreamPath: '/v1/images/generations',
      errorMessage: 'unknown error',
      ...proxyLogFailureLocator({ status: 'failed', siteName: 'Aurora Relay', upstreamStatus: 502 }),
    })).toBe('[downstream:/v1/images/generations] [site:Aurora Relay] [status:502] unknown error');
  });
});

describe('isUninformativeProxyLogBody', () => {
  it('flags the bodies that give the operator nothing to act on', () => {
    expect(isUninformativeProxyLogBody('')).toBe(true);
    expect(isUninformativeProxyLogBody('   ')).toBe(true);
    expect(isUninformativeProxyLogBody(null)).toBe(true);
    expect(isUninformativeProxyLogBody('unknown error')).toBe(true);
    expect(isUninformativeProxyLogBody('Unknown Error')).toBe(true);
    expect(isUninformativeProxyLogBody('  unknown   error  ')).toBe(true);
    expect(isUninformativeProxyLogBody('Upstream returned empty content')).toBe(true);
  });

  it('does not flag bodies that already name a cause', () => {
    expect(isUninformativeProxyLogBody('unknown error: upstream channel 42 disabled')).toBe(false);
    expect(isUninformativeProxyLogBody('{"error":{"message":"unknown error"}}')).toBe(false);
    expect(isUninformativeProxyLogBody('fetch failed: ECONNREFUSED')).toBe(false);
  });
});
