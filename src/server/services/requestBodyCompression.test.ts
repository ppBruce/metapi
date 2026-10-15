import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REQUEST_BODY_COMPRESSION_MIN_BYTES,
  REQUEST_BODY_ENCODING_CAPABILITY_HEADER,
  __getRequestBodyCompressionStatsForTests,
  __resetRequestBodyCompressionForTests,
  learnUpstreamRequestBodyEncoding,
  maybeCompressUpstreamRequestBody,
  resolveRequestOrigin,
  supportsCompressedRequestBody,
} from './requestBodyCompression.js';

const ORIGIN = 'https://peer.example.com';
const bigBody = JSON.stringify({
  messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
});
const smallBody = JSON.stringify({ model: 'x' });

function advertisement(value: string) {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === REQUEST_BODY_ENCODING_CAPABILITY_HEADER ? value : null,
    },
  };
}

describe('upstream request body compression (sender)', () => {
  beforeEach(() => __resetRequestBodyCompressionForTests());
  afterEach(() => __resetRequestBodyCompressionForTests());

  it('leaves the body untouched for an origin that never advertised support', async () => {
    const result = await maybeCompressUpstreamRequestBody({
      origin: ORIGIN,
      headers: { 'content-type': 'application/json' },
      bodyText: bigBody,
    });
    expect(result.compressed).toBe(false);
    expect(result.body).toBe(bigBody);
    expect(result.headers['content-encoding']).toBeUndefined();
  });

  it('compresses once the origin advertised gzip support', async () => {
    learnUpstreamRequestBodyEncoding(ORIGIN, advertisement('gzip'));
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(bigBody)),
    };
    const result = await maybeCompressUpstreamRequestBody({ origin: ORIGIN, headers, bodyText: bigBody });

    expect(result.compressed).toBe(true);
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(gunzipSync(result.body as Buffer).toString()).toBe(bigBody);
    expect(result.headers['content-encoding']).toBe('gzip');
    // A stale length now describes the uncompressed body and must not survive.
    expect(result.headers['content-length']).toBeUndefined();
    // The caller's header object stays untouched.
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['content-length']).toBe(String(Buffer.byteLength(bigBody)));
  });

  it('does not compress bodies below the size threshold', async () => {
    learnUpstreamRequestBodyEncoding(ORIGIN, advertisement('gzip'));
    expect(Buffer.byteLength(smallBody)).toBeLessThan(REQUEST_BODY_COMPRESSION_MIN_BYTES);

    const result = await maybeCompressUpstreamRequestBody({
      origin: ORIGIN,
      headers: {},
      bodyText: smallBody,
    });
    expect(result.compressed).toBe(false);
    expect(result.body).toBe(smallBody);
  });

  it('keeps an explicitly encoded body as-is', async () => {
    learnUpstreamRequestBodyEncoding(ORIGIN, advertisement('gzip'));
    const result = await maybeCompressUpstreamRequestBody({
      origin: ORIGIN,
      headers: { 'Content-Encoding': 'br' },
      bodyText: bigBody,
    });
    expect(result.compressed).toBe(false);
    expect(result.body).toBe(bigBody);
  });

  it('learns only from the capability header, and only for that origin', () => {
    learnUpstreamRequestBodyEncoding(ORIGIN, advertisement('br, deflate'));
    expect(supportsCompressedRequestBody(ORIGIN)).toBe(false);

    learnUpstreamRequestBodyEncoding(ORIGIN, advertisement('deflate, gzip'));
    expect(supportsCompressedRequestBody(ORIGIN)).toBe(true);
    expect(supportsCompressedRequestBody('https://other.example.com')).toBe(false);
    expect(supportsCompressedRequestBody(null)).toBe(false);

    learnUpstreamRequestBodyEncoding(ORIGIN, { headers: { get: () => null } });
    expect(supportsCompressedRequestBody(ORIGIN)).toBe(true);
  });

  it('bounds the capability registry', () => {
    for (let index = 0; index < 600; index += 1) {
      learnUpstreamRequestBodyEncoding(`https://peer-${index}.example.com`, advertisement('gzip'));
    }
    expect(__getRequestBodyCompressionStatsForTests().trackedOrigins).toBeLessThanOrEqual(512);
  });

  it('resolves the origin of an upstream target URL', () => {
    expect(resolveRequestOrigin('https://peer.example.com/v1/chat/completions')).toBe(ORIGIN);
    expect(resolveRequestOrigin('not a url')).toBeNull();
    expect(resolveRequestOrigin(null)).toBeNull();
  });
});
