import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../db/index.js');
type UploadModule = typeof import('./requestBodyChunkedUpload.js');

/**
 * Authentication of the striped-upload receiver route.
 *
 * A cascaded sender uploads the parts of a request with THAT request's headers,
 * so the receiver must accept the request's own downstream key — not only the
 * admin token the other peer endpoints require, which is what the route used to
 * demand (and which no real cascade ever presents: the sender's fetch-stub unit
 * tests could not catch that, this suite does). Anything else stays the bare 401
 * of the /api/v1/peer surface, and a refused part must never reach the buffer.
 */

// DB-backed suite: db/index.ts resolves the sqlite path when it is first
// imported, so DATA_DIR must be set before any import that reaches it.
const dataDir = mkdtempSync(join(tmpdir(), 'metapi-chunked-upload-auth-'));
process.env.DATA_DIR = dataDir;

const ADMIN_TOKEN = 'chunked-upload-auth-admin-token';
const DOWNSTREAM_KEY = 'sk-chunked-upload-auth-key';
const DISABLED_KEY = 'sk-chunked-upload-auth-disabled';

type Part = { index: number; partCount: number; sha256: string; bytes: Buffer };

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('striped upload part authentication', () => {
  let upload: UploadModule;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let keyId = 0;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    const { config } = await import('../config.js');
    (config as { authToken: string }).authToken = ADMIN_TOKEN;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    upload = await import('./requestBodyChunkedUpload.js');
  });

  beforeEach(async () => {
    upload.__resetChunkedBodyUploadForTests();
    await db.delete(schema.downstreamApiKeys).run();
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'cascade-peer',
      key: DOWNSTREAM_KEY,
      enabled: true,
      // A request budget, so any per-part billing would be visible as
      // usedRequests > 0 (and would eventually refuse the real request).
      maxRequests: 100,
    }).returning().get();
    keyId = row.id;
    await db.insert(schema.downstreamApiKeys).values({
      name: 'disabled-peer',
      key: DISABLED_KEY,
      enabled: false,
    }).run();
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    delete process.env.DATA_DIR;
  });

  const buildApp = async (): Promise<FastifyInstance> => {
    const app = Fastify();
    upload.registerChunkedBodyUploadRoutes(app);
    app.get('/ping', async () => ({ ok: true }));
    apps.push(app);
    await app.ready();
    return app;
  };

  const partsOf = (body: Buffer, partCount: number): Part[] => {
    const partSize = Math.ceil(body.length / partCount);
    return Array.from({ length: partCount }, (_unused, index) => ({
      index,
      partCount,
      sha256: sha256(body),
      bytes: body.subarray(index * partSize, Math.min((index + 1) * partSize, body.length)),
    }));
  };

  const partHeaders = (
    meta: { uploadId: string } & Part,
    credential: Record<string, string>,
  ): Record<string, string> => ({
    ...credential,
    'content-type': 'application/octet-stream',
    [upload.REQUEST_BODY_UPLOAD_ID_HEADER]: meta.uploadId,
    [upload.REQUEST_BODY_UPLOAD_PART_INDEX_HEADER]: String(meta.index),
    [upload.REQUEST_BODY_UPLOAD_PART_COUNT_HEADER]: String(meta.partCount),
    [upload.REQUEST_BODY_UPLOAD_SHA256_HEADER]: meta.sha256,
    [upload.REQUEST_BODY_UPLOAD_ENCODING_HEADER]: 'gzip',
  });

  const postPart = (
    app: FastifyInstance,
    uploadId: string,
    part: Part,
    credential: Record<string, string>,
  ) => app.inject({
    method: 'POST',
    url: `${upload.REQUEST_BODY_UPLOAD_ROUTE_PREFIX}/${uploadId}/${part.index}`,
    headers: partHeaders({ uploadId, ...part }, credential),
    payload: part.bytes,
  });

  const expectNothingStored = () => {
    expect(upload.__getChunkedBodyUploadStatsForTests()).toEqual({
      pendingUploads: 0,
      bufferedBytes: 0,
    });
  };

  it('accepts parts authorized by the request\'s own downstream key and reassembles the body', async () => {
    const app = await buildApp();
    const body = randomBytes(upload.REQUEST_BODY_UPLOAD_MIN_BYTES * 2);
    const parts = partsOf(body, 2);

    for (const part of parts) {
      const response = await postPart(app, 'u-downstream', part, {
        authorization: `Bearer ${DOWNSTREAM_KEY}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    }

    const assembled = upload.assembleUploadedBody('u-downstream');
    expect(assembled?.encoding).toBe('gzip');
    expect(assembled?.compressed.equals(body)).toBe(true);
  });

  it('accepts the downstream key in x-api-key like the proxy does', async () => {
    const app = await buildApp();
    const body = randomBytes(upload.REQUEST_BODY_UPLOAD_MIN_BYTES * 2);
    const parts = partsOf(body, 2);

    for (const part of parts) {
      const response = await postPart(app, 'u-api-key', part, { 'x-api-key': DOWNSTREAM_KEY });
      expect(response.statusCode).toBe(200);
    }
    expect(upload.assembleUploadedBody('u-api-key')?.compressed.equals(body)).toBe(true);
  });

  it('does not bill the downstream key for the parts it authenticates', async () => {
    // The parts are fragments of ONE request; charging them against the key's
    // request/RPM/in-flight budgets would inflate usage and could refuse the
    // real request that follows.
    const app = await buildApp();
    const body = randomBytes(upload.REQUEST_BODY_UPLOAD_MIN_BYTES * 2);
    for (const part of partsOf(body, 2)) {
      const response = await postPart(app, 'u-accounting', part, {
        authorization: `Bearer ${DOWNSTREAM_KEY}`,
      });
      expect(response.statusCode).toBe(200);
    }

    const row = await db.select().from(schema.downstreamApiKeys)
      .where(eq(schema.downstreamApiKeys.id, keyId))
      .get();
    expect(Number(row?.usedRequests ?? 0)).toBe(0);
    expect(row?.lastUsedAt ?? null).toBeNull();
  });

  it('still accepts the admin token, as every peer endpoint does', async () => {
    const app = await buildApp();
    const body = randomBytes(upload.REQUEST_BODY_UPLOAD_MIN_BYTES * 2);
    const parts = partsOf(body, 2);

    for (const part of parts) {
      const response = await postPart(app, 'u-admin', part, {
        authorization: `Bearer ${ADMIN_TOKEN}`,
      });
      expect(response.statusCode).toBe(200);
    }

    const assembled = upload.assembleUploadedBody('u-admin');
    expect(assembled?.encoding).toBe('gzip');
    expect(assembled?.compressed.equals(body)).toBe(true);
  });

  it('refuses a part with no credential and buffers nothing', async () => {
    const app = await buildApp();
    const body = randomBytes(upload.REQUEST_BODY_UPLOAD_MIN_BYTES * 2);

    const response = await postPart(app, 'u-anon', partsOf(body, 2)[0], {});

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid token' });
    expectNothingStored();
  });

  it('refuses a token that is neither the admin token nor a known downstream key', async () => {
    const app = await buildApp();
    const body = randomBytes(upload.REQUEST_BODY_UPLOAD_MIN_BYTES * 2);

    const response = await postPart(app, 'u-wrong', partsOf(body, 2)[0], {
      authorization: 'Bearer sk-not-a-real-key',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid token' });
    expectNothingStored();
  });

  it('refuses a downstream key the service rejects (disabled) and buffers nothing', async () => {
    const app = await buildApp();
    const body = randomBytes(upload.REQUEST_BODY_UPLOAD_MIN_BYTES * 2);

    const response = await postPart(app, 'u-disabled', partsOf(body, 2)[0], {
      authorization: `Bearer ${DISABLED_KEY}`,
    });

    expect(response.statusCode).toBe(401);
    expectNothingStored();
  });

  it('does not authenticate the upload route with the admin token alone outside the scope', async () => {
    // The hook lives in the upload plugin's own scope: unrelated routes keep
    // their own handling (here: no auth hook at all) and are unaffected.
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/ping' });
    expect(response.statusCode).toBe(200);
    expect(upload.__getChunkedBodyUploadStatsForTests().pendingUploads).toBe(0);
  });
});
