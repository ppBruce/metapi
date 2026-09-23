import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const undiciFetchMock = vi.fn();

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: (...args: unknown[]) => undiciFetchMock(...args) };
});

const {
  probeClaudeQuota,
  probeGeminiCliQuota,
  probeAntigravityQuota,
  probeGithubCopilotQuota,
  probeQoderQuota,
  probeKimiQuota,
  PROVIDER_QUOTA_PROBES,
} = await import('./providerQuotaProbes.js');

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const SYNCED_AT = '2026-09-22T06:00:00.000Z';

describe('provider quota probes', () => {
  beforeEach(() => {
    undiciFetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('covers exactly the providers wired into refreshOauthQuotaSnapshot', () => {
    expect([...PROVIDER_QUOTA_PROBES].sort()).toEqual([
      'antigravity', 'claude', 'gemini-cli', 'github', 'kimi', 'qoder',
    ]);
  });

  it('parses claude oauth usage windows into used-percent snapshots', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({
      five_hour: { utilization: 87.5, resets_at: '2026-09-22T09:00:00.000Z' },
      seven_day: { utilization: 42, resets_at: '2026-09-25T00:00:00.000Z' },
      seven_day_sonnet: { utilization: 91, resets_at: '2026-09-25T00:00:00.000Z' },
      extra_usage: { used_credits: 12.5, monthly_limit: 50 },
    }));

    const snapshot = await probeClaudeQuota({
      accessToken: 'claude-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('supported');
    expect(snapshot?.windows.fiveHour).toMatchObject({ supported: true, used: 87.5, limit: 100 });
    expect(snapshot?.windows.sevenDay).toMatchObject({ supported: true, used: 42, limit: 100 });
    expect(snapshot?.windows.fiveHour.remaining).toBeCloseTo(12.5);
    expect(snapshot?.lastSyncAt).toBe(SYNCED_AT);
    // Model-specific weekly windows and extra usage become extra rows.
    expect(snapshot?.entries?.map((entry) => entry.label)).toContain('7d sonnet');
    expect(snapshot?.entries?.find((entry) => entry.key === 'extra_usage')).toMatchObject({
      kind: 'credits',
      used: 12.5,
      limit: 50,
      remaining: 37.5,
    });

    const [, init] = undiciFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('reports claude rate limiting instead of pretending the quota is absent', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429));

    const snapshot = await probeClaudeQuota({
      accessToken: 'claude-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('unsupported');
    expect(snapshot?.providerMessage).toContain('429');
  });

  it('returns null for claude responses without utilisation fields', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({ unrelated: true }));

    const snapshot = await probeClaudeQuota({
      accessToken: 'claude-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot).toBeNull();
  });

  it('parses gemini-cli per-model buckets', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({
      buckets: [
        { modelId: 'gemini-3-pro-preview', remainingFraction: 0.25, resetTime: '2026-09-22T10:00:00.000Z' },
        { modelId: 'gemini-3-flash-preview', remainingFraction: 1 },
        { modelId: 'no-fraction-model' },
      ],
    }));

    const snapshot = await probeGeminiCliQuota({
      accessToken: 'gemini-token',
      projectId: 'cloud-project-1',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('supported');
    expect(snapshot?.entries).toHaveLength(2);
    expect(snapshot?.entries?.[0]).toMatchObject({
      key: 'gemini-3-pro-preview',
      kind: 'bucket',
      used: 75,
      limit: 100,
      remaining: 25,
    });
    expect(snapshot?.entries?.[1]).toMatchObject({ remainingPercent: 100, used: 0 });

    const [url, init] = undiciFetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('retrieveUserQuota');
    expect(JSON.parse(init.body)).toEqual({ project: 'cloud-project-1' });
  });

  it('reports a missing gemini-cli project id without calling upstream', async () => {
    const snapshot = await probeGeminiCliQuota({
      accessToken: 'gemini-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('unsupported');
    expect(snapshot?.providerMessage).toContain('projectId');
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('parses antigravity per-model quota after resolving the project', async () => {
    undiciFetchMock
      .mockResolvedValueOnce(jsonResponse({
        cloudaicompanionProject: 'ag-project-9',
        currentTier: { name: 'Pro' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        models: {
          'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash', quotaInfo: { remainingFraction: 0.4 } },
          'unlisted-model': { quotaInfo: { remainingFraction: 0.1 } },
          'gemini-pro-agent': { isInternal: true, quotaInfo: { remainingFraction: 0.2 } },
        },
      }));

    const snapshot = await probeAntigravityQuota({
      accessToken: 'ag-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('supported');
    expect(snapshot?.subscription?.planType).toBe('Pro');
    expect(snapshot?.entries).toHaveLength(1);
    expect(snapshot?.entries?.[0]).toMatchObject({
      key: 'gemini-3-flash-agent',
      label: 'Gemini 3.5 Flash',
      remainingPercent: 40,
      used: 60,
    });

    const [, quotaInit] = undiciFetchMock.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(quotaInit.body)).toEqual({ project: 'ag-project-9' });
  });

  it('surfaces antigravity auth failures as unsupported rather than inventing quota', async () => {
    undiciFetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 403));

    const snapshot = await probeAntigravityQuota({
      accessToken: 'ag-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('unsupported');
    expect(snapshot?.providerMessage).toContain('拒绝访问');
  });

  it('parses github copilot paid quota snapshots', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({
      copilot_plan: 'copilot_pro',
      quota_reset_date: '2026-10-01T00:00:00.000Z',
      quota_snapshots: {
        chat: { entitlement: 100, remaining: 60 },
        completions: { entitlement: 200, remaining: 200 },
        premium_interactions: { entitlement: 50, remaining: 0 },
      },
    }));

    const snapshot = await probeGithubCopilotQuota({
      accessToken: 'github-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('supported');
    expect(snapshot?.subscription?.planType).toBe('copilot_pro');
    expect(snapshot?.entries).toHaveLength(3);
    expect(snapshot?.entries?.find((entry) => entry.key === 'chat')).toMatchObject({
      used: 40,
      limit: 100,
      remaining: 60,
      resetAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('parses github copilot limited-plan monthly quotas', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({
      copilot_plan: 'free',
      limited_user_reset_date: '2026-10-01T00:00:00.000Z',
      monthly_quotas: { chat: 50, completions: 2000 },
      limited_user_quotas: { chat: 10, completions: 500 },
    }));

    const snapshot = await probeGithubCopilotQuota({
      accessToken: 'github-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.entries?.find((entry) => entry.key === 'completions')).toMatchObject({
      used: 500,
      limit: 2000,
      remaining: 1500,
      remainingPercent: 75,
    });
  });

  it('parses qoder credit pools', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({
      expiresAt: 1790000000000,
      userQuota: { total: 1000, used: 250, remaining: 750, unit: 'credits' },
      orgResourcePackage: { total: 5000, used: 1000, remaining: 4000, unit: 'credits' },
      totalUsagePercentage: 25,
    }));

    const snapshot = await probeQoderQuota({
      accessToken: 'qoder-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('supported');
    expect(snapshot?.entries).toHaveLength(2);
    expect(snapshot?.entries?.[0]).toMatchObject({
      key: 'user',
      kind: 'credits',
      used: 250,
      limit: 1000,
      remaining: 750,
    });
    expect(snapshot?.entries?.[1]?.label).toBe('组织额度');
    expect(snapshot?.entries?.[0]?.resetAt).toBe(new Date(1790000000000).toISOString());
  });

  it('parses kimi coding usage/limits into a weekly window plus rows', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({
      usage: { limit: 100, used: 96, resetTime: '2026-09-25T00:00:00.000Z' },
      limits: [
        { window: { duration: 5, timeUnit: 'HOUR' }, detail: { limit: 1000, remaining: 250 } },
        { window: { duration: 300, timeUnit: 'MINUTE' }, detail: { limit: 1000, used: 100 } },
      ],
    }));

    const snapshot = await probeKimiQuota({
      accessToken: 'kimi-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('supported');
    // 96/100 -> 96% weekly window.
    expect(snapshot?.windows.sevenDay).toMatchObject({ supported: true, used: 96, limit: 100, remaining: 4 });
    expect(snapshot?.entries?.find((entry) => entry.key === 'summary')).toMatchObject({
      kind: 'window',
      used: 96,
      limit: 100,
    });
    expect(snapshot?.entries?.find((entry) => entry.label === '5h 窗口')).toMatchObject({
      kind: 'bucket',
      used: 750,
      limit: 1000,
    });
    expect(snapshot?.entries?.find((entry) => entry.label === '5h 窗口')?.resetAt).toBeUndefined();
  });

  it('parses the kimi data[] shape with a model_name=all summary', async () => {
    undiciFetchMock.mockResolvedValue(jsonResponse({
      data: [
        { model_name: 'all', limit: 5000, used: 3200, resetTime: 1790000000 },
        { model_name: 'kimi-k2.7-code', limit: 1200, used: 300 },
      ],
    }));

    const snapshot = await probeKimiQuota({
      accessToken: 'kimi-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(snapshot?.status).toBe('supported');
    // 3200/5000 -> 64%.
    expect(snapshot?.windows.sevenDay).toMatchObject({ supported: true, used: 64, limit: 100 });
    expect(snapshot?.entries?.[0]).toMatchObject({ key: 'summary', label: '周额度', kind: 'window' });
    expect(snapshot?.entries?.find((entry) => entry.key === 'model:kimi-k2.7-code')).toMatchObject({
      kind: 'bucket',
      used: 300,
      limit: 1200,
      remaining: 900,
    });
    expect(snapshot?.entries?.[0]?.resetAt).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it('falls back to /usage when /usages returns 404', async () => {
    undiciFetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ usage: { limit: 100, used: 10 } }));

    const snapshot = await probeKimiQuota({
      accessToken: 'kimi-token',
      proxyUrl: null,
      syncedAt: SYNCED_AT,
    });

    expect(undiciFetchMock).toHaveBeenCalledTimes(2);
    expect(String(undiciFetchMock.mock.calls[0]?.[0])).toContain('/usages');
    expect(String(undiciFetchMock.mock.calls[1]?.[0])).toContain('/usage');
    expect(snapshot?.status).toBe('supported');
  });

  it('never calls upstream without an access token', async () => {
    for (const probe of [
      probeClaudeQuota,
      probeAntigravityQuota,
      probeGithubCopilotQuota,
      probeQoderQuota,
      probeKimiQuota,
    ]) {
      const snapshot = await probe({ accessToken: '  ', proxyUrl: null, syncedAt: SYNCED_AT });
      expect(snapshot).toBeNull();
    }
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });
});
