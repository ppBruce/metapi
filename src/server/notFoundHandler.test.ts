/**
 * Regression tests for the SPA fallback / not-found handler.
 *
 * The bug these pin down: on Fastify 5, an async handler that calls
 * `reply.send(x)` and then resolves to `undefined` (explicit `return;` or an
 * implicit fallthrough) makes Fastify run the same onSend chain a second time
 * whenever the chain is suspended by a promise-returning onSend hook. The
 * second pass ends in `safeWriteHead()` on an already-written head:
 * `ERR_HTTP_HEADERS_SENT` thrown on the server plus a
 * `FST_ERR_REP_ALREADY_SENT` warning in the log — while the client still sees
 * the correct 404. Production runs three async onSend hooks (two capability
 * hooks + the security-header hook), so every 404 path used to emit this noise.
 *
 * The apps below are shaped like production: @fastify/compress { global: true }
 * plus two async onSend hooks. The second describe block is a deliberate
 * counter-example proving the detector actually fires on the buggy shape — if
 * it ever stops firing there, the "no header errors" assertions below are
 * worthless and this suite must be fixed before it is trusted.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNotFoundHandler } from './notFoundHandler.js';
import { isSpaShellFallbackCandidate } from './webSpaFallback.js';

const SHELL_HTML = '<!doctype html><html><body>spa shell</body></html>';
const HEADER_ERROR_MARKERS = ['ERR_HTTP_HEADERS_SENT', 'FST_ERR_REP_ALREADY_SENT'] as const;

// --------------------------------------------------------------- writeHead probe
// `http.ServerResponse.prototype.writeHead` is the point where the double
// onSend pass becomes visible: the second pass calls it again on a response
// whose head is already out. Counting calls per response is the direct,
// framework-independent observation of "the chain ran twice".
interface WriteHeadRecord {
  response: http.ServerResponse;
  statusCode: number;
  headersAlreadySent: boolean;
}

type WriteHeadProbe = (
  this: http.ServerResponse,
  statusCode: number,
  ...rest: unknown[]
) => http.ServerResponse;

const writeHeadRecords: WriteHeadRecord[] = [];
const originalWriteHead = http.ServerResponse.prototype.writeHead;

function probeWriteHead(
  this: http.ServerResponse,
  statusCode: number,
  ...rest: unknown[]
): http.ServerResponse {
  writeHeadRecords.push({ response: this, statusCode, headersAlreadySent: this.headersSent });
  return Reflect.apply(originalWriteHead, this, [statusCode, ...rest]) as http.ServerResponse;
}

// --------------------------------------------------------------- helpers
function errorMarkersIn(logs: readonly string[]): string[] {
  const text = logs.join('\n');
  return HEADER_ERROR_MARKERS.filter((marker) => text.includes(marker));
}

/** Pino numeric levels of the log records that mention `marker` (10 trace … 50 error). */
function markerLogLevels(logs: readonly string[], marker: string): number[] {
  const levels: number[] = [];
  for (const line of logs) {
    if (!line.includes(marker)) continue;
    try {
      const parsed = JSON.parse(line) as { level?: unknown };
      if (typeof parsed.level === 'number') levels.push(parsed.level);
    } catch {
      // Non-JSON output (not produced by our pino stream) — nothing to read.
    }
  }
  return levels;
}

interface RequestOutcome {
  status: number;
  body: string;
  contentType: string | null;
  writeHeads: WriteHeadRecord[];
  logs: string[];
}

async function get(origin: string, logs: string[], url: string): Promise<RequestOutcome> {
  const writeHeadStart = writeHeadRecords.length;
  const logStart = logs.length;
  const response = await fetch(`${origin}${url}`);
  const body = await response.text();
  // A stray second onSend pass reports its failure right after the response
  // reaches the client; let the loop drain before snapshotting the log slice.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    status: response.status,
    body,
    contentType: response.headers.get('content-type'),
    writeHeads: writeHeadRecords.slice(writeHeadStart),
    logs: logs.slice(logStart),
  };
}

async function waitForMarker(logs: string[], marker: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (logs.join('\n').includes(marker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

interface TestApp {
  app: ReturnType<typeof Fastify>;
  logs: string[];
  origin: string;
}

/** Production-shaped app: compress(global) + two async onSend hooks. */
async function startProductionShapedApp(): Promise<TestApp> {
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      // 'trace' captures every level, so nothing can hide below the stream's threshold.
      level: 'trace',
      stream: { write: (line: string) => logs.push(line) },
    },
  });
  await app.register(compress, { global: true });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-test-onsend-1', '1');
    return payload;
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-test-onsend-2', '1');
    return payload;
  });
  await app.register(fastifyStatic, { root: staticRoot, prefix: '/', wildcard: true });
  app.setNotFoundHandler(createNotFoundHandler({ isSpaShellFallbackCandidate }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { app, logs, origin: `http://127.0.0.1:${port}` };
}

let staticRoot = '';

beforeAll(() => {
  staticRoot = mkdtempSync(path.join(tmpdir(), 'metapi-notfound-test-'));
  writeFileSync(path.join(staticRoot, 'index.html'), SHELL_HTML);
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead = probeWriteHead;
});

afterAll(() => {
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead =
    originalWriteHead as unknown as WriteHeadProbe;
  rmSync(staticRoot, { recursive: true, force: true });
});

// --------------------------------------------------------------- tests
describe('createNotFoundHandler', () => {
  it('routes each URL to the intended branch and consults the injected fallback policy', async () => {
    const consulted: string[] = [];
    const handler = createNotFoundHandler({
      isSpaShellFallbackCandidate: (url) => {
        consulted.push(url);
        return !url.includes('.');
      },
    });

    const calls: unknown[][] = [];
    const reply = {
      code: (...args: unknown[]) => {
        calls.push(['code', ...args]);
        return reply;
      },
      type: (...args: unknown[]) => {
        calls.push(['type', ...args]);
        return reply;
      },
      send: (...args: unknown[]) => {
        calls.push(['send', ...args]);
        return reply;
      },
      sendFile: (...args: unknown[]) => {
        calls.push(['sendFile', ...args]);
        return reply;
      },
    };

    await handler({ url: '/api/sites' } as FastifyRequest, reply as unknown as FastifyReply);
    expect(calls).toEqual([['code', 404], ['send', { error: 'Not found' }]]);
    // API/JSON branches must not consult the shell policy at all.
    expect(consulted).toEqual([]);

    calls.length = 0;
    await handler({ url: '/assets/missing.js' } as FastifyRequest, reply as unknown as FastifyReply);
    expect(consulted).toEqual(['/assets/missing.js']);
    expect(calls).toEqual([
      ['code', 404],
      ['type', 'text/plain; charset=utf-8'],
      ['send', 'Not found'],
    ]);

    calls.length = 0;
    await handler({ url: '/settings' } as FastifyRequest, reply as unknown as FastifyReply);
    expect(consulted).toEqual(['/assets/missing.js', '/settings']);
    expect(calls).toEqual([['sendFile', 'index.html']]);
  });

  it('keeps the onSend chain single-pass on every 404 branch (compress + two async onSend hooks)', async () => {
    const { app, logs, origin } = await startProductionShapedApp();
    try {
      // 1) /api and /v1 misses: JSON 404.
      const apiMiss = await get(origin, logs, '/v1/props');
      expect(apiMiss.status).toBe(404);
      expect(apiMiss.body).toBe('{"error":"Not found"}');
      expect(apiMiss.contentType).toContain('application/json');
      expect(errorMarkersIn(apiMiss.logs)).toEqual([]);
      expect(apiMiss.writeHeads).toHaveLength(1);
      expect(apiMiss.writeHeads[0]).toMatchObject({ statusCode: 404, headersAlreadySent: false });

      // 2) Asset-like miss: plain-text 404, must NOT receive the SPA shell.
      const assetMiss = await get(origin, logs, '/assets/missing.js');
      expect(assetMiss.status).toBe(404);
      expect(assetMiss.body).toBe('Not found');
      expect(assetMiss.contentType).toContain('text/plain');
      expect(errorMarkersIn(assetMiss.logs)).toEqual([]);
      expect(assetMiss.writeHeads).toHaveLength(1);
      expect(assetMiss.writeHeads[0]).toMatchObject({ statusCode: 404, headersAlreadySent: false });

      // 3) SPA deep link: the shell (sendFile) branch.
      const shell = await get(origin, logs, '/settings');
      expect(shell.status).toBe(200);
      expect(shell.body).toBe(SHELL_HTML);
      expect(shell.contentType).toContain('text/html');
      expect(errorMarkersIn(shell.logs)).toEqual([]);
      expect(shell.writeHeads).toHaveLength(1);
      expect(shell.writeHeads[0]).toMatchObject({ statusCode: 200, headersAlreadySent: false });
    } finally {
      await app.close();
    }
  });
});

describe('notFoundHandler regression detector (counter-example)', () => {
  it('the send-then-resolve-undefined shape does trip ERR_HTTP_HEADERS_SENT + FST_ERR_REP_ALREADY_SENT', async () => {
    // Same app shape, but the not-found handler uses the buggy form:
    // `reply.send(...)` followed by resolving to undefined. If this stops
    // producing the two markers, the detector above has lost its power and the
    // regression test must not be trusted until this counter-example is fixed.
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        level: 'trace',
        stream: { write: (line: string) => logs.push(line) },
      },
    });
    await app.register(compress, { global: true });
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-test-onsend-1', '1');
      return payload;
    });
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-test-onsend-2', '1');
      return payload;
    });
    app.setNotFoundHandler(async (_request, reply) => {
      reply.code(404).send({ error: 'Not found' });
      // Implicitly resolves to undefined while the onSend chain is parked.
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    let outcome: RequestOutcome | null = null;
    try {
      outcome = await get(`http://127.0.0.1:${port}`, logs, '/v1/props');
      await waitForMarker(logs, 'ERR_HTTP_HEADERS_SENT');
      await waitForMarker(logs, 'FST_ERR_REP_ALREADY_SENT');
    } finally {
      await app.close();
    }

    expect(outcome).not.toBeNull();
    const buggy = outcome!;
    // The client still saw the 404 — that is exactly why this bug is easy to miss.
    expect(buggy.status).toBe(404);
    expect(buggy.body).toBe('{"error":"Not found"}');
    // ...but the same response ran the chain twice and hit the header errors.
    expect(errorMarkersIn(buggy.logs)).toEqual([
      'ERR_HTTP_HEADERS_SENT',
      'FST_ERR_REP_ALREADY_SENT',
    ]);
    expect(buggy.writeHeads.length).toBeGreaterThanOrEqual(2);
    expect(buggy.writeHeads.some((call) => call.headersAlreadySent)).toBe(true);
    // The markers are logged at warn/error level, so a stream configured for
    // info would still capture them (pino: 30 info, 40 warn, 50 error).
    for (const marker of HEADER_ERROR_MARKERS) {
      const levels = markerLogLevels(buggy.logs, marker);
      expect(levels.length).toBeGreaterThan(0);
      expect(Math.min(...levels)).toBeGreaterThanOrEqual(30);
    }
  });
});
