import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import { mergeHeadersWithSiteCustomHeaders } from '../siteCustomHeaders.js';

const state = vi.hoisted(() => ({ priority: 'request' as 'site' | 'request', cookie: '', fetch: vi.fn() }));
vi.mock('undici', async (original) => ({ ...await original<typeof import('undici')>(), fetch: state.fetch }));
vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: any) => ({
    ...options,
    headers: mergeHeadersWithSiteCustomHeaders({ Cookie: state.cookie }, options.headers, { priority: state.priority }),
  }),
}));
import { fetchJsonWithShieldCookieRetry, resetShieldCooldownsForTests } from './newApiShield.js';

describe('shield merged header contract', () => {
  beforeEach(() => {
    resetShieldCooldownsForTests();
    state.fetch.mockReset().mockImplementation(async () => new Response('{"success":true}', { headers: { 'content-type': 'application/json' } }));
    state.cookie = 'cf_clearance=site-clearance; session=site-session';
    state.priority = 'request';
  });
  it('sends Cookie supplied only by the site custom headers', async () => {
    await fetchJsonWithShieldCookieRetry('https://upstream.example/api/user/self');
    const sent = new Headers(state.fetch.mock.calls[0][1].headers);
    expect(sent.get('cookie')).toBe(state.cookie);
  });
  it.each(['request', 'site'] as const)('keeps %s cookie priority after jar initialization', async (priority) => {
    state.priority = priority;
    await fetchJsonWithShieldCookieRetry('https://upstream.example/api/user/self', { headers: { Cookie: 'session=request-session' } });
    const sent = new Headers(state.fetch.mock.calls[0][1].headers);
    expect(sent.get('cookie')).toBe(priority === 'site' ? state.cookie : 'session=request-session');
  });
});
