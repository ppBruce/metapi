import type { LookupFunction } from 'node:net';
import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DNS-rebinding guard for the favicon proxy, exercised against a REAL local
 * server: the only mock is the resolver, so what is asserted is whether a
 * socket to a private address is ever opened.
 */
type IconService = typeof import('./iconProxyService.js');

const ICON_BYTES = Buffer.from('icon-bytes');
const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 };
const LOOPBACK_ADDRESS = { address: '127.0.0.1', family: 4 };
const LOOPBACK_V6_ADDRESS = { address: '::1', family: 6 };

describe('icon proxy connect-time DNS guard', () => {
  let service: IconService;
  let server: http.Server;
  let port: number;
  let requests: string[] = [];
  let oversizedHtmlBytesSent = 0;
  let oversizedHtmlClosedEarly = false;
  let serveOversizedHtml = false;
  const oldDataDir = process.env.DATA_DIR;
  // The system proxy is a per-host setting in this repo's deployments; leave it
  // out so these cases always exercise the direct path deterministically.
  const PROXY_ENV_NAMES = [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  ] as const;
  const originalProxyEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of PROXY_ENV_NAMES) originalProxyEnv.set(name, process.env[name]);
    for (const name of PROXY_ENV_NAMES) delete process.env[name];
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-icon-dns-guard-'));
    await import('../db/migrate.js');
    await import('../db/index.js');
    service = await import('./iconProxyService.js');
    server = http.createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === '/large') {
        serveOversizedHtml = true;
        response.writeHead(200, { 'content-type': 'text/html' });
        response.on('close', () => { oversizedHtmlClosedEarly = !response.writableEnded; });
        const chunk = Buffer.alloc(64 * 1024, 65);
        let sent = 0;
        const writeChunks = () => {
          sent += chunk.length;
          oversizedHtmlBytesSent = sent;
          if (!response.write(chunk)) {
            response.once('drain', () => setTimeout(writeChunks, 5));
            return;
          }
          if (sent < 2 * 1024 * 1024) {
            setTimeout(writeChunks, 5);
          } else {
            response.end();
          }
        };
        writeChunks();
        return;
      }
      if (request.url === '/') {
        // A page that declares its own logo, the way an internal deployment does.
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<link rel="icon" href="/logo.png">');
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(ICON_BYTES);
    });
    // Listen on every interface (dual stack) so either address family a
    // resolver hands back can actually reach this server.
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  beforeEach(() => {
    requests = [];
    oversizedHtmlBytesSent = 0;
    oversizedHtmlClosedEarly = false;
    serveOversizedHtml = false;
    service.__resetIconCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of PROXY_ENV_NAMES) {
      const original = originalProxyEnv.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  });

  it('refuses to connect when the resolver flips to a loopback address after the preflight', async () => {
    // A rebind: the preflight answer is public, every answer the socket would
    // actually use is loopback. The preflight alone cannot tell the two apart.
    const lookup = vi.spyOn(dns, 'lookup');
    let answers = 0;
    (lookup as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async () => {
        answers += 1;
        return answers === 1 ? [PUBLIC_ADDRESS] : [LOOPBACK_ADDRESS];
      },
    );

    const result = await service.lookupSiteFavicon(`http://localhost:${port}`, {
      trustPrivateHost: false,
    });

    expect(result.status).toBe('not-found');
    // No request ever reached the local server: the connection itself refused.
    expect(requests).toEqual([]);
    // Preflight (public) plus at least one connect-time resolution (loopback).
    expect(answers).toBeGreaterThan(1);
  });

  it('still fetches the favicon of an admin-configured private host', async () => {
    const result = await service.lookupSiteFavicon(`http://localhost:${port}`, {
      trustPrivateHost: true,
    });

    expect(result.status).toBe('ok');
    expect(requests.length).toBeGreaterThan(0);
    if (result.status !== 'ok') return;
    expect(result.payload.buffer.equals(ICON_BYTES)).toBe(true);
    // The page's own declared logo is honoured even though the configured host
    // sits on a private address (it used to be skipped by the preflight).
    expect(requests).toContain('GET /logo.png');
    expect(result.payload.source).toBe(`http://localhost:${port}/logo.png`);
  });

  it('cancels an oversized HTML page before buffering the full body', async () => {
    const result = await service.lookupSiteFavicon(`http://localhost:${port}/large`, { trustPrivateHost: true });
    expect(requests).toContain('GET /large');
    expect(serveOversizedHtml).toBe(true);
    expect(result.status).toBe('ok');
    expect(oversizedHtmlClosedEarly).toBe(true);
    expect(oversizedHtmlBytesSent).toBeLessThan(2 * 1024 * 1024);
  });

  it('never hands a loopback address to the socket when the record is mixed', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    (lookup as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async () => [LOOPBACK_V6_ADDRESS, PUBLIC_ADDRESS],
    );
    const guard = service.createIconConnectLookup(false) as LookupFunction;

    const handed = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      guard('mixed.example.com', { all: true } as never, (error, address) => {
        if (error) reject(error);
        else resolve(address as Array<{ address: string; family: number }>);
      });
    });

    expect(handed).toEqual([PUBLIC_ADDRESS]);
  });

  it('does not send a cross-origin declared icon through the configured site proxy', () => {
    const trustedHost = 'configured.example.com';
    const policy = { trustedOrigin: `https://${trustedHost}`, proxyUrl: 'http://127.0.0.1:7897' };
    const signal = AbortSignal.timeout(1_000);
    const same = service.buildIconRequestInit(new URL(`https://${trustedHost}/logo.png`), policy, undefined, '', signal);
    const other = service.buildIconRequestInit(new URL('https://cdn.example.net/logo.png'), policy, undefined, '', signal);
    expect(same.dispatcher).toBeDefined();
    expect(other.dispatcher).toBeDefined();
    expect(other.dispatcher).not.toBe(same.dispatcher);
    const changedPort = service.buildIconRequestInit(new URL(`https://${trustedHost}:8443/logo.png`), policy, undefined, '', signal);
    expect(changedPort.dispatcher).toBe(other.dispatcher);
  });

  it('fails the connection when every answer is private for an untrusted host', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    (lookup as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async () => [LOOPBACK_ADDRESS],
    );
    const guard = service.createIconConnectLookup(false) as LookupFunction;

    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guard('private.example.com', { all: true } as never, (err) => resolve(err));
    });

    expect(error).toBeInstanceOf(Error);
  });

  it('keeps private addresses for a host the admin configured', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    (lookup as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async () => [LOOPBACK_ADDRESS],
    );
    const guard = service.createIconConnectLookup(true) as LookupFunction;

    const handed = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      guard('internal.example.com', { all: true } as never, (error, address) => {
        if (error) reject(error);
        else resolve(address as Array<{ address: string; family: number }>);
      });
    });

    expect(handed).toEqual([LOOPBACK_ADDRESS]);
  });

  it('fails the connection when the resolver itself fails', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    (lookup as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      async () => { throw Object.assign(new Error('resolve ENOTFOUND'), { code: 'ENOTFOUND' }); },
    );
    const guard = service.createIconConnectLookup(false) as LookupFunction;

    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guard('broken.example.com', { all: true } as never, (err) => resolve(err));
    });

    expect(error).toBeInstanceOf(Error);
  });

  describe('isPrivateHostname', () => {
    it('recognises the ordinary private and public ranges', () => {
      for (const host of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1',
        '169.254.1.1', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
        expect(service.isPrivateHostname(host), host).toBe(true);
      }
      for (const host of ['93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111',
        '2001:db8::1']) {
        expect(service.isPrivateHostname(host), host).toBe(false);
      }
    });

    it('refuses IPv6 wrappers that embed a private IPv4', () => {
      // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) both carry an IPv4 verbatim.
      expect(service.isPrivateHostname('2002:7f00:1::')).toBe(true); // 127.0.0.1
      expect(service.isPrivateHostname('2002:a00:1::')).toBe(true); // 10.0.0.1
      expect(service.isPrivateHostname('64:ff9b::7f00:1')).toBe(true);
      expect(service.isPrivateHostname('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
      expect(service.isPrivateHostname('2001:0:0:0:0:0:0:1')).toBe(true); // Teredo
    });

    it('still allows IPv6 wrappers that embed a public IPv4', () => {
      expect(service.isPrivateHostname('2002:5db8:d822::')).toBe(false);
      expect(service.isPrivateHostname('64:ff9b::5db8:d822')).toBe(false);
    });
  });
});
