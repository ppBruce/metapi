import { gzipSync, zstdCompressSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REQUEST_BODY_ENCODING_CAPABILITY_HEADER,
  __resetRequestBodyCompressionForTests,
  __setMaxDecompressedRequestBodyBytesForTests,
  advertisedRequestBodyEncodings,
  parseRequestBodyEncoding,
  registerCompressedRequestBodySupport,
} from './requestBodyCompression.js';

/**
 * Receiver side of the cascade-hop body compression: a cascaded instance sends
 * the prompt compressed, this instance must decode it exactly like plain JSON
 * and advertise which encodings it can decode so the sender knows what it may
 * use.
 */
describe('compressed request body support (receiver)', () => {
  const apps: FastifyInstance[] = [];

  const build = async () => {
    const app = Fastify();
    registerCompressedRequestBodySupport(app);
    app.post('/v1/chat/completions', async (request) => ({
      ok: true,
      body: request.body ?? null,
    }));
    apps.push(app);
    await app.ready();
    return app;
  };

  beforeEach(() => __resetRequestBodyCompressionForTests());

  afterEach(async () => {
    __resetRequestBodyCompressionForTests();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('advertises every decodable encoding on responses', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers[REQUEST_BODY_ENCODING_CAPABILITY_HEADER]).toBe(
      advertisedRequestBodyEncodings().join(', '),
    );
    expect(String(response.headers[REQUEST_BODY_ENCODING_CAPABILITY_HEADER])).toContain('gzip');
  });

  it('parses a gzip request body exactly like the plain one', async () => {
    const app = await build();
    const body = { model: 'm', messages: [{ role: 'user', content: '你好'.repeat(500) }] };

    const plain = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    const compressed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify(body))),
    });

    expect(compressed.statusCode).toBe(200);
    expect(compressed.json()).toEqual(plain.json());
    expect(compressed.json().body).toEqual(body);
  });

  it('parses a zstd request body exactly like the plain one', async () => {
    const app = await build();
    const body = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(40_000) }] };

    const plain = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    const compressed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      payload: zstdCompressSync(Buffer.from(JSON.stringify(body))),
    });

    expect(compressed.statusCode).toBe(200);
    expect(compressed.json()).toEqual(plain.json());
    expect(compressed.json().body).toEqual(body);
  });

  it('rejects a compressed body that decompresses past the limit', async () => {
    const app = await build();
    __setMaxDecompressedRequestBodyBytesForTests(1024);
    const payload = JSON.stringify({ blob: 'x'.repeat(50_000) });
    const limited = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        payload: gzipSync(Buffer.from(payload)),
      }),
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
        payload: zstdCompressSync(Buffer.from(payload)),
      }),
    ]);
    expect(limited.map((response) => response.statusCode)).toEqual([413, 413]);
  });

  it('rejects bodies that are not valid gzip or zstd', async () => {
    const app = await build();
    const responses = await Promise.all(['gzip', 'zstd'].map((contentEncoding) =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-encoding': contentEncoding },
        payload: Buffer.from(`definitely not ${contentEncoding}`),
      }),
    ));
    for (const response of responses) expect(response.statusCode).toBe(400);
  });

  it('does not intercept encodings it cannot decode', async () => {
    const app = await build();
    // `br` is not ours to decode: the hook leaves the payload alone and the JSON
    // parser then sees still-encoded bytes, which it rejects as an invalid body.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      payload: Buffer.from('whatever'),
    });
    expect(response.statusCode).toBe(400);
  });

  it('reads a single encoding token, and refuses to half-decode a chain', () => {
    expect(parseRequestBodyEncoding('gzip')).toBe('gzip');
    expect(parseRequestBodyEncoding(' zstd ')).toBe('zstd');
    expect(parseRequestBodyEncoding('x-gzip')).toBe('gzip');
    expect(parseRequestBodyEncoding('identity')).toBeNull();
    expect(parseRequestBodyEncoding('br, deflate')).toBeNull();
    // A chain would need reverse-order decoding; we must not do half of it.
    expect(parseRequestBodyEncoding('gzip, zstd')).toBeNull();
    expect(parseRequestBodyEncoding(undefined)).toBeNull();
  });
});
