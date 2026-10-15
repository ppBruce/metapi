import { createGunzip, gzip as gzipCallback } from 'node:zlib';
import { Transform, type TransformCallback } from 'node:stream';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';

/**
 * Compressed request bodies for cascaded metapi instances.
 *
 * A cascade hop re-uploads the whole prompt (hundreds of KB on agent traffic)
 * through a Cloudflare tunnel, which is the dominant part of the extra latency
 * the cascade adds. Both ends of such a hop are metapi, so the body can travel
 * gzipped: the receiving instance advertises the capability on every response
 * (`x-metapi-body-encoding`), the sending instance only compresses towards
 * origins that advertised it. An unpatched peer never advertises, so it keeps
 * receiving plain JSON — the negotiation makes this safe to roll out one side
 * at a time.
 */

/** Advertised by the receiving instance, learned by the sending one. */
export const REQUEST_BODY_ENCODING_CAPABILITY_HEADER = 'x-metapi-body-encoding';
export const REQUEST_BODY_GZIP_ENCODING = 'gzip';

/** Below this size the CPU + header overhead is not worth it. */
export const REQUEST_BODY_COMPRESSION_MIN_BYTES = 4096;

/** Zip-bomb guard: hard cap on the decompressed size of an inbound body. */
export const MAX_DECOMPRESSED_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Bounded registry of origins that advertised support (LRU by recency). */
const CAPABILITY_CACHE_MAX_ENTRIES = 512;

const gzipAsync = promisify(gzipCallback);

const supportedOrigins = new Map<string, true>();

let maxDecompressedRequestBodyBytes = MAX_DECOMPRESSED_REQUEST_BODY_BYTES;

export type UpstreamRequestBody = {
  headers: Record<string, string>;
  body: string | Buffer;
  compressed: boolean;
};

function findHeaderName(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === wanted);
}

/** Origin (scheme://host[:port]) of an upstream URL, or null when unparseable. */
export function resolveRequestOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Learn from an upstream response that this origin can decode gzip request
 * bodies. Called for every response (success and failure alike) so a single
 * real request is enough to enable compression for that origin.
 */
export function learnUpstreamRequestBodyEncoding(
  origin: string | null,
  response: { headers?: { get?: (name: string) => string | null } | null } | null | undefined,
): void {
  if (!origin) return;
  const raw = response?.headers?.get?.(REQUEST_BODY_ENCODING_CAPABILITY_HEADER);
  if (typeof raw !== 'string' || raw.length === 0) return;
  const encodings = raw.split(',').map((value) => value.trim().toLowerCase());
  if (!encodings.includes(REQUEST_BODY_GZIP_ENCODING)) return;

  if (supportedOrigins.has(origin)) supportedOrigins.delete(origin);
  supportedOrigins.set(origin, true);
  while (supportedOrigins.size > CAPABILITY_CACHE_MAX_ENTRIES) {
    const oldest = supportedOrigins.keys().next();
    if (oldest.done) break;
    supportedOrigins.delete(oldest.value);
  }
}

export function supportsCompressedRequestBody(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (!supportedOrigins.has(origin)) return false;
  // Refresh recency: `get` alone does not move a key in Map iteration order.
  supportedOrigins.delete(origin);
  supportedOrigins.set(origin, true);
  return true;
}

/**
 * Normalize undici's several header shapes (Headers | Map | string[][] | record)
 * to a plain record. Returns null when the shape is not recognized — callers
 * must then leave the request alone rather than rebuild its headers.
 *
 * Duck-typing, NOT `instanceof Headers`: the npm `undici` package ships its own
 * `Headers` class, so `new (require('undici').Headers)() instanceof
 * globalThis.Headers` is false. Snapshotting such an instance with a spread
 * yields `{}` and silently drops Authorization — which the receiving instance
 * answers with `401 Missing Authorization`.
 */
export function toPlainHeaderRecord(headers: unknown): Record<string, string> | null {
  if (!headers) return {};
  const candidate = headers as {
    forEach?: (cb: (value: unknown, key: unknown) => void) => void;
    entries?: () => Iterable<[unknown, unknown]>;
    get?: (key: unknown) => unknown;
  };
  if (headers instanceof Map) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[String(key)] = String(value);
    return out;
  }
  // Arrays must be checked before the generic `entries()` branch: an array also
  // has `.entries()`, but it yields [index, value] and would mangle the pairs.
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const entry of headers as [string, string][]) {
      if (Array.isArray(entry) && entry.length >= 2) out[String(entry[0])] = String(entry[1]);
    }
    return out;
  }
  if (typeof candidate.forEach === 'function' && typeof candidate.get === 'function') {
    const out: Record<string, string> = {};
    candidate.forEach((value, key) => {
      out[String(key)] = String(value);
    });
    return out;
  }
  if (typeof candidate.entries === 'function') {
    const out: Record<string, string> = {};
    for (const entry of candidate.entries()) {
      if (Array.isArray(entry) && entry.length >= 2) out[String(entry[0])] = String(entry[1]);
    }
    return out;
  }
  if (typeof headers === 'object' && Object.getPrototypeOf(headers) === Object.prototype) {
    return { ...(headers as Record<string, string>) };
  }
  return null;
}

/**
 * Gzip an upstream request body when the origin is known to accept it.
 * Returns the input untouched (same header object, string body) otherwise.
 */
export async function maybeCompressUpstreamRequestBody(input: {
  origin: string | null;
  headers: Record<string, string>;
  bodyText: string;
}): Promise<UpstreamRequestBody> {
  const { origin, headers, bodyText } = input;
  const unchanged: UpstreamRequestBody = { headers, body: bodyText, compressed: false };
  if (!supportsCompressedRequestBody(origin)) return unchanged;
  if (Buffer.byteLength(bodyText) < REQUEST_BODY_COMPRESSION_MIN_BYTES) return unchanged;
  if (findHeaderName(headers, 'content-encoding')) return unchanged;

  const body = await gzipAsync(Buffer.from(bodyText));
  const nextHeaders: Record<string, string> = { ...headers };
  const contentLength = findHeaderName(nextHeaders, 'content-length');
  if (contentLength) delete nextHeaders[contentLength];
  const contentEncoding = findHeaderName(nextHeaders, 'content-encoding');
  if (contentEncoding) delete nextHeaders[contentEncoding];
  nextHeaders['content-encoding'] = REQUEST_BODY_GZIP_ENCODING;
  return { headers: nextHeaders, body, compressed: true };
}

function toStatusError(message: string, statusCode: number, code: string): Error {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function createDecompressedBodyLimitTransform(): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      total += chunk.length;
      if (total > maxDecompressedRequestBodyBytes) {
        callback(
          toStatusError(
            'Compressed request body exceeds the decompression limit',
            413,
            'FST_ERR_CTP_BODY_TOO_LARGE',
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function readGzipContentEncoding(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === REQUEST_BODY_GZIP_ENCODING || part === 'x-gzip');
}

/**
 * Receiver side: decode `Content-Encoding: gzip` request bodies and advertise
 * the capability. Inert for every request that does not declare the header, so
 * existing clients see byte-identical behaviour.
 */
export function registerCompressedRequestBodySupport(app: FastifyInstance): void {
  const target = app as FastifyInstance & { __metapiRequestBodyCompressionRegistered?: boolean };
  if (target.__metapiRequestBodyCompressionRegistered) return;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header(REQUEST_BODY_ENCODING_CAPABILITY_HEADER, REQUEST_BODY_GZIP_ENCODING);
    return payload;
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!readGzipContentEncoding(request.headers['content-encoding'])) return payload;

    // The decoded stream is what the content type parsers must see, and its
    // length differs from the compressed one.
    delete request.headers['content-encoding'];
    delete request.headers['content-length'];

    const gunzip = createGunzip();
    const limited = createDecompressedBodyLimitTransform();
    gunzip.on('error', (error: unknown) => {
      limited.destroy(
        toStatusError(
          `Failed to decompress request body: ${error instanceof Error ? error.message : String(error)}`,
          400,
          'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        ),
      );
    });
    return payload.pipe(gunzip).pipe(limited);
  });

  target.__metapiRequestBodyCompressionRegistered = true;
}

/** Test helpers. */
export function __resetRequestBodyCompressionForTests(): void {
  supportedOrigins.clear();
  maxDecompressedRequestBodyBytes = MAX_DECOMPRESSED_REQUEST_BODY_BYTES;
}

export function __setMaxDecompressedRequestBodyBytesForTests(bytes: number): void {
  maxDecompressedRequestBodyBytes = bytes;
}

export function __getRequestBodyCompressionStatsForTests(): { trackedOrigins: number } {
  return { trackedOrigins: supportedOrigins.size };
}
