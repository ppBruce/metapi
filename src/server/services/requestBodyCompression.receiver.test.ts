import { gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REQUEST_BODY_ENCODING_CAPABILITY_HEADER,
  __resetRequestBodyCompressionForTests,
  __setMaxDecompressedRequestBodyBytesForTests,
  registerCompressedRequestBodySupport,
} from './requestBodyCompression.js';

/**
 * Receiver side of the cascade-hop body compression: a cascaded instance sends
 * the prompt gzipped, this instance must decode it exactly like plain JSON and
 * advertise the capability so the sender knows it may compress.
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

  it('advertises the capability on responses', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers[REQUEST_BODY_ENCODING_CAPABILITY_HEADER]).toBe('gzip');
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

  it('rejects a compressed body that decompresses past the limit', async () => {
    const app = await build();
    __setMaxDecompressedRequestBodyBytesForTests(1024);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify({ blob: 'x'.repeat(50_000) }))),
    });
    expect(response.statusCode).toBe(413);
  });

  it('rejects a body that is not valid gzip', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: Buffer.from('definitely not gzip'),
    });
    expect(response.statusCode).toBe(400);
  });
});
