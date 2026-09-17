import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const probeRuntimeModelMock = vi.fn();

vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type RecoveryModule = typeof import('./channelRecoveryProbeService.js');
type CoordinatorModule = typeof import('./proxyChannelCoordinator.js');
type ConfigModule = typeof import('../config.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('channelRecoveryProbeService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let runChannelProbeSweep: RecoveryModule['runChannelProbeSweep'];
  let resetChannelProbeState: RecoveryModule['resetChannelProbeState'];
  let proxyChannelCoordinator: CoordinatorModule['proxyChannelCoordinator'];
  let resetProxyChannelCoordinatorState: CoordinatorModule['resetProxyChannelCoordinatorState'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalDataDir: string | undefined;
  let originalConcurrencyLimit = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channel-recovery-probe-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const recoveryModule = await import('./channelRecoveryProbeService.js');
    const coordinatorModule = await import('./proxyChannelCoordinator.js');
    const configModule = await import('../config.js');
    const tokenRouterModule = await import('./tokenRouter.js');

    db = dbModule.db;
    schema = dbModule.schema;
    runChannelProbeSweep = recoveryModule.runChannelProbeSweep;
    resetChannelProbeState = recoveryModule.resetChannelProbeState;
    proxyChannelCoordinator = coordinatorModule.proxyChannelCoordinator;
    resetProxyChannelCoordinatorState = coordinatorModule.resetProxyChannelCoordinatorState;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    config = configModule.config;
    originalConcurrencyLimit = config.proxySessionChannelConcurrencyLimit;
  });

  beforeEach(async () => {
    probeRuntimeModelMock.mockReset();
    probeRuntimeModelMock.mockResolvedValue({
      status: 'supported',
      latencyMs: 320,
      reason: 'probe succeeded',
    });
    config.proxySessionChannelConcurrencyLimit = 1;
    resetChannelProbeState();
    resetProxyChannelCoordinatorState();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.proxySessionChannelConcurrencyLimit = originalConcurrencyLimit;
    resetChannelProbeState();
    resetProxyChannelCoordinatorState();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  it('clears cooldown markers when a background probe succeeds', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'recovery-site',
      url: 'https://recovery-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'recovery-user',
      accessToken: 'access-recovery',
      apiToken: 'sk-recovery',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-recovery-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      lastFailAt: new Date().toISOString(),
      consecutiveFailCount: 2,
      cooldownLevel: 1,
    }).returning().get();

    await runChannelProbeSweep();

    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect(probeRuntimeModelMock.mock.calls[0]?.[0]).toMatchObject({
      modelName: 'gpt-5.4',
      tokenValue: 'sk-recovery-token',
    });

    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(refreshed?.cooldownUntil).toBeNull();
    expect(refreshed?.lastFailAt).toBeNull();
    expect(refreshed?.consecutiveFailCount).toBe(0);
    expect(refreshed?.cooldownLevel).toBe(0);
  });

  it('also probes active leased channels in the background', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'active-site',
      url: 'https://active-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'active-user',
      accessToken: 'access-active',
      apiToken: 'sk-active',
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
      }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-active-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.2',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
    }).returning().get();

    const lease = await proxyChannelCoordinator.acquireChannelLease({
      channelId: channel.id,
      accountExtraConfig: account.extraConfig,
    });
    expect(lease.status).toBe('acquired');
    if (lease.status !== 'acquired') return;

    await runChannelProbeSweep();

    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect(probeRuntimeModelMock.mock.calls[0]?.[0]).toMatchObject({
      modelName: 'gpt-5.2',
      tokenValue: 'sk-active-token',
    });

    lease.lease.release();
  });

  it('skips provider-directed quota cooldown channels during recovery sweeps', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'quota-site',
      url: 'https://quota-site.example.com',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'quota-user',
      accessToken: 'access-quota',
      apiToken: 'sk-quota',
      status: 'active',
    }).returning().get();

    const quotaToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'quota-token',
      token: 'sk-quota-token',
      enabled: true,
      isDefault: false,
    }).returning().get();

    const retryToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'retry-token',
      token: 'sk-retry-token',
      enabled: true,
      isDefault: false,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: route.id,
        accountId: account.id,
        tokenId: quotaToken.id,
        enabled: true,
        cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        lastFailAt: new Date().toISOString(),
        failCount: 0,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      },
      {
        routeId: route.id,
        accountId: account.id,
        tokenId: retryToken.id,
        enabled: true,
        cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        lastFailAt: new Date().toISOString(),
        failCount: 2,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      },
    ]).run();

    await runChannelProbeSweep();

    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect(probeRuntimeModelMock.mock.calls[0]?.[0]).toMatchObject({
      tokenValue: 'sk-retry-token',
      modelName: 'gpt-5.4',
    });
  });

  it('backs off probe frequency for channels with consecutive failures', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'backoff-site',
      url: 'https://backoff-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'backoff-user',
      accessToken: 'access-backoff',
      apiToken: 'sk-backoff',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: '«redacted:sk-…»',
      enabled: true,
      isDefault: true,
    }).returning().get();

    // Channel A: 0 consecutive failures (base interval)
    const routeA = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-a',
      enabled: true,
    }).returning().get();
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: routeA.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      lastFailAt: new Date().toISOString(),
      consecutiveFailCount: 0,
    }).run();

    // Channel B: 2 consecutive failures (7.5x backoff)
    const routeB = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-b',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: routeB.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      lastFailAt: new Date().toISOString(),
      consecutiveFailCount: 2,
    }).run();

    // First sweep: one channel is probed (concurrency = 1).
    await runChannelProbeSweep();
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);

    // Advance past the base interval but NOT past the 7.5x backoff (2 fails).
    // Run multiple sweeps: channel A (0 fails, base interval) should eventually
    // be probed again, but channel B (2 fails, 7.5x = 15min) should NEVER be probed
    // within this window. Keep sweeping and collect all probed model names.
    const baseIntervalMs = 2 * 60 * 1000; // PROBE_SWEEP_INTERVAL_MS default
    const probedModels: string[] = [];
    for (let i = 1; i <= 5; i++) {
      probeRuntimeModelMock.mockClear();
      await runChannelProbeSweep(Date.now() + baseIntervalMs * i + 1000 * i);
      probedModels.push(...probeRuntimeModelMock.mock.calls.map((c) => c[0]?.modelName));
    }
    // Channel B (2 consecutive failures) must never be probed within 5x base interval
    // (well under the 7.5x backoff threshold).
    expect(probedModels).not.toContain('model-b');
  });

  it('prioritizes never-probed active channels before reprobing recently started ones', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'priority-site',
      url: 'https://priority-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const leases: Array<{ release: () => void }> = [];
    try {
      for (let index = 1; index <= 5; index += 1) {
        const account = await db.insert(schema.accounts).values({
          siteId: site.id,
          username: `priority-user-${index}`,
          accessToken: `access-priority-${index}`,
          apiToken: `sk-priority-${index}`,
          status: 'active',
          extraConfig: JSON.stringify({
            credentialMode: 'session',
          }),
        }).returning().get();

        const token = await db.insert(schema.accountTokens).values({
          accountId: account.id,
          name: `token-${index}`,
          token: `sk-priority-token-${index}`,
          enabled: true,
          isDefault: true,
        }).returning().get();

        const route = await db.insert(schema.tokenRoutes).values({
          modelPattern: `gpt-5.4-${index}`,
          enabled: true,
        }).returning().get();

        const channel = await db.insert(schema.routeChannels).values({
          routeId: route.id,
          accountId: account.id,
          tokenId: token.id,
          enabled: true,
        }).returning().get();

        const lease = await proxyChannelCoordinator.acquireChannelLease({
          channelId: channel.id,
          accountExtraConfig: account.extraConfig,
        });
        expect(lease.status).toBe('acquired');
        if (lease.status === 'acquired') {
          leases.push(lease.lease);
        }
      }

      const startedAt = Date.UTC(2026, 3, 1, 0, 0, 0);
      await runChannelProbeSweep(startedAt);

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(4);
      expect(probeRuntimeModelMock.mock.calls.map((call) => call[0]?.tokenValue)).not.toContain('sk-priority-token-5');

      probeRuntimeModelMock.mockClear();

      await runChannelProbeSweep(startedAt + 5 * 60 * 1000);

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(4);
      const secondSweepTokens = probeRuntimeModelMock.mock.calls.map((call) => call[0]?.tokenValue);
      expect(secondSweepTokens).toContain('sk-priority-token-5');
    } finally {
      for (const lease of leases) {
        lease.release();
      }
    }
  });

  it('does not count inconclusive recovery probes (request never reached the model) as channel failures', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'inconclusive-site',
      url: 'https://inconclusive-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'inconclusive-user',
      accessToken: 'access-inconclusive',
      apiToken: 'sk-inconclusive',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'token-inconclusive',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-inconclusive',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      lastFailAt: new Date().toISOString(),
      consecutiveFailCount: 1,
      cooldownLevel: 0,
    }).returning().get();

    probeRuntimeModelMock.mockResolvedValue({
      status: 'inconclusive',
      latencyMs: 30_000,
      reason: 'runtime model probe candidate resolution timeout (30s)',
    });

    await runChannelProbeSweep();

    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);

    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    // Inconclusive now takes the probe-failure path: the probe could not prove
    // the model works, so consecutiveFailCount grows (1 -> 2) and the cooldown
    // is extended with jittered exponential backoff. failCount stays untouched
    // (inconclusive is not proof the model is gone), and cooldownLevel stays 0.
    expect(refreshed?.consecutiveFailCount).toBe(2);
    expect(refreshed?.failCount).toBe(0);
    expect(refreshed?.cooldownLevel).toBe(0);
    expect(refreshed?.cooldownUntil).not.toBeNull();
    expect(new Date(refreshed?.cooldownUntil as string).getTime())
      .toBeGreaterThan(Date.now());
  });

  it('still counts unsupported recovery probes (upstream refused the model) as channel failures', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'unsupported-site',
      url: 'https://unsupported-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'unsupported-user',
      accessToken: 'access-unsupported',
      apiToken: 'sk-unsupported',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'token-unsupported',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-unsupported',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      lastFailAt: new Date().toISOString(),
      consecutiveFailCount: 1,
      cooldownLevel: 0,
    }).returning().get();

    probeRuntimeModelMock.mockResolvedValue({
      status: 'unsupported',
      latencyMs: 1_500,
      reason: 'Upstream returned HTTP 400: model not found',
    });

    await runChannelProbeSweep();

    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);

    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    // Unsupported = upstream gave a definitive negative answer, so the probe
    // streak (consecutiveFailCount) must advance and lastFailAt refresh.
    // failCount stays untouched: it drives the fibonacci backoff of REAL
    // traffic failures, and probe attempts must not inflate that counter.
    expect(refreshed?.consecutiveFailCount).toBeGreaterThan(1);
    expect(refreshed?.lastFailAt).not.toBeNull();
  });

  it('decays probe frequency on repeated failures but keeps probing forever', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'decay-site',
      url: 'https://decay-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'decay-user',
      accessToken: 'access-decay',
      apiToken: 'sk-decay',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'token-decay',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-decay',
      enabled: true,
    }).returning().get();

    const baseIntervalMs = 2 * 60 * 1000;
    const t0 = Date.UTC(2026, 3, 1, 0, 0, 0);
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(t0 + 6 * 60 * 60 * 1000).toISOString(),
      lastFailAt: new Date(t0 - 60 * 1000).toISOString(),
      failCount: 2,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).run();

    // Upstream never answers: every probe is inconclusive.
    probeRuntimeModelMock.mockResolvedValue({
      status: 'inconclusive',
      latencyMs: 30_000,
      reason: 'runtime model probe timeout (30s)',
    });

    // Pin Math.random → 0.5 so jitter factor is exactly 1.0 (deterministic).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // Drive the real scheduler cadence: sweep every 2min, collect probe times.
    const probeTimesMinutes: number[] = [];
    for (let sweep = 0; sweep < 90; sweep += 1) {
      probeRuntimeModelMock.mockClear();
      await runChannelProbeSweep(t0 + sweep * baseIntervalMs);
      if (probeRuntimeModelMock.mock.calls.length > 0) {
        probeTimesMinutes.push(sweep);
      }
    }

    randomSpy.mockRestore();

    // 首轮就探测一次。
    expect(probeTimesMinutes[0]).toBe(0);
    // 指数退避（以 sweep=2min 为单位）：2 → 4 → 8 → 16 → 30（60min 封顶）。
    const gaps = probeTimesMinutes.slice(1).map((t, i) => t - probeTimesMinutes[i]);
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    }
    expect(gaps[0]).toBe(2);   // 4min
    expect(gaps[1]).toBe(4);   // 8min
    expect(gaps[2]).toBe(8);   // 16min
    expect(gaps[3]).toBe(16);  // 32min
    expect(gaps[4]).toBe(30);  // 60min 封顶，之后恒定
    // 永不停止：90 轮(180min)内多次探测，且最后一次接近窗口末端。
    expect(probeTimesMinutes.length).toBeGreaterThanOrEqual(5);
    expect(probeTimesMinutes[probeTimesMinutes.length - 1]).toBeGreaterThanOrEqual(60);
  });

  it('resets the probe backoff after a successful probe', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'reset-site',
      url: 'https://reset-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'reset-user',
      accessToken: 'access-reset',
      apiToken: 'sk-reset',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'token-reset',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-reset',
      enabled: true,
    }).returning().get();

    const baseIntervalMs = 2 * 60 * 1000;
    const t0 = Date.UTC(2026, 4, 1, 0, 0, 0);
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(t0 + 6 * 60 * 60 * 1000).toISOString(),
      lastFailAt: new Date(t0 - 60 * 1000).toISOString(),
      failCount: 2,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).returning().get();

    // Pin Math.random → jitter factor 1.0 for deterministic timing.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // Two failed probes accumulate consecutiveFailCount 1 then 2.
    probeRuntimeModelMock.mockResolvedValue({ status: 'inconclusive', latencyMs: 30_000, reason: 'timeout' });
    await runChannelProbeSweep(t0);                     // cfc 0 -> 1
    await runChannelProbeSweep(t0 + baseIntervalMs * 2); // cfc 1 -> 2 (4min backoff, due)

    // After the two failures failCount must be untouched (inconclusive) and
    // consecutiveFailCount must have grown to 2.
    const afterFails = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(afterFails?.failCount).toBe(2);
    expect(afterFails?.consecutiveFailCount).toBe(2);

    // Upstream recovers: the next due probe succeeds and clears the streak.
    probeRuntimeModelMock.mockResolvedValue({ status: 'supported', latencyMs: 420, reason: 'probe succeeded' });
    probeRuntimeModelMock.mockClear();
    await runChannelProbeSweep(t0 + baseIntervalMs * 6);
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);

    // Success must fully reset the backoff counters and clear the cooldown,
    // returning the channel to the healthy (non-cooling) pool.
    const refreshed = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(refreshed?.consecutiveFailCount).toBe(0);
    expect(refreshed?.cooldownUntil).toBeNull();
    expect(refreshed?.lastFailAt).toBeNull();

    randomSpy.mockRestore();
  });

  it('takes a quota-exhausted channel out of the probe pool instead of retrying forever', async () => {
    // 上游余额耗尽只能靠充值/人工解除：探测不会让它恢复。第一次探测确认后，
    // 渠道必须被写成 provider 主动冷却并退出探测池，而不是一轮轮空打。
    const site = await db.insert(schema.sites).values({
      name: 'quota-site',
      url: 'https://quota-site.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'quota-user',
      accessToken: 'access-quota',
      apiToken: 'sk-quota',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'token-quota',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-quota',
      enabled: true,
    }).returning().get();

    const baseIntervalMs = 2 * 60 * 1000;
    const t0 = Date.UTC(2026, 3, 2, 0, 0, 0);
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
      cooldownUntil: new Date(t0 + 6 * 60 * 60 * 1000).toISOString(),
      lastFailAt: new Date(t0 - 60 * 1000).toISOString(),
      failCount: 2,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).returning().get();

    probeRuntimeModelMock.mockResolvedValue({
      status: 'unsupported',
      latencyMs: 300,
      reason: '{"error":{"message":"Insufficient Balance","type":"unknown_error","code":"invalid_request_error"}}',
    });

    await runChannelProbeSweep(t0);
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);

    // 探测确认后：计数清零 + 固定长冷却（provider 主动冷却形态）。
    const afterProbe = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(afterProbe?.failCount).toBe(0);
    expect(afterProbe?.consecutiveFailCount).toBe(0);
    expect(afterProbe?.cooldownLevel).toBe(0);
    const cooldownUntilMs = Date.parse(String(afterProbe?.cooldownUntil));
    expect(cooldownUntilMs).toBeGreaterThanOrEqual(t0 + 30 * 60 * 1000);

    // 之后的 sweep 不再探测它（provider 主动冷却不进探测池）。
    probeRuntimeModelMock.mockClear();
    await runChannelProbeSweep(t0 + baseIntervalMs * 10);
    await runChannelProbeSweep(t0 + baseIntervalMs * 60);
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(0);
  });

  it('restores the probe rhythm from probe_logs after a restart instead of re-probing everything', async () => {
    // 重启后内存计时器清空。若不做回填，所有冷却渠道都会被当成「从未探测过」
    // 而立刻补探一轮；用 probe_logs 回填后，刚探过的渠道要等自己的退避窗口
    // 过去才会再探。
    const site = await db.insert(schema.sites).values({
      name: 'seed-site',
      url: 'https://seed-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'seed-user',
      accessToken: 'access-seed',
      apiToken: 'sk-seed',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'token-seed',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'model-seed',
      enabled: true,
    }).returning().get();

    const t0 = Date.UTC(2026, 3, 3, 0, 0, 0);
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: 'model-seed',
      enabled: true,
      cooldownUntil: new Date(t0 + 6 * 60 * 60 * 1000).toISOString(),
      lastFailAt: new Date(t0 - 60 * 1000).toISOString(),
      failCount: 2,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).run();

    // 该渠道 1 分钟前刚被探过（probe_logs 里的真实记录）。
    await db.insert(schema.probeLogs).values({
      siteId: site.id,
      accountId: account.id,
      modelName: 'model-seed',
      questionCategory: 'math',
      questionText: 'probe question',
      status: 'failed',
      latencyMs: 300,
      errorMessage: 'probe failed with status 0',
      createdAt: '2026-04-02 23:59:00',
    }).run();

    // 固定抖动因子，让退避窗口可精确断言。
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // 重启后首轮 sweep：1 分钟前刚探过，基准退避 2 分钟未到 → 不补探。
    await runChannelProbeSweep(t0);
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(0);

    // 退避窗口过去后恢复正常探测。
    await runChannelProbeSweep(t0 + 2 * 60 * 1000 + 1);
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
  });
});
