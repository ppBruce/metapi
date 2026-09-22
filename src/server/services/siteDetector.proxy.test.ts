import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DetectSite = typeof import('./siteDetector.js').detectSite;
type ProxyHit = { kind: 'http' | 'connect'; url: string };

const listen = (server: http.Server | net.Server) => new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve(typeof address === 'object' && address ? address.port : 0);
  });
});

const close = (server: http.Server | net.Server) => new Promise<void>((resolve) => {
  server.close(() => resolve());
});

describe('detectSite proxy routing', () => {
  let detectSite: DetectSite;
  let upstream: http.Server;
  let recordingProxy: http.Server;
  let deadProxy: http.Server;
  let upstreamPort = 0;
  let recordingProxyPort = 0;
  let deadProxyPort = 0;
  let dataDir = '';
  const proxyHits: ProxyHit[] = [];
  const deadHits: ProxyHit[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-detect-proxy-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    ({ detectSite } = await import('./siteDetector.js'));

    // Upstream that answers like a new-api panel.
    upstream = http.createServer((request, response) => {
      if (request.url === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, data: { system_name: 'MockNewApi' } }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
    });
    upstreamPort = await listen(upstream);

    // Recording proxy: forwards absolute-URI requests and tunnels CONNECT.
    recordingProxy = http.createServer((request, response) => {
      proxyHits.push({ kind: 'http', url: String(request.url) });
      let target: URL;
      try {
        target = new URL(String(request.url));
      } catch {
        response.writeHead(400);
        response.end('bad target');
        return;
      }
      const forwarded = http.request({
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: request.method,
        headers: request.headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      forwarded.on('error', () => {
        response.writeHead(502);
        response.end('proxy error');
      });
      request.pipe(forwarded);
    });
    recordingProxy.on('connect', (request, clientSocket, head) => {
      proxyHits.push({ kind: 'connect', url: String(request.url) });
      const [host, port] = String(request.url).split(':');
      const socket = net.connect(Number(port) || 443, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) socket.write(head);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
      });
      socket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => socket.destroy());
    });
    recordingProxyPort = await listen(recordingProxy);

    // Proxy that accepts the connection and immediately drops it.
    deadProxy = http.createServer((_request, response) => {
      deadHits.push({ kind: 'http', url: 'dead' });
      response.writeHead(502);
      response.end('dead');
    });
    deadProxy.on('connect', (request, socket) => {
      deadHits.push({ kind: 'connect', url: String(request.url) });
      socket.end();
    });
    deadProxyPort = await listen(deadProxy);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([close(upstream), close(recordingProxy), close(deadProxy)]);
    delete process.env.DATA_DIR;
  });

  it('probes the site through the proxy the operator entered', async () => {
    proxyHits.length = 0;
    const result = await detectSite(`http://127.0.0.1:${upstreamPort}`, {
      proxyUrl: `http://127.0.0.1:${recordingProxyPort}`,
    });

    expect(result?.platform).toBe('new-api');
    expect(proxyHits.length).toBeGreaterThan(0);
    expect(proxyHits.every((hit) => hit.url.includes(String(upstreamPort)))).toBe(true);
  }, 60_000);

  it('goes direct when no proxy is configured', async () => {
    proxyHits.length = 0;
    const result = await detectSite(`http://127.0.0.1:${upstreamPort}`);

    expect(result?.platform).toBe('new-api');
    expect(proxyHits).toEqual([]);
  }, 60_000);

  it('reports no platform when the configured proxy is unreachable', async () => {
    deadHits.length = 0;
    const result = await detectSite(`http://127.0.0.1:${upstreamPort}`, {
      proxyUrl: `http://127.0.0.1:${deadProxyPort}`,
      timeoutMs: 2000,
    });

    expect(result).toBeNull();
    expect(deadHits.length).toBeGreaterThan(0);
  }, 60_000);
});
