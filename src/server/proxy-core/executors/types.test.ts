import { gzipSync, gunzipSync, zstdCompressSync } from 'node:zlib';
import { Response } from 'undici';
import { describe, expect, it } from 'vitest';
import { enrichTransportFailure, getRuntimeResponseReader, materializeErrorResponse, MAX_JSON_UPSTREAM_BODY_TEXT_CHARS, performFetch, readRuntimeResponseText } from './types.js';

describe('readRuntimeResponseText', () => {
  it('decompresses zstd responses before reading the body text', async () => {
    const payload = JSON.stringify({ ok: true, text: 'hello zstd' });
    const response = new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'application/json; charset=utf-8',
      },
    });

    await expect(readRuntimeResponseText(response)).resolves.toBe(payload);
  });

  it('decompresses stacked content-encodings in reverse order', async () => {
    const payload = JSON.stringify({ ok: true, text: 'stacked' });
    const response = new Response(
      zstdCompressSync(gzipSync(Buffer.from(payload))),
      {
        status: 200,
        headers: {
          'content-encoding': 'gzip, zstd',
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );

    await expect(readRuntimeResponseText(response)).resolves.toBe(payload);
  });

  it('truncates oversized bodies to protect process memory', async () => {
    // Build a body larger than the 1 MiB cap.
    const bigPayload = `{"error":"${'x'.repeat(2 * 1024 * 1024)}"}`;
    const response = new Response(bigPayload, {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    const text = await readRuntimeResponseText(response);
    expect(text.length).toBeLessThan(bigPayload.length);
    expect(text).toContain('[truncated');
  });

  it('passes through bodies within the cap unchanged', async () => {
    const payload = JSON.stringify({ ok: true, text: 'within cap' });
    const response = new Response(payload, {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(readRuntimeResponseText(response)).resolves.toBe(payload);
  });

  it('honours a larger explicit maxChars so legitimate big JSON survives intact', async () => {
    // /v1/images and friends can return a multi-MiB b64_json payload or a
    // dense embedding vector array; the caller opts in to a bigger cap and
    // the full body must round-trip parseable.
    const bigPayload = JSON.stringify({
      data: [{ b64_json: 'A'.repeat(2 * 1024 * 1024) }],
    });
    const response = new Response(bigPayload, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    const text = await readRuntimeResponseText(response, {
      maxChars: MAX_JSON_UPSTREAM_BODY_TEXT_CHARS,
    });
    expect(text).toBe(bigPayload);
    expect(JSON.parse(text).data[0].b64_json).toHaveLength(2 * 1024 * 1024);
  });

  it('rejects an oversized successful JSON body instead of forwarding truncated JSON', async () => {
    const bigPayload = JSON.stringify({ data: [{ b64_json: 'B'.repeat(2 * 1024 * 1024) }] });
    const response = new Response(bigPayload, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(readRuntimeResponseText(response, { maxChars: 1024, rejectOnOverflow: true }))
      .rejects.toThrow('exceeds');
  });

  it('preserves the truncation marker for oversized error bodies with a custom maxChars', async () => {
    const response = new Response('E'.repeat(2_048), { status: 500 });
    const text = await readRuntimeResponseText(response, { maxChars: 1_024 });
    expect(text).toContain('[truncated');
    expect(text.length).toBeLessThan(2_048);
  });

  it('cancels an oversized streaming body without waiting for the upstream to close', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_192));
        // Intentionally never close: an unbounded reader will hang.
      },
      cancel() { cancelled = true; },
    }), { status: 500 });
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 200);
    try {
      const text = await readRuntimeResponseText(response, {
        maxChars: 1_024, signal: controller.signal,
      });
      expect(text).toContain('[truncated');
      expect(cancelled).toBe(true);
    } finally {
      clearTimeout(fallback);
    }
  });

  it('cancels a non-stream body that goes idle after its first chunk', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":true}'));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    await expect(readRuntimeResponseText(response, { idleTimeoutMs: 30 }))
      .rejects.toThrow('response body idle timeout');
    expect(cancelled).toBe(true);
  });

  it('cancels a non-stream body when the caller aborts while waiting for more data', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"partial":true}'));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

    const pending = readRuntimeResponseText(response, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });

  it('decompresses a gzip body while the idle guard is active', async () => {
    const payload = JSON.stringify({ ok: true, text: 'gzipped with guard' });
    const response = new Response(gzipSync(Buffer.from(payload)), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });

    await expect(readRuntimeResponseText(response, { idleTimeoutMs: 5_000 }))
      .resolves.toBe(payload);
  });

  it('decompresses a zstd body exactly once while the idle guard is active', async () => {
    const payload = JSON.stringify({ ok: true, text: 'zstd with guard' });
    const response = new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
    });

    await expect(readRuntimeResponseText(response, { idleTimeoutMs: 5_000 }))
      .resolves.toBe(payload);
  });
});

describe('materializeErrorResponse', () => {
  it('decodes compressed error bodies and strips compression headers', async () => {
    const payload = JSON.stringify({ error: { message: 'upstream failed' } });
    const response = new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 503,
      headers: {
        'content-encoding': 'zstd',
        'content-length': '999',
        'content-type': 'application/json; charset=utf-8',
      },
    });

    const materialized = await materializeErrorResponse(response);

    await expect(materialized.text()).resolves.toBe(payload);
    expect(materialized.headers.get('content-encoding')).toBeNull();
    expect(materialized.headers.get('content-length')).toBeNull();
    expect(materialized.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('getRuntimeResponseReader', () => {
  it('falls back to the original stream when the body is already decompressed despite a zstd header', async () => {
    const payload = 'data: {"ok":true}\n\n';
    const response = new Response(payload, {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });

    const reader = getRuntimeResponseReader(response);

    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();

    expect(firstChunk?.done).toBe(false);
    expect(Buffer.from(firstChunk?.value ?? []).toString('utf8')).toBe(payload);
  });

  it('decompresses stacked streaming encodings when zstd is not the outermost layer', async () => {
    const payload = 'data: {"ok":true,"kind":"stacked"}\n\n';
    const response = new Response(gzipSync(zstdCompressSync(Buffer.from(payload))), {
      status: 200,
      headers: {
        'content-encoding': 'zstd, gzip',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });

    const reader = getRuntimeResponseReader(response);

    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();

    expect(firstChunk?.done).toBe(false);
    expect(Buffer.from(firstChunk?.value ?? []).toString('utf8')).toBe(payload);
  });
});

describe('enrichTransportFailure', () => {
  const fetchFailed = (cause: unknown) => {
    const error = new TypeError('fetch failed') as TypeError & { cause?: unknown };
    error.cause = cause;
    return error;
  };

  it('folds a DNS cause into the message', () => {
    const error = fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      code: 'ENOTFOUND',
      hostname: 'api.example.com',
    }));

    expect(enrichTransportFailure(error).message).toBe('fetch failed (ENOTFOUND api.example.com)');
  });

  it('folds every attempted address of an AggregateError', () => {
    const error = fetchFailed(new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED', address: '::1', port: 443 }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 443 }),
    ], 'all addresses failed'));

    expect(enrichTransportFailure(error).message)
      .toBe('fetch failed (ECONNREFUSED ::1:443; ECONNREFUSED 127.0.0.1:443)');
  });

  it('reports an undici timeout code', () => {
    const error = fetchFailed(Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }));

    expect(enrichTransportFailure(error).message).toBe('fetch failed (UND_ERR_CONNECT_TIMEOUT)');
  });

  it('keeps the original object identity so abort detection still works', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(enrichTransportFailure(abort)).toBe(abort);
    expect(enrichTransportFailure(abort).message).toBe('This operation was aborted');
  });

  it('leaves unrelated errors and causeless failures untouched', () => {
    const other = new Error('upstream said no');
    expect(enrichTransportFailure(other).message).toBe('upstream said no');

    const noCause = new TypeError('fetch failed');
    expect(enrichTransportFailure(noCause).message).toBe('fetch failed');

    expect(enrichTransportFailure('not an error')).toBe('not an error');
  });
});

describe('performFetch stale-connection retry', () => {
  it('retries once when the pooled socket dies before a response arrives', async () => {
    const { createServer } = await import('node:net');
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      if (connections === 1) {
        // Exactly what an upstream closing an idle keep-alive socket looks like.
        socket.destroy();
        return;
      }
      socket.on('data', () => {
        const body = '{"ok":true}';
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
        );
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as { port: number };

    try {
      const request = {
        endpoint: 'chat' as const,
        path: '/v1/chat/completions',
        headers: {},
        body: { model: 'm' },
      };
      const response = await performFetch(
        {
          siteUrl: `http://127.0.0.1:${address.port}`,
          request,
          buildInit: () => ({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"model":"m"}',
          }),
        },
        request,
      );

      expect(response.status).toBe(200);
      await expect(readRuntimeResponseText(response)).resolves.toBe('{"ok":true}');
      expect(connections).toBe(2);
    } finally {
      server.close();
    }
  });
});

/**
 * Cascade hops (metapi -> tunnel -> metapi) re-upload the whole prompt. The
 * compression must live in performFetch, the single fetch point every runtime
 * executor shares — wiring it only into endpointFlow's default-fetch branch
 * leaves production chat traffic (which passes a dispatch hook) uncompressed.
 */
describe('performFetch cascade request-body compression', () => {
  it('learns the upstream capability from a response, then gzips the next request', async () => {
    const { createServer } = await import('node:http');
    const received: { headers: Record<string, string | string[] | undefined>; raw: Buffer }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-metapi-body-encoding': 'gzip',
        });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ model: 'm', input: 'x'.repeat(50_000) });
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };
    const input = {
      siteUrl: origin,
      request,
      buildInit: () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    __resetRequestBodyCompressionForTests();
    try {
      // Capability unknown yet: the first request travels plain.
      await performFetch(input, request);
      expect(received[0].headers['content-encoding']).toBeUndefined();
      expect(received[0].raw.toString()).toBe(body);

      // The response advertised support: the next request is gzipped.
      await performFetch(input, request);
      expect(received[1].headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(received[1].raw).toString()).toBe(body);
      expect(received[1].raw.length).toBeLessThan(body.length / 4);
    } finally {
      __resetRequestBodyCompressionForTests();
      server.close();
    }
  });

  it('leaves the body alone for an origin that never advertised support', async () => {
    const { createServer } = await import('node:http');
    let raw = Buffer.alloc(0);
    let sentEncoding: string | undefined;
    const server = createServer((req, res) => {
      sentEncoding = req.headers['content-encoding'] as string | undefined;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        raw = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const body = JSON.stringify({ model: 'm', input: 'x'.repeat(50_000) });
    const request = {
      endpoint: 'chat' as const,
      path: '/v1/chat/completions',
      headers: {},
      body: { model: 'm' },
    };

    const { __resetRequestBodyCompressionForTests } = await import(
      '../../services/requestBodyCompression.js'
    );
    __resetRequestBodyCompressionForTests();
    try {
      await performFetch(
        {
          siteUrl: `http://127.0.0.1:${port}`,
          request,
          buildInit: () => ({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          }),
        },
        request,
      );
      expect(sentEncoding).toBeUndefined();
      expect(raw.toString()).toBe(body);
    } finally {
      __resetRequestBodyCompressionForTests();
      server.close();
    }
  });
});
