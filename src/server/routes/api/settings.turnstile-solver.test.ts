import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

type DbModule = typeof import('../../db/index.js');

describe('Turnstile solver settings (settings table, masked key)', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-turnstile-solver-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./settings.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.settingsRoutes);
  });

  beforeEach(async () => {
    resetRequestRateLimitStore();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('defaults to disabled when no config exists (historical behavior)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.turnstileSolverEnabled).toBe(false);
    expect(body.turnstileSolverBaseUrl).toBe('');
    expect(body.turnstileSolverApiKeyMasked).toBe('');
    expect(body.turnstileSolverTimeoutSeconds).toBe(60);
  });

  it('persists enabled config and returns masked key, never plaintext', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        turnstileSolverEnabled: true,
        turnstileSolverBaseUrl: 'https://solver.example.com',
        turnstileSolverApiKey: 'sk-b26secret51charslongkeyvalue',
        turnstileSolverTimeoutSeconds: 90,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().success).toBe(true);

    const get = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    const body = get.json() as Record<string, unknown>;
    expect(body.turnstileSolverEnabled).toBe(true);
    expect(body.turnstileSolverBaseUrl).toBe('https://solver.example.com');
    expect(body.turnstileSolverApiKeyMasked).toBe('sk-b****alue');
    expect(body.turnstileSolverTimeoutSeconds).toBe(90);
    // Secret must not appear anywhere in the response.
    expect(get.body).not.toContain('sk-b26secret51charslongkeyvalue');
  });

  it('rejects enabling without a solver URL', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { turnstileSolverEnabled: true, turnstileSolverBaseUrl: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('求解器地址不能为空');
  });

  it('rejects a non-http(s) solver URL', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { turnstileSolverEnabled: true, turnstileSolverBaseUrl: 'ftp://bad' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('地址无效');
  });

  it('keeps existing apiKey when masked/empty input arrives (no accidental wipe)', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        turnstileSolverEnabled: true,
        turnstileSolverBaseUrl: 'https://solver.example.com',
        turnstileSolverApiKey: 'sk-b26secret51charslongkeyvalue',
      },
    });
    // Second PUT only flips the URL; no apiKey field. Stored key must survive.
    const put2 = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { turnstileSolverBaseUrl: 'https://solver.example.com/' },
    });
    expect(put2.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    const body = get.json() as Record<string, unknown>;
    expect(body.turnstileSolverApiKeyMasked).toBe('sk-b****alue');
  });

  it('allows an empty apiKey (self-hosted solvers need no auth)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        turnstileSolverEnabled: true,
        turnstileSolverBaseUrl: 'http://127.0.0.1:5091',
        turnstileSolverApiKey: '',
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    const body = get.json() as Record<string, unknown>;
    expect(body.turnstileSolverEnabled).toBe(true);
    expect(body.turnstileSolverBaseUrl).toBe('http://127.0.0.1:5091');
    expect(body.turnstileSolverApiKeyMasked).toBe('');
  });

  it('clamps timeoutSeconds to [15, 180]', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        turnstileSolverEnabled: true,
        turnstileSolverBaseUrl: 'https://solver.example.com',
        turnstileSolverTimeoutSeconds: 9999,
      },
    });
    const get = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect((get.json() as Record<string, unknown>).turnstileSolverTimeoutSeconds).toBe(180);
  });
});
