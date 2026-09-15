import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('./siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, init: unknown) => init,
  withSiteRecordProxyRequestInit: (_site: unknown, init: unknown) => init,
}));

import { registerShieldCooldown, resetShieldCooldownsForTests } from './platforms/newApiShield.js';
import { resolveProxyUsageWithSelfLogFallback } from './proxyUsageFallbackService.js';

const input = {
  site: { url: 'https://usage.example.invalid', platform: 'new-api' },
  account: {
    accessToken: 'session=test-session',
    apiToken: 'account-test-token',
    platformUserId: 42,
  },
  tokenValue: 'route-test-token',
  modelName: 'gpt-4o',
  requestStartedAtMs: 1_700_000_120_000,
  requestEndedAtMs: 1_700_000_123_000,
  localLatencyMs: 3000,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};

const missingUsage = {
  ...input.usage,
  recoveredFromSelfLog: false,
  estimatedCostFromQuota: 0,
  selfLogBillingMeta: null,
  usageSource: 'unknown',
};

const matchingPayload = {
  data: { items: [{
    model_name: input.modelName,
    prompt_tokens: 120,
    completion_tokens: 80,
    quota: 5000,
    created_at: 1_700_000_123,
    request_time: 3000,
  }] },
};

describe('proxyUsageFallbackService shield terminal handling', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetShieldCooldownsForTests();
  });

  afterEach(() => {
    resetShieldCooldownsForTests();
  });

  it('stops all cookie and token candidates after a terminal rate limit', async () => {
    fetchMock.mockImplementation(async () => new Response('http_ratelimit', {
      status: 400,
      headers: { 'x-tengine-error': 'http_ratelimit' },
    }));

    const result = await resolveProxyUsageWithSelfLogFallback(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(missingUsage);
  });

  it.each(['session=test-session', 'bearer-test-token'])(
    'sends no requests during an existing origin cooldown with %s',
    async (accessToken) => {
      registerShieldCooldown(`${input.site.url}/api/user/self`);
      fetchMock.mockImplementation(async () => new Response('{}'));

      const result = await resolveProxyUsageWithSelfLogFallback({
        ...input,
        account: { ...input.account, accessToken },
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual(missingUsage);
    },
  );

  it('does not fall through to bare fetch if cooldown starts during cookie lookup', async () => {
    fetchMock.mockImplementation(async () => {
      registerShieldCooldown(input.site.url);
      return new Response('temporary non-JSON response', { status: 400 });
    });

    const result = await resolveProxyUsageWithSelfLogFallback(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(missingUsage);
  });

  it.each([
    { status: 429, body: '{"message":"rate limited"}' },
    { status: 403, body: '<html><title>403 Forbidden</title></html>' },
    { status: 503, body: '<html><title>Service Unavailable</title></html>' },
  ])('stops on terminal HTTP $status without trying another credential', async ({ status, body }) => {
    fetchMock.mockImplementation(async () => new Response(body, { status }));

    const result = await resolveProxyUsageWithSelfLogFallback(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(missingUsage);
  });

  it('still recovers actual new-api usage from successful cookie lookup', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(matchingPayload)));

    const result = await resolveProxyUsageWithSelfLogFallback(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      recoveredFromSelfLog: true,
      estimatedCostFromQuota: 0.01,
      selfLogBillingMeta: null,
      usageSource: 'self-log',
    });
  });

  it('keeps trying new-api token candidates after ordinary authentication errors', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(matchingPayload)));

    const result = await resolveProxyUsageWithSelfLogFallback({
      ...input,
      account: { ...input.account, accessToken: 'expired-test-token' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer route-test-token');
    expect(result).toMatchObject({ totalTokens: 200, recoveredFromSelfLog: true, usageSource: 'self-log' });
  });

  it('preserves sub2api token fallback despite a new-api cooldown on the same origin', async () => {
    registerShieldCooldown(input.site.url);
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(matchingPayload)));

    const result = await resolveProxyUsageWithSelfLogFallback({
      ...input,
      site: { ...input.site, platform: 'sub2api' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/v1/usage?');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer route-test-token');
    expect(result).toMatchObject({ totalTokens: 200, recoveredFromSelfLog: true, usageSource: 'self-log' });
  });
});
