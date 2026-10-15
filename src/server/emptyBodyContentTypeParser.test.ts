import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureEmptyBodyContentTypeParser } from './emptyBodyContentTypeParser.js';

/**
 * A body-less POST loses its "no content type" status the moment it passes a
 * CDN/proxy that stamps one on (Cloudflare's edge sends
 * `application/octet-stream`), and Fastify then answers 415 before the handler
 * runs. Reproduced against the quick tunnel: the same request is 200 locally and
 * 415 through the tunnel, which silently killed every action endpoint that takes
 * no body — including the usage-log SSE stream behind the auto-refresh button.
 */
describe('empty-body content-type tolerance', () => {
  const apps: FastifyInstance[] = [];

  const build = async () => {
    const app = Fastify();
    ensureEmptyBodyContentTypeParser(app);
    app.post('/action', async (request) => ({ ok: true, body: request.body ?? null }));
    app.post('/json', async (request) => ({ ok: true, body: request.body ?? null }));
    apps.push(app);
    await app.ready();
    return app;
  };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('accepts a body-less POST whose media type the edge stamped', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/action',
      headers: { 'content-type': 'application/octet-stream' },
      payload: '',
    });
    expect(response.statusCode).toBe(200);
  });

  it('still rejects a non-empty body in an unparsed media type', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/action',
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'not-empty',
    });
    expect(response.statusCode).toBe(415);
  });

  it('leaves the built-in JSON parser untouched', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, body: { hello: 'world' } });
  });

  it('keeps the plain-text parser working', async () => {
    const app = await build();
    const response = await app.inject({
      method: 'POST',
      url: '/action',
      headers: { 'content-type': 'text/plain' },
      payload: 'ping',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, body: 'ping' });
  });
});
