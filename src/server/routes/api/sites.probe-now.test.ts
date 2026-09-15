import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { probeRuntimeModelMock, fetchMock } = vi.hoisted(() => ({
  probeRuntimeModelMock: vi.fn(),
  fetchMock: vi.fn(),
}));

// Keep this route/service regression entirely local, with no real credentials.
vi.mock('dotenv/config', () => ({}));
vi.mock('../../services/runtimeModelProbe.js', () => ({
  probeRuntimeModel: probeRuntimeModelMock,
}));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: fetchMock,
}));

type DbModule = typeof import('../../db/index.js');

describe('POST /api/sites/:id/probe-now target selection', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let stopDispatcherCacheSweep: (() => void) | undefined;
  let dataDir = '';
  let siteId: number;
  let accountId: number;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-probe-now-target-'));
    vi.stubEnv('DATA_DIR', dataDir);
    vi.stubEnv('DB_TYPE', 'sqlite');
    vi.stubEnv('DB_URL', join(dataDir, 'hub.db'));
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockRejectedValue(new Error('Unexpected network request in probe target test'));

    await import('../../db/migrate.js');
    ({ db, schema, closeDbConnections } = await import('../../db/index.js'));
    ({ stopDispatcherCacheSweep } = await import('../../services/siteProxy.js'));
    app = Fastify();
    await app.register((await import('./sites.js')).sitesRoutes);
  });

  beforeEach(async () => {
    probeRuntimeModelMock.mockReset().mockResolvedValue({
      status: 'supported', latencyMs: 12, reason: 'test fixture',
    });
    fetchMock.mockClear();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: 'probe-target-site',
      url: 'https://probe-target.example.invalid',
      platform: 'new-api',
      status: 'active',
      postRefreshProbeScope: 'single',
      postRefreshProbeModel: 'deepseek-v4-flash',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'probe-target-test',
      accessToken: '',
      status: 'active',
    }).returning().get();
    accountId = account.id;
    await db.insert(schema.modelAvailability).values({
      accountId, modelName: 'deepseek-v4-flash', available: true,
    }).run();
  });

  afterEach(() => {
    expect(fetchMock).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    await app?.close();
    stopDispatcherCacheSweep?.();
    await closeDbConnections?.();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    { modelName: 'claude-opus-5' },
    { scope: 'single', modelName: 'claude-opus-5' },
  ])('rejects an undiscovered explicit model instead of probing another model: %j', async (payload) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/probe-now`,
      payload,
    });

    expect(response.json()).toEqual({ error: expect.stringContaining('claude-opus-5') });
    expect(response.statusCode).toBe(422);
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);
    expect(await db.select().from(schema.modelAvailability).all()).toEqual([
      expect.objectContaining({ accountId, modelName: 'deepseek-v4-flash', available: true }),
    ]);
  });

  it('treats an explicit modelName without scope as single even when the site default is all', async () => {
    await db.update(schema.sites).set({ postRefreshProbeScope: 'all' })
      .where(eq(schema.sites.id, siteId)).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/probe-now`,
      payload: { modelName: 'claude-opus-5' },
    });

    expect(response.json()).toEqual({ error: expect.stringContaining('claude-opus-5') });
    expect(response.statusCode).toBe(422);
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('rejects an empty explicit single-model name: %j', async (modelName) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/probe-now`,
      payload: { scope: 'single', modelName },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: expect.stringContaining('modelName') });
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
  });

  it.each([
    { scope: 'single', modelName: 'claude-opus-5' },
    { scope: 'single', modelName: '  CLAUDE-OPUS-5  ' },
    { modelName: 'claude-opus-5' },
  ])('probes a matching explicit model instead of the configured default: %j', async (payload) => {
    await db.insert(schema.modelAvailability).values({
      accountId, modelName: 'claude-opus-5', available: true,
    }).run();
    await db.update(schema.sites).set({ postRefreshProbeScope: 'all' })
      .where(eq(schema.sites.id, siteId)).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/probe-now`,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      scope: 'single',
      probed: 1,
      unsupported: 0,
      details: [{ modelName: 'claude-opus-5', status: 'supported' }],
    });
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect(probeRuntimeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'claude-opus-5',
    }));
  });

  it.each(['claude-opus-5', 'missing-configured-model', ''])('keeps default single-model selection when modelName is omitted: %j', async (configuredModel) => {
    await db.insert(schema.modelAvailability).values({
      accountId, modelName: 'claude-opus-5', available: true,
    }).run();
    await db.update(schema.sites).set({ postRefreshProbeModel: configuredModel })
      .where(eq(schema.sites.id, siteId)).run();
    const available = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, accountId)).all();
    const expectedModel = configuredModel === 'claude-opus-5' ? configuredModel : available[0].modelName;

    const response = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/probe-now`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true, scope: 'single', probed: 1,
      details: [{ modelName: expectedModel, status: 'supported' }],
    });
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect(probeRuntimeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      modelName: expectedModel,
    }));
  });

  it.each([
    { scope: 'all', modelName: 'missing-requested-model' },
    { scope: 'all', modelName: '' },
    {},
  ])('keeps all-model selection for an explicit or configured all scope: %j', async (payload) => {
    await db.insert(schema.modelAvailability).values({
      accountId, modelName: 'claude-opus-5', available: true,
    }).run();
    await db.update(schema.sites).set({ postRefreshProbeScope: 'all' })
      .where(eq(schema.sites.id, siteId)).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/sites/${siteId}/probe-now`,
      payload,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result).toMatchObject({ success: true, scope: 'all', probed: 2, unsupported: 0 });
    expect(result.details.map((detail: { modelName: string }) => detail.modelName).sort()).toEqual([
      'claude-opus-5', 'deepseek-v4-flash',
    ]);
    expect(probeRuntimeModelMock.mock.calls.map(([input]) => input.modelName).sort()).toEqual([
      'claude-opus-5', 'deepseek-v4-flash',
    ]);
  });
});
