import Fastify, { type FastifyInstance } from 'fastify';
import { Headers, Response } from 'undici';
import { promises as dns } from 'node:dns';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: fetchMock,
}));

type DbModule = typeof import('../../db/index.js');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>';

describe('site favicon proxy routing', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  const oldDataDir = process.env.DATA_DIR;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-favicon-routing-'));
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    app = Fastify();
    await app.register((await import('./sites.js')).sitesRoutes);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(dns, 'lookup').mockResolvedValue({ address: '93.184.216.34', family: 4 });
    await db.delete(schema.sites).run();
    (await import('../../services/iconProxyService.js')).__resetIconCacheForTests();
    (await import('../../services/siteProxy.js')).invalidateSiteProxyCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(svg, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    (await import('../../services/siteProxy.js')).stopDispatcherCacheSweep();
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  });

  it('downloads a configured site icon through that site proxy', async () => {
    await db.insert(schema.sites).values({
      name: 'proxied-site',
      url: 'https://site.example.com',
      platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-favicon?url=https%3A%2F%2Fsite.example.com',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(svg);
    const { ProxyAgent } = await import('undici');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('keeps response cookies across same-origin icon redirects through the proxy', async () => {
    await db.insert(schema.sites).values({
      name: 'redirect-site',
      url: 'https://redirect.example.com',
      platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === 'https://redirect.example.com/favicon.ico') {
        return new Response('', {
          status: 307,
          headers: {
            location: '/favicon.ico?ready=1',
            'set-cookie': 'cdn_sec_tc=icon-challenge; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (String(url) === 'https://redirect.example.com/favicon.ico?ready=1'
        && new Headers(init.headers).get('cookie') === 'cdn_sec_tc=icon-challenge') {
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-favicon?url=https%3A%2F%2Fredirect.example.com',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(svg);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const { ProxyAgent } = await import('undici');
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
      expect(init.redirect).toBe('manual');
    }
  });

  it('keeps the site proxy on CDN redirects without forwarding origin cookies', async () => {
    await db.insert(schema.sites).values({
      name: 'cdn-site', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
      customHeaders: JSON.stringify({ Authorization: 'Bearer private-account-token' }),
    }).run();
    fetchMock.mockImplementation(async (url) => String(url).includes('cdn.example.com')
      ? new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      : new Response('', {
        status: 302,
        headers: { location: 'https://cdn.example.com/logo.svg', 'set-cookie': 'session=origin-only; Path=/' },
      }));

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const { ProxyAgent } = await import('undici');
    const [, cdnInit] = fetchMock.mock.calls[1];
    expect(cdnInit.dispatcher).toBeInstanceOf(ProxyAgent);
    expect(new Headers(cdnInit.headers).get('cookie')).toBeNull();
    expect(new Headers(cdnInit.headers).get('authorization')).toBeNull();
  });

  it('uses the site proxy for the homepage and its declared CDN icon', async () => {
    await db.insert(schema.sites).values({
      name: 'html-site', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === 'https://site.example.com/') {
        return new Response('<link rel="icon" href="https://cdn.example.com/logo.svg">', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (String(url) === 'https://cdn.example.com/logo.svg') {
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-favicon-source']).toBe('https://cdn.example.com/logo.svg');
    const { ProxyAgent } = await import('undici');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchMock.mock.calls) expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('never retries directly after the configured proxy fails', async () => {
    await db.insert(schema.sites).values({
      name: 'offline-proxy', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockRejectedValue(new Error('proxy connection refused'));

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const { ProxyAgent } = await import('undici');
    for (const [, init] of fetchMock.mock.calls) expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('fetches directly when the configured site has no proxy', async () => {
    await db.insert(schema.sites).values({
      name: 'direct-site', url: 'https://site.example.com', platform: 'new-api',
    }).run();
    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeUndefined();
  });

  it('does not reuse a cached direct miss after the site proxy changes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'changed-proxy', url: 'https://site.example.com', platform: 'new-api',
    }).returning().get();
    fetchMock.mockImplementation(async (_url, init) => init.dispatcher
      ? new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      : new Response('', { status: 404 }));
    const requestUrl = '/api/site-favicon?url=https%3A%2F%2Fsite.example.com';
    expect((await app.inject(requestUrl)).statusCode).toBe(404);
    await db.update(schema.sites).set({ proxyUrl: 'http://127.0.0.1:9876' })
      .where(eq(schema.sites.id, site.id)).run();
    const response = await app.inject(requestUrl);
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-favicon-cache']).toBe('MISS');
    expect((await app.inject(requestUrl)).headers['x-favicon-cache']).toBe('HIT');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('rejects a private redirect target even for a configured public site', async () => {
    await db.insert(schema.sites).values({
      name: 'redirect-guard', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async () => new Response('', {
      status: 302, headers: { location: 'https://127.0.0.1/private-icon' },
    }));
    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(404);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).hostname === 'site.example.com')).toBe(true);
  });

  it('rejects unconfigured private origins without making any request', async () => {
    const response = await app.inject('/api/site-favicon?url=http%3A%2F%2F127.0.0.1%3A9');
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the configured proxy when a site URL contains a path', async () => {
    await db.insert(schema.sites).values({
      name: 'path-site', url: 'https://site.example.com/provider/api', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    const { ProxyAgent } = await import('undici');
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('selects the requested site proxy when multiple sites share an origin', async () => {
    await db.insert(schema.sites).values({
      name: 'root-direct', url: 'https://site.example.com', platform: 'openai',
    }).run();
    const proxied = await db.insert(schema.sites).values({
      name: 'path-proxied', url: 'https://site.example.com/provider', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).returning().get();
    const response = await app.inject(`/api/site-favicon?url=https%3A%2F%2Fsite.example.com&siteId=${proxied.id}`);
    expect(response.statusCode).toBe(200);
    const { ProxyAgent } = await import('undici');
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('does not lend a site proxy to a different origin', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'known-site', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).returning().get();
    const response = await app.inject(`/api/site-favicon?url=https%3A%2F%2Fother.example.com&siteId=${site.id}`);
    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
